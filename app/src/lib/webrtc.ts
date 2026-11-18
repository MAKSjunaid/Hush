// Low-level WebRTC wrapper for 1:1 voice calls. Audio is peer-to-peer and end-to-end encrypted
// (DTLS-SRTP) — it never passes through the server. Browser/PWA only (native would need
// react-native-webrtc); callSupported() guards that.

type Handlers = {
  onIce: (candidate: string) => void; // trickle ICE candidate (JSON string), or '' when gathering ends
  onRemoteStream: (stream: MediaStream) => void;
  onState: (state: string) => void; // 'connected' | 'disconnected' | 'failed' | 'closed' ...
};

export function callSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof (window as any).RTCPeerConnection !== 'undefined' &&
    !!navigator?.mediaDevices?.getUserMedia
  );
}

export class VoiceCall {
  private pc: RTCPeerConnection;
  private local: MediaStream | null = null;
  private remote: MediaStream = new MediaStream();
  private pendingIce: RTCIceCandidateInit[] = [];
  private remoteSet = false;
  private closed = false;

  constructor(iceServers: RTCIceServer[] | undefined, private h: Handlers) {
    this.pc = new RTCPeerConnection({ iceServers: iceServers?.length ? iceServers : [{ urls: 'stun:stun.l.google.com:19302' }] });
    this.pc.onicecandidate = (e) => this.h.onIce(e.candidate ? JSON.stringify(e.candidate.toJSON()) : '');
    this.pc.ontrack = (e) => {
      e.streams[0]?.getTracks().forEach((t) => this.remote.addTrack(t));
      this.h.onRemoteStream(this.remote);
    };
    this.pc.onconnectionstatechange = () => this.h.onState(this.pc.connectionState);
  }

  /** Grab the mic and add it to the connection. Throws if permission denied. */
  async startMic(): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
    // If the call was already torn down while the mic prompt was open, release it immediately
    // instead of leaving the mic on.
    if (this.closed) { stream.getTracks().forEach((t) => t.stop()); return; }
    this.local = stream;
    this.local.getTracks().forEach((t) => this.pc.addTrack(t, this.local!));
  }

  async createOffer(): Promise<string> {
    const offer = await this.pc.createOffer({ offerToReceiveAudio: true } as any);
    await this.pc.setLocalDescription(offer);
    return JSON.stringify(offer);
  }

  /** Apply the caller's offer and produce an answer. */
  async acceptOffer(sdp: string): Promise<string> {
    await this.pc.setRemoteDescription(JSON.parse(sdp));
    this.remoteSet = true;
    await this.flushIce();
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    return JSON.stringify(answer);
  }

  async setAnswer(sdp: string): Promise<void> {
    await this.pc.setRemoteDescription(JSON.parse(sdp));
    this.remoteSet = true;
    await this.flushIce();
  }

  async addIce(candidate: string): Promise<void> {
    if (!candidate) return;
    const init = JSON.parse(candidate) as RTCIceCandidateInit;
    if (!this.remoteSet) { this.pendingIce.push(init); return; } // can't add before remote description
    try { await this.pc.addIceCandidate(init); } catch {}
  }

  private async flushIce() {
    const q = this.pendingIce.splice(0);
    for (const c of q) { try { await this.pc.addIceCandidate(c); } catch {} }
  }

  setMuted(muted: boolean) {
    this.local?.getAudioTracks().forEach((t) => { t.enabled = !muted; });
  }

  getRemoteStream(): MediaStream { return this.remote; }

  close() {
    this.closed = true; // so a mic stream still being acquired gets stopped on arrival
    try { this.local?.getTracks().forEach((t) => t.stop()); } catch {}
    try { this.pc.getSenders().forEach((s) => s.track?.stop()); } catch {}
    try { this.remote.getTracks().forEach((t) => t.stop()); } catch {}
    try { this.pc.ontrack = null; this.pc.onicecandidate = null; this.pc.onconnectionstatechange = null; } catch {}
    try { this.pc.close(); } catch {}
    this.local = null;
  }
}
