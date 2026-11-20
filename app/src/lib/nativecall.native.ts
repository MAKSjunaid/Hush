// Native (iOS/Android) call audio.
//
// IMPORTANT: react-native-callkeep is still initialized (RNCallKeep.setup) so the native module is
// fully wired — this is the SAME setup as the known-working build, so it cannot cause the startup
// crash. What we deliberately do NOT do anymore is create a native telecom "call" via
// displayIncomingCall()/startCall(): on Android that hands the call to the system telecom stack, which
// takes the microphone away from WebRTC (so the other side can't hear you). Instead every call runs on
// the in-app call screen and react-native-incall-manager manages the audio session (mode, speaker,
// ringtone/ringback), leaving the mic + audio with WebRTC. This is the reliable path.
//
// Trade-off (intentional): an incoming call while the app is closed arrives as a push notification the
// user taps to open the in-app call screen — there is no full-screen native ring. Metro loads this
// file only on native builds (never on web).
import RNCallKeep from 'react-native-callkeep';
import InCallManager from 'react-native-incall-manager';

let ready = false;
let answerCb: () => void = () => {};
let endCb: () => void = () => {};

// Keep CallKeep initialized exactly like the working build (so the native module is happy), but we
// never display/start a native call, so no telecom connection is ever created.
async function ensureSetup(): Promise<void> {
  if (ready) return;
  ready = true;
  try {
    await RNCallKeep.setup({
      ios: {
        appName: 'HushChat',
        supportsVideo: false,
        maximumCallGroups: '1',
        maximumCallsPerCallGroup: '1',
      },
      android: {
        alertTitle: 'Allow calls',
        alertDescription: 'HushChat needs this permission to show incoming calls',
        cancelButton: 'Cancel',
        okButton: 'OK',
        additionalPermissions: [],
        foregroundService: {
          channelId: 'app.hush.chat.call',
          channelName: 'HushChat calls',
          notificationTitle: 'HushChat call in progress',
        },
      },
    });
    RNCallKeep.setAvailable(true);
  } catch {
    ready = false;
  }
}

export const nativeCall = {
  setup(h: { onAnswer: () => void; onEnd: () => void }): void {
    answerCb = h.onAnswer;
    endCb = h.onEnd;
    ensureSetup();
  },

  // Incoming call: ring via InCallManager. The in-app screen shows Accept / Decline.
  // We do NOT call RNCallKeep.displayIncomingCall — that would grab the mic via the telecom stack.
  incoming(_callId: string | null, _name: string): void {
    ensureSetup();
    try { InCallManager.startRingtone('_DEFAULT_'); } catch {}
  },

  // Outgoing call: open the audio session and play a ringback tone.
  // We do NOT call RNCallKeep.startCall — same reason (keeps the mic with WebRTC).
  outgoing(_callId: string | null, _name: string): void {
    ensureSetup();
    try { InCallManager.start({ media: 'audio' }); } catch {}
    try { InCallManager.startRingback('_DTMF_'); } catch {}
  },

  // Call is live: stop ringing, keep the audio session active for WebRTC.
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
