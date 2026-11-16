import React, { useEffect, useMemo, useRef } from 'react';
import { Animated, PanResponder, Platform, Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { T, tap } from '@/components/ui';
import { fonts, useTheme } from '@/lib/theme';

const ACTION_W = 88;
const FULL_SWIPE = 200; // swipe this far (like iPhone) to jump straight to delete
const native = Platform.OS !== 'web';

// Only one row open at a time, like iOS Mail/Messages.
let closeOpenRow: (() => void) | null = null;

/** iPhone-style row: swipe left to reveal a red Delete button. Works on Android, iPhone and web (touch or mouse). */
export function SwipeRow({
  children, onPress, onDelete, deleteLabel = 'Delete',
}: { children: React.ReactNode; onPress: () => void; onDelete: () => void; deleteLabel?: string }) {
  const { c } = useTheme();
  const x = useRef(new Animated.Value(0)).current;
  const open = useRef(false);
  const moved = useRef(false);

  const snap = (to: number) => {
    open.current = to !== 0;
    Animated.spring(x, { toValue: to, useNativeDriver: native, bounciness: 0, speed: 18 }).start();
    if (open.current) {
      if (closeOpenRow && closeOpenRow !== close) closeOpenRow();
      closeOpenRow = close;
    } else if (closeOpenRow === close) {
      closeOpenRow = null;
    }
  };
  const close = () => snap(0);

  useEffect(() => () => {
    if (closeOpenRow === close) closeOpenRow = null;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const pan = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponderCapture: (_e, g) => Math.abs(g.dx) > 8 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
        onPanResponderGrant: () => {
          moved.current = true;
          x.stopAnimation();
        },
        onPanResponderMove: (_e, g) => {
          const base = open.current ? -ACTION_W : 0;
          x.setValue(Math.min(0, Math.max(-FULL_SWIPE - 40, base + g.dx)));
        },
        onPanResponderRelease: (_e, g) => {
          const pos = (open.current ? -ACTION_W : 0) + g.dx;
          if (pos < -FULL_SWIPE) {
            snap(0);
            tap();
            onDelete();
          } else if (pos < -ACTION_W / 2 || g.vx < -0.5) snap(-ACTION_W);
          else snap(0);
          setTimeout(() => (moved.current = false), 50);
        },
        onPanResponderTerminationRequest: () => false,
        onPanResponderTerminate: () => {
          snap(0);
          moved.current = false;
        },
      }),
    [onDelete], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const actionOpacity = x.interpolate({ inputRange: [-ACTION_W, -12, 0], outputRange: [1, 0.4, 0], extrapolate: 'clamp' });

  return (
    <View style={{ overflow: 'hidden' }}>
      <Animated.View style={{ position: 'absolute', top: 0, bottom: 0, right: 0, width: ACTION_W, opacity: actionOpacity }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={deleteLabel}
          onPress={() => {
            tap();
            snap(0);
            onDelete();
          }}
          style={({ pressed }) => ({ flex: 1, backgroundColor: '#DC2626', opacity: pressed ? 0.85 : 1, alignItems: 'center', justifyContent: 'center', gap: 4 })}
        >
          <Ionicons name="trash" size={22} color="#FFFFFF" />
          <T variant="small" color="#FFFFFF" style={{ fontFamily: fonts.semibold, fontSize: 12 }}>{deleteLabel}</T>
        </Pressable>
      </Animated.View>
      <Animated.View style={{ transform: [{ translateX: x }], backgroundColor: c.bg }} {...pan.panHandlers}>
        <Pressable
          onPress={() => {
            if (moved.current) return;
            if (open.current) return close();
            if (closeOpenRow) closeOpenRow();
            onPress();
          }}
          onLongPress={() => {
            tap();
            onDelete();
          }}
          delayLongPress={450}
          style={({ pressed }) => ({ backgroundColor: pressed && !open.current ? c.surface2 : c.bg })}
        >
          {children}
        </Pressable>
      </Animated.View>
    </View>
  );
}
