import React from 'react';
import {
  ActivityIndicator, Modal, Pressable, StyleProp, StyleSheet, Text, TextInput, TextInputProps, TextStyle, View, ViewStyle,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { fonts, useTheme } from '@/lib/theme';
import { avatarColors, initials } from '@/lib/format';
import { isWeb } from '@/lib/config';

export type IconName = React.ComponentProps<typeof Ionicons>['name'];

export const tap = () => {
  if (!isWeb) Haptics.selectionAsync().catch(() => {});
};

export function T({
  children, style, variant = 'body', color, numberOfLines, selectable,
}: {
  children: React.ReactNode;
  style?: StyleProp<TextStyle>;
  variant?: 'title' | 'heading' | 'body' | 'bodyStrong' | 'small' | 'label' | 'caption';
  color?: string;
  numberOfLines?: number;
  selectable?: boolean;
}) {
  const { c } = useTheme();
  const v: Record<string, TextStyle> = {
    title: { fontFamily: fonts.display, fontSize: 32, letterSpacing: -0.6, lineHeight: 38, color: c.text },
    heading: { fontFamily: fonts.display, fontSize: 22, letterSpacing: -0.3, color: c.text },
    body: { fontFamily: fonts.regular, fontSize: 15, lineHeight: 22, color: c.text },
    bodyStrong: { fontFamily: fonts.semibold, fontSize: 16, color: c.text },
    small: { fontFamily: fonts.regular, fontSize: 13, lineHeight: 19, color: c.muted },
    label: { fontFamily: fonts.medium, fontSize: 13, color: c.muted },
    caption: { fontFamily: fonts.semibold, fontSize: 12, letterSpacing: 0.8, textTransform: 'uppercase', color: c.faint },
  };
  return (
    <Text style={[v[variant], color ? { color } : null, style]} numberOfLines={numberOfLines} selectable={selectable}>
      {children}
    </Text>
  );
}

export function Screen({
  children, style, edges = ['top', 'bottom'], padded = true,
}: { children: React.ReactNode; style?: StyleProp<ViewStyle>; edges?: ('top' | 'bottom')[]; padded?: boolean }) {
  const { c } = useTheme();
  return (
    <SafeAreaView edges={edges} style={{ flex: 1, backgroundColor: c.bg }}>
      <View style={[{ flex: 1, width: '100%', maxWidth: 720, alignSelf: 'center' }, padded && { paddingHorizontal: 24 }, style]}>
        {children}
      </View>
    </SafeAreaView>
  );
}

export function Logo({ size = 52 }: { size?: number }) {
  const { c } = useTheme();
  return (
    <View
      style={{ width: size, height: size, borderRadius: size * 0.31, backgroundColor: c.accent, alignItems: 'center', justifyContent: 'center' }}
      accessibilityLabel="Hush"
    >
      <Text style={{ fontFamily: fonts.display, fontSize: size * 0.56, color: c.onAccent, marginTop: -size * 0.04 }}>h</Text>
    </View>
  );
}

export function Button({
  title, onPress, variant = 'primary', loading, disabled, icon, style, small,
}: {
  title: string;
  onPress?: () => void;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  loading?: boolean;
  disabled?: boolean;
  icon?: IconName;
  style?: StyleProp<ViewStyle>;
  small?: boolean;
}) {
  const { c } = useTheme();
  const bg = variant === 'primary' ? c.accent : variant === 'danger' ? c.dangerSoft : 'transparent';
  const fg = variant === 'primary' ? c.onAccent : variant === 'danger' ? c.danger : variant === 'ghost' ? c.accentText : c.text;
  const border = variant === 'secondary' ? c.border : variant === 'danger' ? c.danger + '55' : 'transparent';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled || loading }}
      onPress={() => {
        tap();
        onPress?.();
      }}
      disabled={disabled || loading}
      style={({ pressed }) => [
        {
          height: small ? 44 : 54,
          paddingHorizontal: small ? 16 : 20,
          borderRadius: small ? 12 : 16,
          backgroundColor: bg,
          borderWidth: 1,
          borderColor: border,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          opacity: disabled ? 0.45 : pressed ? 0.8 : 1,
          transform: [{ scale: pressed ? 0.98 : 1 }],
        },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={fg} />
      ) : (
        <>
          {icon ? <Ionicons name={icon} size={18} color={fg} /> : null}
          <Text style={{ fontFamily: fonts.semibold, fontSize: small ? 14 : 16, color: fg }}>{title}</Text>
        </>
      )}
    </Pressable>
  );
}

export function IconButton({
  icon, onPress, label, color, size = 22, style, badge,
}: { icon: IconName; onPress?: () => void; label: string; color?: string; size?: number; style?: StyleProp<ViewStyle>; badge?: number }) {
  const { c } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={6}
      onPress={() => {
        tap();
        onPress?.();
      }}
      style={({ pressed }) => [
        { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.6 : 1 },
        style,
      ]}
    >
      <Ionicons name={icon} size={size} color={color ?? c.text} />
      {badge ? (
        <View style={{ position: 'absolute', top: 6, right: 4, minWidth: 18, height: 18, borderRadius: 9, backgroundColor: c.accent, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 }}>
          <Text style={{ fontFamily: fonts.semibold, fontSize: 11, color: c.onAccent }}>{badge}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

export function Field({
  label, prefix, right, error, hint, hintColor, focusColor, ...input
}: TextInputProps & {
  label?: string;
  prefix?: string;
  right?: React.ReactNode;
  error?: string | null;
  hint?: string | null;
  hintColor?: string;
  focusColor?: string;
}) {
  const { c } = useTheme();
  const [focused, setFocused] = React.useState(false);
  const borderColor = error ? c.danger : focusColor ?? (focused ? c.accent : c.border);
  return (
    <View style={{ gap: 8 }}>
      {label ? <T variant="label">{label}</T> : null}
      <View
        style={{
          flexDirection: 'row', alignItems: 'center', gap: 6, height: 52, paddingLeft: 16, paddingRight: right ? 4 : 16,
          borderRadius: 14, backgroundColor: c.surface, borderWidth: 1, borderColor,
        }}
      >
        {prefix ? <Text style={{ fontFamily: fonts.regular, fontSize: 16, color: c.faint }}>{prefix}</Text> : null}
        <TextInput
          placeholderTextColor={c.faint}
          accessibilityLabel={label}
          {...input}
          onFocus={(e) => {
            setFocused(true);
            input.onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            input.onBlur?.(e);
          }}
          style={[
            { flex: 1, minWidth: 0, fontFamily: fonts.medium, fontSize: 16, color: c.text, height: '100%' },
            isWeb ? ({ outlineStyle: 'none' } as any) : null,
            input.style,
          ]}
        />
        {right}
      </View>
      {error ? <T variant="small" color={c.danger}>{error}</T> : hint ? <T variant="small" color={hintColor}>{hint}</T> : null}
    </View>
  );
}

export function Avatar({ name, size = 52, online }: { name: string; size?: number; online?: boolean }) {
  const { c } = useTheme();
  const [bg, fg] = avatarColors(name, c.dark);
  return (
    <View style={{ width: size, height: size }}>
      <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: bg, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ fontFamily: fonts.semibold, fontSize: size * 0.34, color: fg }}>{initials(name)}</Text>
      </View>
      {online ? (
        <View
          accessibilityLabel="online"
          style={{
            position: 'absolute', right: 0, bottom: 0, width: size * 0.27, height: size * 0.27, borderRadius: size,
            backgroundColor: c.success, borderWidth: 2.5, borderColor: c.bg,
          }}
        />
      ) : null}
    </View>
  );
}

export function Toggle({ value, onChange, label, sub }: { value: boolean; onChange: (v: boolean) => void; label: string; sub?: string }) {
  const { c } = useTheme();
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: value }}
      accessibilityLabel={label}
      onPress={() => {
        tap();
        onChange(!value);
      }}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, minHeight: 56 }}
    >
      <View style={{ flex: 1, gap: 2 }}>
        <T style={{ fontFamily: fonts.medium }}>{label}</T>
        {sub ? <T variant="small">{sub}</T> : null}
      </View>
      <View style={{ width: 48, height: 28, borderRadius: 14, backgroundColor: value ? c.accent : c.border, justifyContent: 'center' }}>
        <View
          style={{
            width: 22, height: 22, borderRadius: 11, backgroundColor: value ? c.onAccent : c.surface,
            marginLeft: value ? 23 : 3,
          }}
        />
      </View>
    </Pressable>
  );
}

export function Row({
  label, sub, value, onPress, icon, danger,
}: { label: string; sub?: string; value?: string; onPress?: () => void; icon?: IconName; danger?: boolean }) {
  const { c } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => {
        tap();
        onPress?.();
      }}
      style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, minHeight: 56, opacity: pressed ? 0.6 : 1 })}
    >
      {icon ? <Ionicons name={icon} size={20} color={danger ? c.danger : c.muted} /> : null}
      <View style={{ flex: 1, gap: 2 }}>
        <T style={{ fontFamily: fonts.medium }} color={danger ? c.danger : undefined}>{label}</T>
        {sub ? <T variant="small">{sub}</T> : null}
      </View>
      {value ? <T style={{ fontFamily: fonts.semibold, fontSize: 14 }} color={c.accentText}>{value}</T> : null}
      {onPress && !danger ? <Ionicons name="chevron-forward" size={16} color={c.faint} /> : null}
    </Pressable>
  );
}

export function Notice({ icon, text, tone = 'accent', style }: { icon: IconName; text: string; tone?: 'accent' | 'warn' | 'danger'; style?: StyleProp<ViewStyle> }) {
  const { c } = useTheme();
  const fg = tone === 'warn' ? c.warn : tone === 'danger' ? c.danger : c.accentText;
  const bg = tone === 'warn' ? c.warnSoft : tone === 'danger' ? c.dangerSoft : c.surface2;
  return (
    <View style={[{ flexDirection: 'row', gap: 12, alignItems: 'flex-start', padding: 14, borderRadius: 14, backgroundColor: bg, borderWidth: 1, borderColor: c.border }, style]}>
      <Ionicons name={icon} size={18} color={fg} style={{ marginTop: 1 }} />
      <T variant="small" style={{ flex: 1 }} color={tone === 'accent' ? c.muted : fg}>{text}</T>
    </View>
  );
}

/** Simple bottom sheet. */
export function Sheet({ visible, onClose, children, title }: { visible: boolean; onClose: () => void; children: React.ReactNode; title?: string }) {
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={[StyleSheet.absoluteFill, { backgroundColor: c.overlay }]} onPress={onClose} accessibilityLabel="Close" />
      <View style={{ flex: 1, justifyContent: 'flex-end' }} pointerEvents="box-none">
        <View
          style={{
            backgroundColor: c.surface, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 20,
            paddingBottom: 20 + insets.bottom, gap: 6, width: '100%', maxWidth: 720, alignSelf: 'center',
          }}
        >
          <View style={{ alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: c.border, marginBottom: 8 }} />
          {title ? <T variant="heading" style={{ fontSize: 18, marginBottom: 6 }}>{title}</T> : null}
          {children}
        </View>
      </View>
    </Modal>
  );
}

export function Header({ title, onBack, right }: { title?: string; onBack?: () => void; right?: React.ReactNode }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, height: 56, marginHorizontal: -10 }}>
      {onBack ? <IconButton icon="chevron-back" label="Back" onPress={onBack} /> : null}
      {title ? <T variant="heading" style={{ flex: 1, fontSize: 24 }}>{title}</T> : <View style={{ flex: 1 }} />}
      {right}
    </View>
  );
}
