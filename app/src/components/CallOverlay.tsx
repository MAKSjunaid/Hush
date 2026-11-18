import React, { useEffect, useState } from 'react';
import { Modal, Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme, fonts } from '@/lib/theme';
import { T, Avatar } from './ui';
import { avatarUrl } from '@/lib/store';
import { useCall, acceptCall, declineCall, hangup, toggleMute, toggleSpeaker } from '@/lib/call';

function fmt(ms: number) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

const REASON_TEXT: Record<string, string> = {
  declined: 'Call declined',
  busy: 'Busy',
  missed: 'No answer',
  'no-answer': 'No answer',
  unavailable: 'Unavailable',
  'mic-denied': 'Microphone blocked',
  unsupported: 'Calls not supported here',
  failed: 'Call failed',
  error: 'Call failed',
};

function RoundBtn({ icon, color, bg, onPress, label }: { icon: any; color: string; bg: string; onPress: () => void; label: string }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => ({ width: 64, height: 64, borderRadius: 32, backgroundColor: bg, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.85 : 1 })}
    >
      <Ionicons name={icon} size={26} color={color} />
    </Pressable>
  );
}

export function CallOverlay() {
  const { c } = useTheme();
  const status = useCall((s) => s.status);
  const peer = useCall((s) => s.peer);
  const muted = useCall((s) => s.muted);
  const speaker = useCall((s) => s.speaker);
  const startedAt = useCall((s) => s.startedAt);
  const endedReason = useCall((s) => s.endedReason);
  const [, tick] = useState(0);

  useEffect(() => {
    if (status !== 'active') return;
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [status]);

  if (status === 'idle') return null;

  const name = peer?.displayName || 'Call';
  const sub =
    status === 'incoming' ? 'Incoming voice call'
    : status === 'outgoing' ? 'Calling…'
    : status === 'connecting' ? 'Connecting…'
    : status === 'active' ? (startedAt ? fmt(Date.now() - startedAt) : 'Connected')
    : status === 'ended' ? (endedReason ? REASON_TEXT[endedReason] || 'Call ended' : 'Call ended')
    : '';

  return (
    <Modal visible transparent animationType="fade" onRequestClose={() => { if (status === 'incoming') declineCall(); else hangup(); }}>
      <View style={{ flex: 1, backgroundColor: c.dark ? '#0A0A0F' : '#101018', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 72 }}>
        {/* identity */}
        <View style={{ alignItems: 'center', gap: 16, marginTop: 40 }}>
          <Avatar name={peer?.username || name} size={112} uri={avatarUrl(peer as any)} />
          <T style={{ fontFamily: fonts.semibold, fontSize: 26, color: '#FFFFFF' }}>{name}</T>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Ionicons name="lock-closed" size={12} color="#9BE8C9" />
            <T style={{ fontSize: 15, color: '#C9C8CF' }}>{sub}</T>
          </View>
        </View>

        {/* controls */}
        {status === 'incoming' ? (
          <View style={{ flexDirection: 'row', gap: 72 }}>
            <View style={{ alignItems: 'center', gap: 8 }}>
              <RoundBtn icon="close" color="#FFFFFF" bg="#DC2626" onPress={declineCall} label="Decline" />
              <T style={{ fontSize: 13, color: '#C9C8CF' }}>Decline</T>
            </View>
            <View style={{ alignItems: 'center', gap: 8 }}>
              <RoundBtn icon="call" color="#FFFFFF" bg="#16A34A" onPress={acceptCall} label="Accept" />
              <T style={{ fontSize: 13, color: '#C9C8CF' }}>Accept</T>
            </View>
          </View>
        ) : status === 'ended' ? (
          <View style={{ height: 64 }} />
        ) : (
          <View style={{ alignItems: 'center', gap: 28 }}>
            {(status === 'active' || status === 'connecting') ? (
              <View style={{ flexDirection: 'row', gap: 40 }}>
                <View style={{ alignItems: 'center', gap: 8 }}>
                  <RoundBtn icon={muted ? 'mic-off' : 'mic'} color={muted ? '#101018' : '#FFFFFF'} bg={muted ? '#FFFFFF' : 'rgba(255,255,255,0.15)'} onPress={toggleMute} label={muted ? 'Unmute' : 'Mute'} />
                  <T style={{ fontSize: 13, color: '#C9C8CF' }}>{muted ? 'Unmute' : 'Mute'}</T>
                </View>
                <View style={{ alignItems: 'center', gap: 8 }}>
                  <RoundBtn icon={speaker ? 'volume-high' : 'volume-medium'} color={speaker ? '#101018' : '#FFFFFF'} bg={speaker ? '#FFFFFF' : 'rgba(255,255,255,0.15)'} onPress={toggleSpeaker} label="Speaker" />
                  <T style={{ fontSize: 13, color: '#C9C8CF' }}>Speaker</T>
                </View>
              </View>
            ) : null}
            <View style={{ alignItems: 'center', gap: 8 }}>
              <RoundBtn icon="call" color="#FFFFFF" bg="#DC2626" onPress={hangup} label="End call" />
              <T style={{ fontSize: 13, color: '#C9C8CF' }}>End</T>
            </View>
          </View>
        )}
      </View>
    </Modal>
  );
}
