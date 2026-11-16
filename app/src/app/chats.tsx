import React, { useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Avatar, Button, IconButton, Screen, Sheet, T, tap, ThemeToggle } from '@/components/ui';
import { SwipeRow } from '@/components/SwipeRow';
import { fonts, useTheme } from '@/lib/theme';
import { avatarUrl, deleteChat, dismissAnnouncement, Msg, peerOf, useStore, Conn } from '@/lib/store';
import { shortWhen } from '@/lib/format';

type Row = { conn: Conn; last?: Msg; unread: number; typing: boolean; at: string };

export default function Chats() {
  const { c } = useTheme();
  const router = useRouter();
  const contacts = useStore((s) => s.contacts);
  const incoming = useStore((s) => s.incoming);
  const messages = useStore((s) => s.messages);
  const typing = useStore((s) => s.typing);
  const connected = useStore((s) => s.connected);
  const announcement = useStore((s) => s.config?.announcement);
  const synced = useStore((s) => s.synced);
  const [toDelete, setToDelete] = useState<Conn['user'] | null>(null);
  const [busy, setBusy] = useState(false);
  const dismissed = useStore((s) => s.announcementDismissed);

  const rows = useMemo<Row[]>(() => {
    const byPeer: Record<string, Msg[]> = {};
    Object.values(messages).forEach((m) => {
      (byPeer[peerOf(m)] ||= []).push(m);
    });
    return contacts
      .map((conn) => {
        const list = (byPeer[conn.user.id] || []).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        const last = list[list.length - 1];
        const unread = list.filter((m) => !m.mine && !m.seenAt && !m.readLocally && (m.kind === 'text' || m.kind === 'photo')).length;
        return { conn, last, unread, typing: Boolean(typing[conn.user.id]), at: last?.createdAt ?? conn.since };
      })
      .sort((a, b) => b.at.localeCompare(a.at));
  }, [contacts, messages, typing]);

  const showAnnouncement = announcement?.text && dismissed !== announcement.at;

  const status = (r: Row): { text: string; color: string; icon?: React.ComponentProps<typeof Ionicons>['name']; strong?: boolean } => {
    if (r.typing) return { text: 'typing…', color: c.accentText };
    const m = r.last;
    if (!m) return { text: 'Say hi — messages vanish once seen', color: c.faint };
    if (m.kind === 'screenshot' || m.kind === 'recording') {
      const what = m.kind === 'screenshot' ? 'take a screenshot' : 'record the screen';
      return { text: m.mine ? `You tried to ${what}` : `Tried to ${what}`, color: c.warn, icon: 'camera-outline' };
    }
    if (r.unread) return { text: r.unread > 1 ? `${r.unread} new messages` : m.kind === 'photo' ? 'Photo · view once' : 'New message · tap to read', color: c.text, strong: true };
    if (m.mine) {
      if (m.status === 'sending') return { text: 'Sending…', color: c.faint, icon: 'time-outline' };
      if (m.status === 'failed') return { text: 'Not sent — tap to retry', color: c.danger, icon: 'alert-circle-outline' };
      if (m.status === 'seen') return { text: m.timer ? 'Seen · vanishing soon' : 'Seen · vanished', color: c.faint, icon: 'checkmark-done' };
      if (m.status === 'delivered') return { text: 'Delivered', color: c.muted, icon: 'checkmark-done' };
      return { text: 'Sent', color: c.muted, icon: 'checkmark' };
    }
    return { text: m.timer ? 'Seen · vanishing soon' : 'Seen · vanished', color: c.faint, icon: 'checkmark-done' };
  };

  return (
    <Screen padded={false} edges={['top']}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingLeft: 24, paddingRight: 12, height: 64 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <T variant="title">Chats</T>
          {!connected ? <T variant="small" color={c.faint}>connecting…</T> : null}
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <ThemeToggle />
          <IconButton icon="shield-checkmark-outline" label="Privacy and settings" onPress={() => router.push('/settings')} />
        </View>
      </View>

      <FlatList
        data={rows}
        keyExtractor={(r) => r.conn.user.id}
        contentContainerStyle={{ paddingBottom: 120 }}
        ListHeaderComponent={
          <View style={{ gap: 12, paddingHorizontal: 24, paddingBottom: 8 }}>
            <Pressable
              accessibilityRole="search"
              onPress={() => router.push('/search')}
              style={{ height: 46, borderRadius: 14, backgroundColor: c.surface, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, borderWidth: c.dark ? 0 : 1, borderColor: c.border }}
            >
              <Ionicons name="search" size={18} color={c.faint} />
              <T color={c.faint}>Search usernames</T>
            </Pressable>

            {showAnnouncement ? (
              <View style={{ flexDirection: 'row', gap: 10, padding: 14, borderRadius: 14, backgroundColor: c.accentSoft }}>
                <Ionicons name="megaphone-outline" size={18} color={c.accentText} />
                <T variant="small" style={{ flex: 1 }} color={c.text}>{announcement!.text}</T>
                <Pressable accessibilityLabel="Dismiss" onPress={dismissAnnouncement} hitSlop={10}>
                  <Ionicons name="close" size={18} color={c.muted} />
                </Pressable>
              </View>
            ) : null}

            {incoming.length ? (
              <Pressable
                onPress={() => router.push('/search')}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: 14, borderWidth: 1, borderColor: c.border }}
              >
                <View style={{ width: 36, height: 36, borderRadius: 12, backgroundColor: c.accentSoft, alignItems: 'center', justifyContent: 'center' }}>
                  <Ionicons name="person-add-outline" size={18} color={c.accentText} />
                </View>
                <View style={{ flex: 1 }}>
                  <T variant="bodyStrong" style={{ fontSize: 15 }}>Message requests</T>
                  <T variant="small">{incoming.length === 1 ? '1 person wants to chat' : `${incoming.length} people want to chat`}</T>
                </View>
                <Badge n={incoming.length} />
              </Pressable>
            ) : null}
          </View>
        }
        ListEmptyComponent={
          !synced ? (
            <View style={{ alignItems: 'center', paddingTop: 80 }}>
              <ActivityIndicator color={c.accent} />
            </View>
          ) : (
            <View style={{ alignItems: 'center', paddingHorizontal: 40, paddingTop: 60, gap: 12 }}>
              <View style={{ width: 72, height: 72, borderRadius: 24, backgroundColor: c.accentSoft, alignItems: 'center', justifyContent: 'center' }}>
                <Ionicons name="chatbubbles-outline" size={34} color={c.accentText} />
              </View>
              <T variant="heading" style={{ fontSize: 20 }}>No chats yet</T>
              <T variant="small" style={{ textAlign: 'center' }}>Search for a friend's exact username and send a request. You can chat once they accept.</T>
            </View>
          )
        }
        renderItem={({ item }) => {
          const st = status(item);
          const u = item.conn.user;
          return (
            <SwipeRow
              onPress={() => {
                tap();
                router.push(`/chat/${u.id}`);
              }}
              onDelete={() => setToDelete(u)}
            >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 12, paddingHorizontal: 24 }}>
              <Avatar name={u.username} online={u.online} uri={avatarUrl(u)} />
              <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
                  <T variant="bodyStrong" numberOfLines={1} style={{ flexShrink: 1 }}>{u.displayName !== u.username ? u.displayName : u.username}</T>
                  <T variant="small" style={{ fontSize: 12 }} color={item.unread ? c.accentText : c.faint}>{shortWhen(item.last?.createdAt)}</T>
                </View>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  {st.icon ? <Ionicons name={st.icon} size={15} color={st.color} /> : null}
                  <T
                    variant="small"
                    numberOfLines={1}
                    style={{ flex: 1, fontSize: 14, fontFamily: st.strong ? fonts.semibold : fonts.regular, fontStyle: item.typing ? 'italic' : 'normal' }}
                    color={st.color}
                  >
                    {st.text}
                  </T>
                  {item.unread ? <Badge n={item.unread} /> : null}
                </View>
              </View>
            </View>
            </SwipeRow>
          );
        }}
      />

      <Sheet visible={!!toDelete} onClose={() => setToDelete(null)} title="Delete this chat?">
        <T variant="small">Every message with @{toDelete?.username} will be deleted for both of you. This can't be undone. You'll still be connected.</T>
        <View style={{ gap: 10, marginTop: 14 }}>
          <Button
            title="Delete for both"
            variant="danger"
            loading={busy}
            onPress={async () => {
              if (!toDelete) return;
              setBusy(true);
              try {
                await deleteChat(toDelete.id);
              } finally {
                setBusy(false);
                setToDelete(null);
              }
            }}
          />
          <Button title="Cancel" variant="secondary" onPress={() => setToDelete(null)} />
        </View>
      </Sheet>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="New chat"
        onPress={() => router.push('/search')}
        style={({ pressed }) => ({
          position: 'absolute', right: 24, bottom: 32, width: 60, height: 60, borderRadius: 20, backgroundColor: c.accent,
          alignItems: 'center', justifyContent: 'center', transform: [{ scale: pressed ? 0.95 : 1 }],
          shadowColor: c.accent, shadowOpacity: 0.35, shadowRadius: 16, shadowOffset: { width: 0, height: 8 }, elevation: 6,
        })}
      >
        <Ionicons name="create-outline" size={26} color={c.onAccent} />
      </Pressable>
    </Screen>
  );
}

function Badge({ n }: { n: number }) {
  const { c } = useTheme();
  return (
    <View style={{ minWidth: 22, height: 22, borderRadius: 11, paddingHorizontal: 6, backgroundColor: c.accent, alignItems: 'center', justifyContent: 'center' }}>
      <T style={{ fontFamily: fonts.semibold, fontSize: 12 }} color={c.onAccent}>{n > 99 ? '99+' : n}</T>
    </View>
  );
}
