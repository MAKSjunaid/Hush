import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as ScreenCapture from 'expo-screen-capture';
import { Ionicons } from '@expo/vector-icons';
import { fonts, useTheme } from '@/lib/theme';
import { Logo, T, tap } from './ui';
import {
  isLockEnabled, checkPin, getBiometricPref, biometricAvailable, unlockWithBiometrics, getLockDelay,
} from '@/lib/lock';

/**
 * - Covers the app whenever it goes to the background (hides chats in the app switcher).
 * - Asks for PIN / Face ID / fingerprint when App Lock is on.
 */
export function LockGate({ active, children }: { active: boolean; children: React.ReactNode }) {
  const { c } = useTheme();
  const [locked, setLocked] = useState(false);
  const [covered, setCovered] = useState(false);
  const leftAt = useRef<number | null>(null);

  useEffect(() => {
    if (Platform.OS === 'ios') ScreenCapture.enableAppSwitcherProtectionAsync(0.9).catch(() => {});
  }, []);

  useEffect(() => {
    if (!active) return setLocked(false);
    isLockEnabled().then((on) => on && setLocked(true));
  }, [active]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', async (s) => {
      if (s === 'active') {
        setCovered(false);
        if (active && leftAt.current && (await isLockEnabled())) {
          const delay = await getLockDelay();
          if ((Date.now() - leftAt.current) / 1000 >= delay) setLocked(true);
        }
        leftAt.current = null;
      } else {
        setCovered(true);
        if (leftAt.current == null) leftAt.current = Date.now();
      }
    });
    return () => sub.remove();
  }, [active]);

  return (
    <View style={{ flex: 1 }}>
      {children}
      {locked ? <LockScreen onUnlock={() => setLocked(false)} /> : null}
      {covered && !locked && Platform.OS !== 'web' ? (
        <View style={[StyleSheet.absoluteFill, { backgroundColor: c.bg, alignItems: 'center', justifyContent: 'center' }]}>
          <Logo size={64} />
        </View>
      ) : null}
    </View>
  );
}

function LockScreen({ onUnlock }: { onUnlock: () => void }) {
  const { c } = useTheme();
  const [pin, setPin] = useState('');
  const [error, setError] = useState(false);
  const [bio, setBio] = useState(false);

  const tryBio = useCallback(async () => {
    if (await unlockWithBiometrics()) onUnlock();
  }, [onUnlock]);

  useEffect(() => {
    (async () => {
      const ok = (await getBiometricPref()) && (await biometricAvailable());
      setBio(ok);
      if (ok) tryBio();
    })();
  }, [tryBio]);

  const press = async (d: string) => {
    tap();
    setError(false);
    const next = (pin + d).slice(0, 4);
    setPin(next);
    if (next.length === 4) {
      if (await checkPin(next)) onUnlock();
      else {
        setError(true);
        setTimeout(() => setPin(''), 350);
      }
    }
  };

  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', bio ? 'bio' : '', '0', 'del'];
  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: c.bg }]}>
      <SafeAreaView style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 28, padding: 24 }}>
        <Logo size={64} />
        <View style={{ alignItems: 'center', gap: 6 }}>
          <T variant="heading">Hush is locked</T>
          <T variant="small" color={error ? c.danger : c.muted}>{error ? 'Wrong PIN, try again' : 'Enter your 4-digit PIN'}</T>
        </View>
        <View style={{ flexDirection: 'row', gap: 16 }} accessibilityLabel={`${pin.length} of 4 digits entered`}>
          {[0, 1, 2, 3].map((i) => (
            <View key={i} style={{ width: 14, height: 14, borderRadius: 7, backgroundColor: i < pin.length ? (error ? c.danger : c.accent) : c.border }} />
          ))}
        </View>
        <View style={{ width: 280, flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: 14 }}>
          {keys.map((k, i) =>
            k === '' ? (
              <View key={i} style={{ width: 80, height: 72 }} />
            ) : (
              <Pressable
                key={i}
                accessibilityRole="button"
                accessibilityLabel={k === 'del' ? 'Delete' : k === 'bio' ? 'Use Face ID or fingerprint' : k}
                onPress={() => (k === 'del' ? setPin((p) => p.slice(0, -1)) : k === 'bio' ? tryBio() : press(k))}
                style={({ pressed }) => ({
                  width: 80, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center',
                  backgroundColor: k === 'del' || k === 'bio' ? 'transparent' : pressed ? c.border : c.surface,
                })}
              >
                {k === 'del' ? (
                  <Ionicons name="backspace-outline" size={26} color={c.text} />
                ) : k === 'bio' ? (
                  <Ionicons name={Platform.OS === 'ios' ? 'scan-outline' : 'finger-print'} size={28} color={c.accentText} />
                ) : (
                  <Text style={{ fontFamily: fonts.medium, fontSize: 28, color: c.text }}>{k}</Text>
                )}
              </Pressable>
            ),
          )}
        </View>
      </SafeAreaView>
    </View>
  );
}
