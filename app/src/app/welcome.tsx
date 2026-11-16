import React from 'react';
import { Linking, Platform, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Button, Logo, Notice, Screen, T, IconName, ThemeToggle } from '@/components/ui';
import { useTheme } from '@/lib/theme';
import { useStore } from '@/lib/store';
import { API_URL } from '@/lib/config';

const FEATURES: { icon: IconName; title: string; body: string }[] = [
  { icon: 'eye-off-outline', title: 'Gone once seen', body: 'Messages delete themselves for both people.' },
  { icon: 'camera-outline', title: 'Screenshot alerts', body: 'Screenshots come out black, and the other person is told.' },
  { icon: 'person-outline', title: 'No phone, no email', body: 'Just a username you choose. Nothing else about you.' },
  { icon: 'lock-closed-outline', title: 'End-to-end encrypted', body: 'Not even the Hush server can read your chats.' },
];

export default function Welcome() {
  const { c } = useTheme();
  const router = useRouter();
  const ended = useStore((s) => s.endedReason);
  const config = useStore((s) => s.config);

  const ua = Platform.OS === 'web' && typeof navigator !== 'undefined' ? navigator.userAgent : '';
  const appLink = /Android/i.test(ua) ? config?.apkUrl : /iPhone|iPad/i.test(ua) ? config?.iosUrl : null;

  return (
    <Screen>
      <View style={{ flex: 1, justifyContent: 'center', gap: 32, paddingVertical: 24 }}>
        <View style={{ gap: 18 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <Logo size={64} />
            <ThemeToggle />
          </View>
          <View style={{ gap: 8 }}>
            <T variant="title" style={{ fontSize: 40, lineHeight: 46 }}>Say less.{'\n'}Leave no trace.</T>
            <T variant="body" color={c.muted}>Private chat where messages vanish the moment they're seen.</T>
          </View>
        </View>

        <View style={{ gap: 18 }}>
          {FEATURES.map((f) => (
            <View key={f.title} style={{ flexDirection: 'row', gap: 14, alignItems: 'center' }}>
              <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: c.accentSoft, alignItems: 'center', justifyContent: 'center' }}>
                <Ionicons name={f.icon} size={20} color={c.accentText} />
              </View>
              <View style={{ flex: 1 }}>
                <T variant="bodyStrong" style={{ fontSize: 15 }}>{f.title}</T>
                <T variant="small">{f.body}</T>
              </View>
            </View>
          ))}
        </View>

        {ended ? <Notice icon="information-circle-outline" text={ended} tone="warn" /> : null}
      </View>

      <View style={{ gap: 12, paddingBottom: 12 }}>
        <Button title="Create account" onPress={() => router.push('/signup')} />
        <Button title="I already have an account" variant="secondary" onPress={() => router.push('/login')} />
        {appLink ? (
          <Button
            title={/Android/i.test(ua) ? 'Get the Android app' : 'Get the iPhone app'}
            variant="ghost"
            icon="download-outline"
            onPress={() => Linking.openURL(`${API_URL}/get`)}
          />
        ) : null}
      </View>
    </Screen>
  );
}
