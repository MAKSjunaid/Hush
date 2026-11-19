// Web / no-op implementation. The browser call path uses Web Audio + the in-app CallOverlay and has
// no OS-level call UI, so every method here does nothing. Metro loads nativecall.native.ts on phones.
export const nativeCall = {
  setup(_h: { onAnswer: () => void; onEnd: () => void }): void {},
  incoming(_callId: string | null, _name: string): void {},
  outgoing(_callId: string | null, _name: string): void {},
  connected(_callId: string | null): void {},
  ended(_callId: string | null): void {},
  setSpeaker(_on: boolean): void {},
  setMuted(_callId: string | null, _muted: boolean): void {},
};
