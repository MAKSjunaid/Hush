import React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useTheme } from '@/lib/theme';

/** Shown for a moment while Hush decides where to go (handled in _layout). */
export default function Index() {
  const { c } = useTheme();
  return (
    <View style={{ flex: 1, backgroundColor: c.bg, alignItems: 'center', justifyContent: 'center' }}>
      <ActivityIndicator color={c.accent} />
    </View>
  );
}
