import React, { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Button, Field, Header, IconButton, Notice, Screen, T } from '@/components/ui';
import { useTheme } from '@/lib/theme';
import { checkUsername, signup } from '@/lib/store';

function strength(p: string) {
  let s = 0;
  if (p.length >= 8) s++;
  if (p.length >= 12) s++;
  if (/[A-Z]/.test(p) && /[a-z]/.test(p)) s++;
  if (/\d/.test(p) && /[^A-Za-z0-9]/.test(p)) s++;
  return s;
}

export default function Signup() {
  const { c } = useTheme();
  const router = useRouter();
  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [check, setCheck] = useState<{ state: 'idle' | 'checking' | 'ok' | 'bad'; msg?: string }>({ state: 'idle' });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const u = username.trim().toLowerCase().replace(/^@/, '');

  useEffect(() => {
    if (u.length < 3) return setCheck({ state: 'idle' });
    setCheck({ state: 'checking' });
    const t = setTimeout(async () => {
      try {
        const r = await checkUsername(u);
        setCheck(r.available ? { state: 'ok', msg: `@${u} is available` } : { state: 'bad', msg: r.reason ?? 'Not available' });
      } catch (e: any) {
        setCheck({ state: 'bad', msg: e.message });
      }
    }, 400);
    return () => clearTimeout(t);
  }, [u]);

  const s = strength(password);
  const mismatch = confirm.length > 0 && confirm !== password;
  const canSubmit = check.state === 'ok' && password.length >= 8 && confirm === password;

  const submit = async () => {
    setError(null);
    setLoading(true);
    try {
      await signup(u, displayName.trim() || u, password);
      // _layout sends us to the recovery-key screen
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Screen>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Header onBack={() => { if (router.canGoBack()) router.back(); else router.replace('/login'); }} />
        <ScrollView contentContainerStyle={{ gap: 22, paddingBottom: 24 }} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          <View style={{ gap: 8 }}>
            <T variant="title">Create your account</T>
            <T color={c.muted}>No email. No phone number. Just a name only you choose.</T>
          </View>

          <Field placeholder="Display name (optional)" accessibilityLabel="Display name" value={displayName} onChangeText={setDisplayName} maxLength={40} autoComplete="name" />
          <Field
            placeholder="Username"
            accessibilityLabel="Username"
            prefix="@"
            value={username}
            onChangeText={(t) => setUsername(t.replace(/\s/g, '').toLowerCase())}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="username-new"
            maxLength={25}
            focusColor={check.state === 'ok' ? c.success : undefined}
            right={
              check.state === 'ok' ? <Ionicons name="checkmark" size={20} color={c.success} style={{ marginRight: 12 }} /> : null
            }
            hint={check.state === 'checking' ? 'Checking…' : check.state === 'idle' ? '3–24 letters, numbers, dot or underscore' : check.msg}
            hintColor={check.state === 'ok' ? c.success : check.state === 'bad' ? c.danger : c.muted}
          />
          <View style={{ gap: 8 }}>
            <Field
              placeholder="Password (at least 8 characters)"
              accessibilityLabel="Password"
              value={password}
              onChangeText={setPassword}
              secureTextEntry={!show}
              autoCapitalize="none"
              autoComplete="new-password"
              right={<IconButton icon={show ? 'eye-off-outline' : 'eye-outline'} label={show ? 'Hide password' : 'Show password'} color={c.muted} size={20} onPress={() => setShow(!show)} />}
            />
            {password.length > 0 ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <View style={{ flex: 1, flexDirection: 'row', gap: 4 }}>
                  {[0, 1, 2, 3].map((i) => (
                    <View key={i} style={{ flex: 1, height: 4, borderRadius: 2, backgroundColor: i < s ? (s <= 1 ? c.warn : c.accent) : c.border }} />
                  ))}
                </View>
                <T variant="small">{['Too short', 'Weak', 'Okay', 'Strong', 'Very strong'][s]}</T>
              </View>
            ) : null}
          </View>
          <Field
            placeholder="Confirm password"
            accessibilityLabel="Confirm password"
            value={confirm}
            onChangeText={setConfirm}
            secureTextEntry={!show}
            autoCapitalize="none"
            autoComplete="new-password"
            error={mismatch ? "Passwords don't match" : null}
          />

          {error ? <T variant="small" color={c.danger}>{error}</T> : null}
        </ScrollView>
        <View style={{ gap: 12, paddingBottom: 12 }}>
          <Button title="Create account" onPress={submit} disabled={!canSubmit} loading={loading} />
          <Notice icon="lock-closed-outline" text="Messages vanish for both of you once they're seen. Screenshots come out black, and the other person is told." />
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}
