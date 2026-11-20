import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Button, Field, Header, IconButton, Logo, Notice, Screen, T } from '@/components/ui';
import { useTheme } from '@/lib/theme';
import { login } from '@/lib/store';

export default function Login() {
  const { c } = useTheme();
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    setError(null);
    setLoading(true);
    try {
      await login(username.trim(), password);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Screen>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Header onBack={router.canGoBack() ? () => router.back() : undefined} />
        <ScrollView contentContainerStyle={{ gap: 24, paddingBottom: 24 }} keyboardShouldPersistTaps="handled">
          <View style={{ alignItems: 'center', gap: 16, marginTop: 16 }}>
            <Logo size={68} />
            <View style={{ alignItems: 'center', gap: 6 }}>
              <T variant="title">Welcome back</T>
              <T color={c.muted}>Say less. Leave no trace.</T>
            </View>
          </View>
          <Field
            placeholder="Username"
            accessibilityLabel="Username"
            prefix="@"
            value={username}
            onChangeText={(t) => setUsername(t.replace(/\s/g, '').toLowerCase())}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="username"
          />
          <Field
            placeholder="Password"
            accessibilityLabel="Password"
            value={password}
            onChangeText={setPassword}
            secureTextEntry={!show}
            autoCapitalize="none"
            autoComplete="current-password"
            onSubmitEditing={submit}
            right={<IconButton icon={show ? 'eye-off-outline' : 'eye-outline'} label={show ? 'Hide password' : 'Show password'} color={c.muted} size={20} onPress={() => setShow(!show)} />}
          />
          <Button title="Forgot password? Use recovery key" variant="ghost" small onPress={() => router.push('/recover')} style={{ alignSelf: 'flex-end', paddingHorizontal: 0 }} />
          {error ? <T variant="small" color={c.danger}>{error}</T> : null}
        </ScrollView>
        <View style={{ gap: 12, paddingBottom: 12 }}>
          <Button title="Log in" onPress={submit} loading={loading} disabled={!username || password.length < 1} />
          <Button title="New here? Create an account" variant="ghost" small onPress={() => router.push('/signup')} />
          <Notice icon="phone-portrait-outline" text="HushChat works on one device at a time. Logging in here signs you out everywhere else, and chats on the old device can't be opened here." />
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}
