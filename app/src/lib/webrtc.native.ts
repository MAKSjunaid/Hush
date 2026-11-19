// Native (iOS/Android) WebRTC engine for 1:1 voice calls, via react-native-webrtc.
// Metro picks THIS file on a native build and the browser `webrtc.ts` on web — so the shared
// call store (call.ts) imports `./webrtc` once and never branches on platform. The public surface
// (callSupported + VoiceCall) is identical to the web version; only the low-level plumbing differs.
// Audio stays peer-to-peer and end-to-end encrypted (DTLS-SRTP) — it never touches the server.

import {
  RTCPeerConnection,
  RTCIceCandidate,
  RTCSessionDescription,
  mediaDevices,
  MediaStream,
} from 'react-native-webrtc';

type Handlers = {
  onIce: (candidate: string) => void; // trickle ICE candidate (JSON string), or '' when gathering ends
  onRemoteStream: (stream: any) => void;
  onState: (state: string) => void;
};

// On a native build the engine is always present (the module is compiled in).
export function callSupported(): boolean {
  return true;
}

export class VoiceCall {
  private pc: any;
  private local: any = null;
  private remote: any = new MediaStream();
  private pendingIce: any[] = [];
  private remoteSet = false;
  private closed = false;

  constructor(iceServers: any[] | undefined, private h: Handlers) {
    this.pc = new RTCPeerConnection({
      iceServers: iceServers?.length ? iceServers : [{ urls: 'stun:stun.l.google.com:19302' }],
    });
    // react-native-webrtc uses addEventListener rather than on<x> handler props.
    this.pc.addEventListener('icecandidate', (e: any) => {
      const c = e.candidate;
      this.h.onIce(c ? JSON.stringify(typeof c.toJSON === 'function' ? c.toJSON() : c) : '');
    });
    this.pc.addEventListener('track', (e: any) => {
      const s = e.streams && e.streams[0];
      if (s) s.getTracks().forEach((t: any) => this.remote.addTrack(t));
      this.h.onRemoteStream(this.remote);
    });
    this.pc.addEventListener('connectionstatechange', () => this.h.onState(this.pc.connectionState));
  }

  /** Grab the mic and add it to the connection. Throws if permission denied. */
  async startMic(): Promise<void> {
    const stream: any = await mediaDevices.getUserMedia({
      audio: true,
      video: false,
    });
    // Torn down while the permission prompt was open? Release the mic immediately.
    if (this.closed) { stream.getTracks().forEach((t: any) => t.stop()); return; }
    this.local = stream;
    stream.getTracks().forEach((t: any) => this.pc.addTrack(t, stream));
  }

  async createOffer(): Promise<string> {
    const offer = await this.pc.createOffer({ offerToReceiveAudio: true });
    await this.pc.setLocalDescription(offer);
    return JSON.stringify(offer);
  }

  async acceptOffer(sdp: string): Promise<string> {
    await this.pc.setRemoteDescription(new RTCSessionDescription(JSON.parse(sdp)));
    this.remoteSet = true;
    await this.flushIce();
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    return JSON.stringify(answer);
  }

  async setAnswer(sdp: string): Promise<void> {
    await this.pc.setRemoteDescription(new RTCSessionDescription(JSON.parse(sdp)));
    this.remoteSet = true;
    await this.flushIce();
  }

  async addIce(candidate: string): Promise<void> {
    if (!candidate) return;
    const init = JSON.parse(candidate);
    if (!this.remoteSet) { this.pendingIce.push(init); return; }
    try { await this.pc.addIceCandidate(new RTCIceCandidate(init)); } catch {}
  }

  private async flushIce() {
    const q = this.pendingIce.splice(0);
    for (const c of q) { try { await this.pc.addIceCandidate(new RTCIceCandidate(c)); } catch {} }
  }

  setMuted(muted: boolean) {
    this.local?.getAudioTracks().forEach((t: any) => { t.enabled = !muted; });
  }

  getRemoteStream(): any { return this.remote; }

  close() {
    this.closed = true;
    try { this.local?.getTracks().forEach((t: any) => t.stop()); } catch {}
    try { this.pc.getSenders().forEach((s: any) => s.track?.stop()); } catch {}
    try { this.remote.getTracks().forEach((t: any) => t.stop()); } catch {}
    try { this.pc.close(); } catch {}
    this.local = null;
  }
}
