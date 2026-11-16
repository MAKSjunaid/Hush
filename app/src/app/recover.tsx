import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Button, Field, Header, Screen, T } from '@/components/ui';
import { fonts, useTheme } from '@/lib/theme';
import { recover } from '@/lib/store';

export default function Recover() {
  const { c } = useTheme();
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [words, setWords] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const count = words.trim() ? words.trim().split(/\s+/).length : 0;

  const submit = async () => {
    setError(null);
    setLoading(true);
    try {
      await recover(username.trim(), words, password);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Screen>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Header onBack={() => router.back()} />
        <ScrollView contentContainerStyle={{ gap: 22, paddingBottom: 24 }} keyboardShouldPersistTaps="handled">
          <View style={{ gap: 8 }}>
            <T variant="title" style={{ fontSize: 30 }}>Use your recovery key</T>
            <T color={c.muted}>Enter the 12 words you saved when you signed up, then choose a new password.</T>
          </View>
          <Field label="Username" prefix="@" value={username} onChangeText={(t) => setUsername(t.replace(/\s/g, '').toLowerCase())} autoCapitalize="none" autoCorrect={false} />
          <View style={{ gap: 8 }}>
            <T variant="label">Recovery key ({count}/12 words)</T>
            <TextInput
              accessibilityLabel="Recovery key"
              value={words}
              onChangeText={setWords}
              multiline
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="velvet harbor quiet …"
              placeholderTextColor={c.faint}
              style={{
                minHeight: 110, padding: 16, borderRadius: 14, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border,
                color: c.text, fontFamily: fonts.medium, fontSize: 16, textAlignVertical: 'top',
              }}
            />
          </View>
          <Field label="New password" value={password} onChangeText={setPassword} secureTextEntry autoCapitalize="none" autoComplete="new-password" hint="At least 8 characters" />
          {error ? <T variant="small" color={c.danger}>{error}</T> : null}
        </ScrollView>
        <View style={{ paddingBottom: 12 }}>
          <Button title="Reset password and log in" onPress={submit} loading={loading} disabled={!username || count !== 12 || password.length < 8} />
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}
