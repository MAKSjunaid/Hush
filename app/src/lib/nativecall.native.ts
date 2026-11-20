// Native (Android/iOS) call AUDIO via react-native-incall-manager ONLY.
//
// We deliberately do NOT use react-native-callkeep's native call screen (Android ConnectionService).
// On Android that screen routes the call through the system telecom stack, which takes the microphone
// away from the WebRTC call — so the other side can't hear you. Every call now runs on the in-app
// call screen, and InCallManager just manages the audio session (mode, speaker, ringtone/ringback),
// leaving the microphone and audio with WebRTC. This is the reliable path.
//
// Trade-off (intentional): an incoming call while the app is closed arrives as a push notification the
// user taps to open the in-app call screen — there is no full-screen native ring. Metro loads this
// file only on native builds (never on web).
import InCallManager from 'react-native-incall-manager';

// Kept for API compatibility with call.ts (the in-app UI drives answer/decline directly now).
let answerCb: () => void = () => {};
let endCb: () => void = () => {};

export const nativeCall = {
  setup(h: { onAnswer: () => void; onEnd: () => void }): void {
    answerCb = h.onAnswer;
    endCb = h.onEnd;
  },

  // Incoming call: ring. The in-app screen shows Accept / Decline.
  incoming(_callId: string | null, _name: string): void {
    try { InCallManager.startRingtone('_DEFAULT_'); } catch {}
  },

  // Outgoing call: open the audio session and play a ringback tone.
  outgoing(_callId: string | null, _name: string): void {
    try { InCallManager.start({ media: 'audio' }); } catch {}
    try { InCallManager.startRingback('_DTMF_'); } catch {}
  },

  // Answered / media connected: stop ringing, keep the audio session active for WebRTC.
  connected(_callId: string | null): void {
    try { InCallManager.stopRingtone(); } catch {}
    try { InCallManager.stopRingback(); } catch {}
    try { InCallManager.start({ media: 'audio' }); } catch {}
  },

  // Call finished: tear down the audio session.
  ended(_callId: string | null): void {
    try { InCallManager.stopRingtone(); } catch {}
    try { InCallManager.stopRingback(); } catch {}
    try { InCallManager.stop(); } catch {}
  },

  setSpeaker(on: boolean): void {
    try { InCallManager.setForceSpeakerphoneOn(on); } catch {}
  },

  setMuted(_callId: string | null, muted: boolean): void {
    try { InCallManager.setMicrophoneMute(muted); } catch {}
  },
};
