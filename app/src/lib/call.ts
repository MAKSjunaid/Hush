import { useSyncExternalStore } from 'react';
import { emitCall, peerById, getState, type User } from './store';
import { VoiceCall, callSupported } from './webrtc';

export type CallStatus = 'idle' | 'outgoing' | 'incoming' | 'connecting' | 'active' | 'ended';
export type CallState = {
  status: CallStatus;
  peer: User | null;
  muted: boolean;
  speaker: boolean;
  startedAt: number | null; // ms, when the call connected (for the timer)
  endedReason: string | null; // what to show on the "ended" flash
};

let state: CallState = { status: 'idle', peer: null, muted: false, speaker: false, startedAt: null, endedReason: null };
const listeners = new Set<() => void>();
function set(patch: Partial<CallState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}
export function useCall<T>(selector: (s: CallState) => T): T {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => listeners.delete(l); },
    () => selector(state),
    () => selector(state),
  );
}

// --- internals ---
let voice: VoiceCall | null = null;
let callId: string | null = null;
let peerId: string | null = null;
let pendingOffer: string | null = null; // incoming offer sdp, applied on accept
let iceBuffer: string[] = [];
let ringTimeout: any = null;
let remoteAudio: HTMLAudioElement | null = null;
let wakeLock: any = null;
let audioCtx: AudioContext | null = null;
let gainNode: GainNode | null = null;
let srcNode: MediaStreamAudioSourceNode | null = null;
const CALL_GAIN = 3.2; // very loud by default — the <audio> element caps at 1.0, Web Audio lifts past it

const newId = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

async function acquireWake() {
  try {
    if (typeof navigator !== 'undefined' && (navigator as any).wakeLock) {
      wakeLock = await (navigator as any).wakeLock.request('screen');
    }
  } catch {}
}
function releaseWake() {
  try { wakeLock?.release?.(); } catch {}
  wakeLock = null;
}
// Wake locks drop when the tab is hidden; re-acquire when it comes back while a call is live.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && (state.status === 'active' || state.status === 'connecting' || state.status === 'outgoing')) acquireWake();
  });
}

function playRemote(stream: MediaStream) {
  if (typeof document === 'undefined') return;
  if (!remoteAudio) {
    remoteAudio = document.createElement('audio');
    remoteAudio.autoplay = true;
    (remoteAudio as any).playsInline = true;
    document.body.appendChild(remoteAudio);
  }
  remoteAudio.srcObject = stream;
  remoteAudio.volume = 1;
  remoteAudio.play?.().catch(() => {});
  // Lift the volume well past the element's 1.0 ceiling with a Web Audio gain stage.
  try {
    const AC = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (AC) {
      if (!audioCtx) audioCtx = new AC();
      audioCtx!.resume?.().catch(() => {});
      try { srcNode?.disconnect(); } catch {}
      try { gainNode?.disconnect(); } catch {}
      srcNode = audioCtx!.createMediaStreamSource(stream);
      gainNode = audioCtx!.createGain();
      gainNode.gain.value = CALL_GAIN;
      srcNode.connect(gainNode).connect(audioCtx!.destination);
      // The element still "pulls" the remote stream (a Chrome quirk) but stays silent so we don't double-play.
      remoteAudio.muted = true;
    }
  } catch {
    if (remoteAudio) remoteAudio.muted = false; // Web Audio unavailable → plain element at full volume.
  }
  applySpeaker();
}

function applySpeaker() {
  // Best effort: pick the audio output where the browser supports it (desktop Chrome). Mobile PWAs
  // route to the system default; the toggle is still tracked for UI.
  try {
    const el: any = remoteAudio;
    if (el && typeof el.setSinkId === 'function') el.setSinkId(state.speaker ? 'default' : 'default').catch(() => {});
  } catch {}
}

function cleanup() {
  if (ringTimeout) { clearTimeout(ringTimeout); ringTimeout = null; }
  releaseWake();
  try { voice?.close(); } catch {}
  voice = null;
  callId = null;
  peerId = null;
  pendingOffer = null;
  iceBuffer = [];
  if (remoteAudio) { try { remoteAudio.srcObject = null; remoteAudio.remove(); } catch {} remoteAudio = null; }
  try { srcNode?.disconnect(); } catch {}
  try { gainNode?.disconnect(); } catch {}
  try { audioCtx?.close(); } catch {}
  srcNode = null; gainNode = null; audioCtx = null;
}

function endCall(reason: string | null) {
  cleanup();
  set({ status: 'ended', endedReason: reason, startedAt: null });
  setTimeout(() => { if (state.status === 'ended') set({ status: 'idle', peer: null, endedReason: null, muted: false, speaker: false }); }, 1400);
}

function makeVoice(): VoiceCall {
  const ice = getState().config?.iceServers;
  const v = new VoiceCall(ice, {
    onIce: (candidate) => { if (peerId) emitCall('call:ice', { to: peerId, candidate, callId }); },
    onRemoteStream: (stream) => playRemote(stream),
    onState: (st) => {
      if (st === 'connected') {
        if (ringTimeout) { clearTimeout(ringTimeout); ringTimeout = null; }
        if (state.status !== 'active') set({ status: 'active', startedAt: Date.now() });
      } else if (st === 'failed') {
        endCall('failed');
      }
    },
  });
  for (const c of iceBuffer.splice(0)) v.addIce(c);
  return v;
}

// --- public actions ---
export async function placeCall(peer: User): Promise<void> {
  if (state.status !== 'idle') return;
  if (!callSupported()) { set({ status: 'ended', peer, endedReason: 'unsupported' }); setTimeout(() => set({ status: 'idle', peer: null, endedReason: null }), 1800); return; }
  peerId = peer.id;
  callId = newId();
  set({ status: 'outgoing', peer, muted: false, speaker: false, startedAt: null, endedReason: null });
  acquireWake();
  try {
    voice = makeVoice();
    await voice.startMic();
    const sdp = await voice.createOffer();
    const ack = await emitCall('call:offer', { to: peer.id, sdp, callId });
    if (ack?.error) { endCall(ack.error === 'offline' ? 'unavailable' : 'error'); return; }
    ringTimeout = setTimeout(() => { if (state.status === 'outgoing') { emitCall('call:hangup', { to: peerId, callId, reason: 'timeout' }); endCall('no-answer'); } }, 35000);
  } catch (e: any) {
    if (peerId) emitCall('call:hangup', { to: peerId, callId, reason: 'error' });
    endCall(e?.name === 'NotAllowedError' ? 'mic-denied' : 'error');
  }
}

export async function acceptCall(): Promise<void> {
  if (state.status !== 'incoming' || !pendingOffer) return;
  set({ status: 'connecting' });
  acquireWake();
  try {
    voice = makeVoice();
    await voice.startMic();
    const answer = await voice.acceptOffer(pendingOffer);
    pendingOffer = null;
    emitCall('call:answer', { to: peerId, sdp: answer, callId });
  } catch (e: any) {
    if (peerId) emitCall('call:hangup', { to: peerId, callId, reason: 'error' });
    endCall(e?.name === 'NotAllowedError' ? 'mic-denied' : 'error');
  }
}

export function declineCall(): void {
  if (peerId) emitCall('call:hangup', { to: peerId, callId, reason: 'decline' });
  endCall(null);
}

export function hangup(): void {
  if (peerId) emitCall('call:hangup', { to: peerId, callId, reason: 'end' });
  endCall(null);
}

export function toggleMute(): void {
  const muted = !state.muted;
  voice?.setMuted(muted);
  set({ muted });
}

export function toggleSpeaker(): void {
  set({ speaker: !state.speaker });
  applySpeaker();
}

// --- signaling handlers (called from the socket in store.ts) ---
export function onOffer(d: { from: string; sdp: string; callId: string }): void {
  if (state.status !== 'idle') { emitCall('call:hangup', { to: d.from, callId: d.callId, reason: 'busy' }); return; }
  peerId = d.from;
  callId = d.callId;
  pendingOffer = d.sdp;
  set({ status: 'incoming', peer: peerById(d.from) || { id: d.from, username: '', displayName: 'Incoming call', publicKey: null }, muted: false, speaker: false, startedAt: null, endedReason: null });
  ringTimeout = setTimeout(() => { if (state.status === 'incoming') { emitCall('call:hangup', { to: peerId, callId, reason: 'timeout' }); endCall(null); } }, 35000);
}

export async function onAnswer(d: { from: string; sdp: string; callId: string }): Promise<void> {
  if (!voice || d.callId !== callId) return;
  set({ status: 'connecting' });
  try { await voice.setAnswer(d.sdp); } catch { endCall('failed'); }
}

export function onIce(d: { from: string; candidate: string; callId: string }): void {
  if (d.callId !== callId) return;
  if (voice) voice.addIce(d.candidate);
  else iceBuffer.push(d.candidate); // arrived before we built the peer connection
}

export function onHangup(d: { from: string; callId: string; reason: string }): void {
  if (callId && d.callId !== callId) return;
  const reason = d.reason === 'decline' ? 'declined' : d.reason === 'busy' ? 'busy' : d.reason === 'timeout' ? 'missed' : null;
  endCall(reason);
}
