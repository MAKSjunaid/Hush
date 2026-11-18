import React, { useEffect } from 'react';
import { Linking, Platform, Pressable, View } from 'react-native';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import * as SystemUI from 'expo-system-ui';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFonts, Inter_400Regular, Inter_500Medium, Inter_600SemiBold } from '@expo-google-fonts/inter';
import { SpaceGrotesk_600SemiBold, SpaceGrotesk_700Bold } from '@expo-google-fonts/space-grotesk';
import { ThemeProvider, useTheme } from '@/lib/theme';
import { init, useStore } from '@/lib/store';
import { LockGate } from '@/components/LockGate';
import { CallOverlay } from '@/components/CallOverlay';
import { T } from '@/components/ui';
import { APP_VERSION, API_URL } from '@/lib/config';
import { compareVersions } from '@/lib/format';

SplashScreen.preventAutoHideAsync().catch(() => {});

const PUBLIC_ROUTES = new Set(['welcome', 'signup', 'login', 'recover']);

function Gate() {
  const { c } = useTheme();
  const router = useRouter();
  const segments = useSegments();
  const ready = useStore((s) => s.ready);
  const token = useStore((s) => s.token);
  const pendingKey = useStore((s) => s.pendingRecoveryKey);
  const config = useStore((s) => s.config);

  useEffect(() => {
    SystemUI.setBackgroundColorAsync(c.bg).catch(() => {});
  }, [c.bg]);

  useEffect(() => {
    if (!ready) return;
    SplashScreen.hideAsync().catch(() => {});
    const first = (segments[0] as string | undefined) ?? '';
    const isPublic = PUBLIC_ROUTES.has(first);
    if (!token && !isPublic) router.replace('/welcome');
    else if (token && pendingKey && first !== 'recovery-key') router.replace('/recovery-key');
    else if (token && !pendingKey && (isPublic || first === '')) router.replace('/chats');
  }, [ready, token, pendingKey, segments, router]);

  const mustUpdate = config && Platform.OS !== 'web' && compareVersions(APP_VERSION, config.minAppVersion) < 0;

  return (
    <LockGate active={Boolean(token)}>
      <StatusBar style={c.dark ? 'light' : 'dark'} />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: c.bg }, animation: 'slide_from_right' }} />
      {config?.maintenance ? <Banner text="HushChat is under maintenance. Messages will send when we're back." /> : null}
      {mustUpdate ? (
        <Banner text="A new version of HushChat is required. Tap to update." onPress={() => Linking.openURL(`${API_URL}/get`)} />
      ) : null}
      {token ? <CallOverlay /> : null}
    </LockGate>
  );
}

function Banner({ text, onPress }: { text: string; onPress?: () => void }) {
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole={onPress ? 'button' : 'text'}
      style={{ position: 'absolute', left: 12, right: 12, bottom: insets.bottom + 12, padding: 14, borderRadius: 14, backgroundColor: c.warnSoft, borderWidth: 1, borderColor: c.warn + '66' }}
    >
      <T variant="small" color={c.warn}>{text}</T>
    </Pressable>
  );
}

export default function RootLayout() {
  const [fontsLoaded] = useFonts({ Inter_400Regular, Inter_500Medium, Inter_600SemiBold, SpaceGrotesk_600SemiBold, SpaceGrotesk_700Bold });

  useEffect(() => {
    init();
  }, []);

  if (!fontsLoaded) return <View style={{ flex: 1, backgroundColor: '#0B0B0F' }} />;
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <Gate />
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
