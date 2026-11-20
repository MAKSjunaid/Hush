import { useSyncExternalStore } from 'react';
import { emitCall, peerById, getState, type User } from './store';
import { VoiceCall, callSupported } from './webrtc';
import { nativeCall } from './nativecall';

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

// --- ringtone (plays while the call screen is open; a closed PWA can't ring continuously — that's a
// native-only ability) ---
let ringCtx: AudioContext | null = null;
let ringTimer: any = null;
function startRing(dir: 'in' | 'out') {
  stopRing();
  if (typeof window === 'undefined') return;
  try {
    const AC = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!AC) return;
    ringCtx = new AC();
    ringCtx!.resume?.().catch(() => {});
    const beep = () => {
      if (!ringCtx) return;
      const base = ringCtx.currentTime;
      const offsets = dir === 'in' ? [0, 0.4] : [0]; // incoming: double-ring; outgoing: single ringback
      for (const off of offsets) {
        const o = ringCtx.createOscillator();
        const g = ringCtx.createGain();
        o.type = 'sine';
        o.frequency.value = dir === 'in' ? 480 : 440;
        o.connect(g); g.connect(ringCtx.destination);
        const s = base + off;
        g.gain.setValueAtTime(0.0001, s);
        g.gain.exponentialRampToValueAtTime(0.32, s + 0.04);
        g.gain.setValueAtTime(0.32, s + 0.28);
        g.gain.exponentialRampToValueAtTime(0.0001, s + 0.34);
        o.start(s); o.stop(s + 0.4);
      }
    };
    beep();
    ringTimer = setInterval(beep, dir === 'in' ? 2400 : 3400);
  } catch {}
}
function stopRing() {
  if (ringTimer) { clearInterval(ringTimer); ringTimer = null; }
  try { ringCtx?.close(); } catch {}
  ringCtx = null;
}

// --- auto-accept: when the user taps "Accept" on a call notification, the app opens and should pick
// up the buffered call without a second tap. The service worker posts a message (open app) or we read
// ?accept=<callId> on cold start. ---
let autoAcceptId: string | null = null;
let autoAcceptUntil = 0;
export function armAutoAccept(id: string | null) { autoAcceptId = id || '*'; autoAcceptUntil = Date.now() + 25000; }
if (typeof window !== 'undefined') {
  try {
    const a = new URLSearchParams(window.location.search).get('accept');
    if (a) armAutoAccept(a);
  } catch {}
  try {
    (navigator as any)?.serviceWorker?.addEventListener?.('message', (e: any) => {
      if (e?.data?.hushAcceptCall) armAutoAccept(String(e.data.hushAcceptCall));
    });
  } catch {}
}

// Native call UI + background audio (CallKeep/InCallManager on phones; no-op on web). When the user
// answers or ends from the NATIVE screen (e.g. on the lock screen), route it back into our store.
nativeCall.setup({
  onAnswer: () => { if (state.status === 'incoming') acceptCall(); },
  onEnd: () => { if (state.status === 'incoming') declineCall(); else if (state.status !== 'idle') hangup(); },
});

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

// iPhone/iPad (incl. iPadOS reporting as Mac with touch). iOS Safari has two call-audio quirks we
// must handle: (1) a remote WebRTC stream routed through the Web Audio API is SILENT, and (2) audio
// playback must be unlocked from inside a user gesture.
const IS_IOS = typeof navigator !== 'undefined'
  && (/iP(hone|ad|od)/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && (navigator as any).maxTouchPoints > 1));

function ensureRemoteAudioEl(): HTMLAudioElement | null {
  if (typeof document === 'undefined') return null;
  if (!remoteAudio) {
    remoteAudio = document.createElement('audio');
    remoteAudio.autoplay = true;
    remoteAudio.setAttribute('playsinline', '');
    (remoteAudio as any).playsInline = true;
    document.body.appendChild(remoteAudio);
  }
  return remoteAudio;
}

// Called synchronously from the Call/Answer tap. Creates and unlocks the audio output inside the user
// gesture so the remote voice can actually play a moment later — without this, iPhone stays silent.
export function primeCallAudio(): void {
  const el = ensureRemoteAudioEl();
  if (!el) return;
  el.muted = false;
  el.volume = 1;
  if (IS_IOS) {
    // Do NOT create an AudioContext on iOS: WebKit flips into a "video conference" audio mode that
    // routes call audio to the quiet earpiece. Reset the audio session, then just unlock the element.
    try { const as = (navigator as any).audioSession; if (as) as.type = 'auto'; } catch {}
    try { el.play?.().catch(() => {}); } catch {}
    return;
  }
  try {
    const AC = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (AC) { if (!audioCtx) audioCtx = new AC(); audioCtx!.resume?.().catch(() => {}); }
  } catch {}
  try { el.play?.().catch(() => {}); } catch {}
}

// iOS routes WebRTC call audio to the earpiece once the mic is live. Toggling the audio-session type
// AFTER getUserMedia "kicks" WebKit into rerouting so the remote voice comes out of the main speaker.
export function kickIOSAudioRoute(): void {
  if (!IS_IOS) return;
  try { const as = (navigator as any).audioSession; if (as) as.type = 'play-and-record'; } catch {}
  try { remoteAudio?.play?.().catch(() => {}); } catch {}
}

function playRemote(stream: MediaStream) {
  const el = ensureRemoteAudioEl();
  if (!el) return;
  try { (el as any).srcObject = stream; } catch {}
  el.volume = 1;
  el.muted = false;
  el.play?.().catch(() => {});
  // On iOS, play the <audio> element directly (no Web Audio gain stage) — Web Audio is silent there,
  // and re-kick the audio route so the remote voice comes out of the speaker, not the earpiece.
  if (IS_IOS) { kickIOSAudioRoute(); applySpeaker(); return; }
  // Elsewhere, lift the volume well past the element's 1.0 ceiling with a Web Audio gain stage.
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
      el.muted = true;
    }
  } catch {
    el.muted = false; // Web Audio unavailable → plain element at full volume.
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
  stopRing();
  nativeCall.ended(callId);
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
        nativeCall.connected(callId);
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
  primeCallAudio(); // unlock audio output inside the tap gesture (needed on iOS)
  peerId = peer.id;
  callId = newId();
  set({ status: 'outgoing', peer, muted: false, speaker: false, startedAt: null, endedReason: null });
  acquireWake();
  startRing('out');
  nativeCall.outgoing(callId, peer.displayName || peer.username || 'Call');
  try {
    voice = makeVoice();
    await voice.startMic();
    kickIOSAudioRoute(); // route call audio to the speaker on iOS (not the earpiece)
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
  stopRing();
  primeCallAudio(); // unlock audio output inside the answer-tap gesture (needed on iOS)
  nativeCall.connected(callId);
  set({ status: 'connecting' });
  acquireWake();
  try {
    voice = makeVoice();
    await voice.startMic();
    kickIOSAudioRoute(); // route call audio to the speaker on iOS (not the earpiece)
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
  nativeCall.setMuted(callId, muted);
  set({ muted });
}

export function toggleSpeaker(): void {
  const on = !state.speaker;
  set({ speaker: on });
  applySpeaker();
  nativeCall.setSpeaker(on);
}

// --- signaling handlers (called from the socket in store.ts) ---
export function onOffer(d: { from: string; sdp: string; callId: string; name?: string }): void {
  const busy = state.status === 'incoming' || state.status === 'connecting' || state.status === 'active' || state.status === 'outgoing';
  // The server re-delivers the buffered offer when a flaky phone reconnects. If it's the SAME call we're
  // already ringing/handling, ignore it — do NOT bounce a "busy" back (that was ending calls on answer).
  if (busy && callId === d.callId) return;
  // Genuinely on a different call → busy.
  if (busy) { emitCall('call:hangup', { to: d.from, callId: d.callId, reason: 'busy' }); return; }
  // 'idle' or the brief post-call 'ended' flash → take the call, clearing any leftover state first so a
  // stale timer can't fire a spurious "busy".
  if (state.status === 'ended') cleanup();
  peerId = d.from;
  callId = d.callId;
  pendingOffer = d.sdp;
  set({ status: 'incoming', peer: peerById(d.from) || { id: d.from, username: '', displayName: d.name || 'Incoming call', publicKey: null }, muted: false, speaker: false, startedAt: null, endedReason: null });
  ringTimeout = setTimeout(() => { if (state.status === 'incoming') { emitCall('call:hangup', { to: peerId, callId, reason: 'timeout' }); endCall(null); } }, 35000);
  // Tapped "Accept" on the notification? Pick up straight away. Otherwise ring.
  if (autoAcceptUntil > Date.now() && (autoAcceptId === '*' || autoAcceptId === d.callId)) {
    autoAcceptUntil = 0; autoAcceptId = null;
    acceptCall();
  } else {
    startRing('in');
    nativeCall.incoming(callId, state.peer?.displayName || d.name || 'Incoming call');
  }
}

export async function onAnswer(d: { from: string; sdp: string; callId: string }): Promise<void> {
  if (!voice || d.callId !== callId) return;
  stopRing(); // the other side picked up — stop the ringback
  nativeCall.connected(callId);
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
