import React, { useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Avatar, Button, IconButton, Screen, T } from '@/components/ui';
import { fonts, useTheme } from '@/lib/theme';
import { answerRequest, avatarUrl, requestChat, searchUsers, useStore, User } from '@/lib/store';
import { isWeb } from '@/lib/config';

type Result = User & { connection: { status: string; outgoing: boolean } | null };

export default function Search() {
  const { c } = useTheme();
  const router = useRouter();
  const incoming = useStore((s) => s.incoming);
  const outgoing = useStore((s) => s.outgoing);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Result[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const term = q.trim().toLowerCase().replace(/^@/, '');

  useEffect(() => {
    if (term.length < 3) {
      setResults([]);
      return;
    }
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        setResults(await searchUsers(term));
        setError(null);
      } catch (e: any) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [term]);

  const request = async (u: Result) => {
    setBusy(u.id);
    try {
      const status = await requestChat(u.id);
      setResults((rs) => rs.map((r) => (r.id === u.id ? { ...r, connection: { status, outgoing: true } } : r)));
      if (status === 'accepted') router.replace(`/chat/${u.id}`);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  };

  const action = (u: Result) => {
    const st = u.connection?.status;
    if (st === 'accepted') return <Button small title="Open" variant="secondary" onPress={() => router.replace(`/chat/${u.id}`)} />;
    if (st === 'pending' && u.connection?.outgoing) return <Button small title="Requested" variant="secondary" disabled />;
    if (st === 'pending') return <Button small title="Accept" onPress={() => request(u)} loading={busy === u.id} />;
    return <Button small title="Request" onPress={() => request(u)} loading={busy === u.id} />;
  };

  const highlight = (name: string) => {
    const i = name.indexOf(term);
    if (i < 0) return <T variant="bodyStrong">{name}</T>;
    return (
      <T variant="bodyStrong">
        {name.slice(0, i)}
        <T variant="bodyStrong" color={c.accentText}>{name.slice(i, i + term.length)}</T>
        {name.slice(i + term.length)}
      </T>
    );
  };

  return (
    <Screen padded={false}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingLeft: 12, paddingRight: 24, height: 64 }}>
        <IconButton icon="chevron-back" label="Back" onPress={() => router.back()} />
        <View style={{ flex: 1, height: 46, borderRadius: 14, backgroundColor: c.surface, borderWidth: 1, borderColor: c.accent, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14 }}>
          <Ionicons name="search" size={18} color={c.accentText} />
          <TextInput
            accessibilityLabel="Search usernames"
            autoFocus
            value={q}
            onChangeText={setQ}
            placeholder="Search usernames"
            placeholderTextColor={c.faint}
            autoCapitalize="none"
            autoCorrect={false}
            style={[{ flex: 1, color: c.text, fontFamily: fonts.medium, fontSize: 16, height: '100%' }, isWeb ? ({ outlineStyle: 'none' } as any) : null]}
          />
          {loading ? <ActivityIndicator size="small" color={c.faint} /> : null}
        </View>
      </View>

      <FlatList
        data={results}
        keyExtractor={(u) => u.id}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingHorizontal: 24, paddingBottom: 40 }}
        ListHeaderComponent={
          <View style={{ gap: 4, paddingTop: 8 }}>
            {term.length >= 3 ? <T variant="caption" style={{ marginBottom: 6 }}>Results</T> : (
              <T variant="small" style={{ marginBottom: 6 }}>Type at least 3 letters of a username. People can only message you after you accept their request.</T>
            )}
            {error ? <T variant="small" color={c.danger}>{error}</T> : null}
          </View>
        }
        ListEmptyComponent={term.length >= 3 && !loading ? <T variant="small" style={{ paddingVertical: 12 }}>No one found with that username.</T> : undefined}
        renderItem={({ item }) => (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 10 }}>
            <Avatar name={item.username} size={48} uri={avatarUrl(item)} />
            <View style={{ flex: 1, minWidth: 0 }}>
              {highlight(item.username)}
              {item.displayName !== item.username ? <T variant="small" numberOfLines={1}>{item.displayName}</T> : null}
            </View>
            {action(item)}
          </View>
        )}
        ListFooterComponent={
          <View style={{ gap: 4, marginTop: 20 }}>
            {incoming.length ? (
              <>
                <View style={{ height: 1, backgroundColor: c.border, marginBottom: 16 }} />
                <T variant="caption" style={{ marginBottom: 6 }}>Requests for you · {incoming.length}</T>
                {incoming.map((r) => (
                  <View key={r.connectionId} style={{ flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 10 }}>
                    <Avatar name={r.user.username} size={48} uri={avatarUrl(r.user)} />
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <T variant="bodyStrong">{r.user.username}</T>
                      <T variant="small">wants to chat</T>
                    </View>
                    <IconButton icon="close" label={`Decline ${r.user.username}`} color={c.muted} onPress={() => answerRequest(r.connectionId, false)} style={{ borderWidth: 1, borderColor: c.border, borderRadius: 12 }} />
                    <Button small title="Accept" onPress={async () => {
                      await answerRequest(r.connectionId, true);
                      router.replace(`/chat/${r.user.id}`);
                    }} />
                  </View>
                ))}
              </>
            ) : null}
            {outgoing.length ? (
              <>
                <View style={{ height: 1, backgroundColor: c.border, marginVertical: 16 }} />
                <T variant="caption" style={{ marginBottom: 6 }}>Waiting for them · {outgoing.length}</T>
                {outgoing.map((r) => (
                  <View key={r.connectionId} style={{ flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 10 }}>
                    <Avatar name={r.user.username} size={40} uri={avatarUrl(r.user)} />
                    <T style={{ flex: 1 }}>{r.user.username}</T>
                    <T variant="small">Requested</T>
                  </View>
                ))}
              </>
            ) : null}
          </View>
        }
      />
    </Screen>
  );
}
