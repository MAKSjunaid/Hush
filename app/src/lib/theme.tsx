import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { useColorScheme } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

export type Palette = {
  dark: boolean;
  bg: string;
  surface: string;
  surface2: string;
  border: string;
  text: string;
  muted: string;
  faint: string;
  accent: string;
  onAccent: string;
  accentSoft: string;
  accentText: string;
  bubbleIn: string;
  bubbleOut: string;
  onBubbleOut: string;
  success: string;
  warn: string;
  warnSoft: string;
  danger: string;
  dangerSoft: string;
  overlay: string;
};

export const darkPalette: Palette = {
  dark: true,
  bg: '#0B0B0F',
  surface: '#17181D',
  surface2: '#131419',
  border: '#2A2B33',
  text: '#F2F1EE',
  muted: '#9A9AA5',
  faint: '#85858F',
  accent: '#8B7CFF',
  onAccent: '#0B0B0F',
  accentSoft: '#221E3D',
  accentText: '#B3A9FF',
  bubbleIn: '#1C1D24',
  bubbleOut: '#8B7CFF',
  onBubbleOut: '#0B0B0F',
  success: '#4FD1A5',
  warn: '#F5B454',
  warnSoft: '#241D10',
  danger: '#FF8A8A',
  dangerSoft: '#1E1214',
  overlay: 'rgba(0,0,0,0.6)',
};

export const lightPalette: Palette = {
  dark: false,
  bg: '#F7F7FA',
  surface: '#FFFFFF',
  surface2: '#EFEFF4',
  border: '#E1E1E8',
  text: '#141418',
  muted: '#5E5E6A',
  faint: '#6E6E7A',
  accent: '#6A5AE0',
  onAccent: '#FFFFFF',
  accentSoft: '#ECE9FF',
  accentText: '#5242C9',
  bubbleIn: '#FFFFFF',
  bubbleOut: '#6A5AE0',
  onBubbleOut: '#FFFFFF',
  success: '#13795B',
  warn: '#9A5B00',
  warnSoft: '#FFF4E0',
  danger: '#B42318',
  dangerSoft: '#FDECEA',
  overlay: 'rgba(20,20,24,0.45)',
};

export const fonts = {
  regular: 'Inter_400Regular',
  medium: 'Inter_500Medium',
  semibold: 'Inter_600SemiBold',
  display: 'SpaceGrotesk_700Bold',
  displayMedium: 'SpaceGrotesk_600SemiBold',
};

export type ThemeMode = 'system' | 'light' | 'dark';

type Ctx = { c: Palette; mode: ThemeMode; isDark: boolean; setMode: (m: ThemeMode) => void };
const ThemeCtx = createContext<Ctx>({ c: darkPalette, mode: 'dark', isDark: true, setMode: () => {} });

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const system = useColorScheme();
  const [mode, setModeState] = useState<ThemeMode>('dark');

  useEffect(() => {
    AsyncStorage.getItem('hush.theme').then((v) => {
      if (v === 'light' || v === 'dark' || v === 'system') setModeState(v);
    });
  }, []);

  const value = useMemo<Ctx>(() => {
    const isDark = mode === 'system' ? system !== 'light' : mode === 'dark';
    return {
      c: isDark ? darkPalette : lightPalette,
      mode,
      isDark,
      setMode: (m) => {
        setModeState(m);
        AsyncStorage.setItem('hush.theme', m);
      },
    };
  }, [mode, system]);

  return <ThemeCtx.Provider value={value}>{children}</ThemeCtx.Provider>;
}

export const useTheme = () => useContext(ThemeCtx);
