import React, { useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { useRouter } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import { Ionicons } from '@expo/vector-icons';
import { Button, Notice, Screen, T, tap } from '@/components/ui';
import { fonts, useTheme } from '@/lib/theme';
import { clearRecoveryKey, useStore } from '@/lib/store';

export default function RecoveryKey() {
  const { c } = useTheme();
  const router = useRouter();
  const key = useStore((s) => s.pendingRecoveryKey);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const words = (key ?? '').split(' ');

  const done = () => {
    clearRecoveryKey();
    router.replace('/chats');
  };

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ gap: 22, paddingTop: 24, paddingBottom: 24 }} showsVerticalScrollIndicator={false}>
        <View style={{ gap: 8 }}>
          <T variant="title" style={{ fontSize: 30 }}>Save your recovery key</T>
          <T color={c.muted}>HushChat never knows your email or number. If you forget your password, these 12 words are the only way back in.</T>
        </View>

        <View style={{ padding: 14, borderRadius: 18, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {words.map((w, i) => (
            <View key={i} style={{ width: '31.5%', flexDirection: 'row', alignItems: 'baseline', gap: 6, padding: 10, borderRadius: 10, backgroundColor: c.surface2 }}>
              <T variant="small" style={{ fontSize: 11 }}>{i + 1}</T>
              <T style={{ fontFamily: fonts.medium, fontSize: 14 }} selectable>{w}</T>
            </View>
          ))}
        </View>

        <Button
          title={copied ? 'Copied' : 'Copy key'}
          icon={copied ? 'checkmark' : 'copy-outline'}
          variant="secondary"
          onPress={async () => {
            await Clipboard.setStringAsync(key ?? '');
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          }}
        />

        <Notice icon="warning-outline" tone="warn" text="Write it down or keep it in a password manager. Never share it — anyone with these words can take over your account." />
      </ScrollView>

      <View style={{ gap: 16, paddingBottom: 12 }}>
        <Pressable
          accessibilityRole="checkbox"
          accessibilityState={{ checked: saved }}
          onPress={() => {
            tap();
            setSaved(!saved);
          }}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 44 }}
        >
          <View style={{ width: 22, height: 22, borderRadius: 6, borderWidth: 1.5, borderColor: saved ? c.accent : c.faint, backgroundColor: saved ? c.accent : 'transparent', alignItems: 'center', justifyContent: 'center' }}>
            {saved ? <Ionicons name="checkmark" size={16} color={c.onAccent} /> : null}
          </View>
          <T style={{ flex: 1 }}>I've saved my recovery key somewhere safe</T>
        </Pressable>
        <Button title="Continue" onPress={done} disabled={!saved} />
      </View>
    </Screen>
  );
}
