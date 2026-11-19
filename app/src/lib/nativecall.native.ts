// Native (iOS/Android) call integration. This is what makes a call behave like a real phone call:
//  • react-native-callkeep → a native incoming-call screen (shows over the lock screen) and, on
//    Android, a foreground service that keeps the call + microphone ALIVE when the app is minimized,
//    the screen is locked, or the display is off. This is the piece a PWA can't do.
//  • react-native-incall-manager → audio session, speaker/earpiece routing, ringtone and ringback.
// Everything is wrapped in try/catch so a device/OS quirk degrades gracefully to the in-app UI
// instead of crashing the call. Metro loads this file only on native builds (never on web).
import RNCallKeep from 'react-native-callkeep';
import InCallManager from 'react-native-incall-manager';

let ready = false;
let answerCb: () => void = () => {};
let endCb: () => void = () => {};

async function ensureSetup(): Promise<void> {
  if (ready) return;
  ready = true; // set first so concurrent calls don't double-register
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
        // The foreground service is what keeps audio running while the app is backgrounded/locked.
        foregroundService: {
          channelId: 'app.hush.chat.call',
          channelName: 'HushChat calls',
          notificationTitle: 'HushChat call in progress',
        },
      },
    });
    RNCallKeep.setAvailable(true);
    RNCallKeep.addEventListener('answerCall', () => { try { answerCb(); } catch {} });
    RNCallKeep.addEventListener('endCall', () => { try { endCb(); } catch {} });
  } catch {
    ready = false; // allow a retry on the next action
  }
}

export const nativeCall = {
  setup(h: { onAnswer: () => void; onEnd: () => void }): void {
    answerCb = h.onAnswer;
    endCb = h.onEnd;
    ensureSetup();
  },

  // Someone is calling us: show the native incoming-call UI (rings + appears over the lock screen).
  incoming(callId: string | null, name: string): void {
    if (!callId) return;
    ensureSetup();
    try { RNCallKeep.displayIncomingCall(callId, name, name, 'generic', false); } catch {}
    try { InCallManager.startRingtone('_DEFAULT_'); } catch {}
  },

  // We're placing a call: register it with the OS and play a ringback tone.
  outgoing(callId: string | null, name: string): void {
    if (!callId) return;
    ensureSetup();
    try { RNCallKeep.startCall(callId, name, name, 'generic', false); } catch {}
    try { InCallManager.start({ media: 'audio' }); } catch {}
    try { InCallManager.startRingback('_DTMF_'); } catch {}
  },

  // Call is live (answered / media connected): stop ringing, keep the audio session active.
  connected(callId: string | null): void {
    try { InCallManager.stopRingtone(); } catch {}
    try { InCallManager.stopRingback(); } catch {}
    try { InCallManager.start({ media: 'audio' }); } catch {}
    try { if (callId) RNCallKeep.setCurrentCallActive(callId); } catch {}
  },

  // Call finished: tear down the native call + audio session.
  ended(callId: string | null): void {
    try { InCallManager.stopRingtone(); } catch {}
    try { InCallManager.stopRingback(); } catch {}
    try { InCallManager.stop(); } catch {}
    try { if (callId) RNCallKeep.endCall(callId); else RNCallKeep.endAllCalls(); } catch {}
  },

  setSpeaker(on: boolean): void {
    try { InCallManager.setForceSpeakerphoneOn(on); } catch {}
  },

  setMuted(callId: string | null, muted: boolean): void {
    try { if (callId) RNCallKeep.setMutedCall(callId, muted); } catch {}
  },
};
