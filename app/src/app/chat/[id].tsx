import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, AppState, FlatList, Image, KeyboardAvoidingView, Modal, Platform, Pressable, TextInput, View,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as ScreenCapture from 'expo-screen-capture';
import * as ImagePicker from 'expo-image-picker';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as Clipboard from 'expo-clipboard';
import { Ionicons } from '@expo/vector-icons';
import { Avatar, Button, IconButton, Row, Sheet, T, tap } from '@/components/ui';
import { fonts, useTheme } from '@/lib/theme';
import {
  Msg, peerOf, useStore, markSeen, purgeRead, sendText, sendPhoto, fetchPhoto, unsend, react, retry, sendTyping,
  reportScreenshot, setChatTimer, blockUser, report, removeContact, getState, decodeBase64,
} from '@/lib/store';
import { encodeBase64, safetyCode } from '@/lib/crypto';
import { clock, countdown, lastSeenText, TIMER_OPTIONS, timerShort } from '@/lib/format';
import { isWeb } from '@/lib/config';

const REACTIONS = ['❤️', '😂', '😮', '😢', '👍', '🔥'];
const REPORT_REASONS = ['Spam', 'Harassment or bullying', 'Inappropriate content', 'Pretending to be someone', 'Something else'];

export default function Chat() {
  const { id: peerId } = useLocalSearchParams<{ id: string }>();
  const { c } = useTheme();
  const router = useRouter();
  const me = useStore((s) => s.me);
  const keys = useStore((s) => s.keys);
  const peer = useStore((s) => s.contacts.find((x) => x.user.id === peerId)?.user);
  const all = useStore((s) => s.messages);
  const typing = useStore((s) => Boolean(s.typing[peerId]));
  const timer = useStore((s) => s.timers[peerId] ?? null);
  const mediaEnabled = useStore((s) => s.config?.mediaEnabled);

  const [text, setText] = useState('');
  const [replyTo, setReplyTo] = useState<Msg | null>(null);
  const [menuFor, setMenuFor] = useState<Msg | null>(null);
  const [sheet, setSheet] = useState<null | 'timer' | 'more' | 'report' | 'safety'>(null);
  const [reportMsg, setReportMsg] = useState<Msg | null>(null);
  const [viewer, setViewer] = useState<{ msg: Msg; uri: string | null; loading: boolean; error?: string } | null>(null);
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [, tick] = useState(0);
  const appActive = useRef(AppState.currentState === 'active');

  const list = useMemo(
    () => Object.values(all).filter((m) => peerOf(m) === peerId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [all, peerId],
  );

  // ----- screenshot protection (Android: black screenshots; iOS 13+: blocked/blank; both: other person is told) -----
  useEffect(() => {
    if (isWeb) return;
    ScreenCapture.preventScreenCaptureAsync('chat').catch(() => {});
    const sub = ScreenCapture.addScreenshotListener(() => reportScreenshot(peerId));
    return () => {
      sub.remove();
      ScreenCapture.allowScreenCaptureAsync('chat').catch(() => {});
    };
  }, [peerId]);

  // ----- vanish-on-seen -----
  const seeVisible = useCallback(() => {
    if (!appActive.current) return;
    const ids = getState()
      ? Object.values(getState().messages)
          .filter((m) => peerOf(m) === peerId && !m.mine && m.kind === 'text' && !m.seenAt && !m.readLocally)
          .map((m) => m.id)
      : [];
    if (ids.length) markSeen(ids);
  }, [peerId]);

  useEffect(() => {
    seeVisible();
  }, [list.length, seeVisible]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      appActive.current = s === 'active';
      if (s === 'active') seeVisible();
    });
    return () => {
      sub.remove();
      purgeRead(peerId); // leaving the chat: messages you've read are gone
      sendTyping(peerId, false);
    };
  }, [peerId, seeVisible]);

  // countdown refresh
  const hasTimed = list.some((m) => m.expiresAt && m.seenAt && m.timer);
  useEffect(() => {
    if (!hasTimed) return;
    const t = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [hasTimed]);

  if (!me || !keys) return null;
  if (!peer) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: c.bg, alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24 }}>
        <T variant="heading">Chat not available</T>
        <T variant="small" style={{ textAlign: 'center' }}>You're no longer connected with this person.</T>
        <Button title="Back to chats" small onPress={() => router.replace('/chats')} />
      </SafeAreaView>
    );
  }

  const send = () => {
    if (!text.trim()) return;
    try {
      sendText(peerId, text, replyTo);
      setText('');
      setReplyTo(null);
      sendTyping(peerId, false);
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const pickPhoto = async () => {
    try {
      const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1 });
      if (res.canceled || !res.assets?.[0]) return;
      setSending(true);
      const ctx = ImageManipulator.manipulate(res.assets[0].uri);
      if ((res.assets[0].width || 0) > 1600) ctx.resize({ width: 1600 });
      const img = await ctx.renderAsync();
      const out = await img.saveAsync({ format: SaveFormat.JPEG, compress: 0.72, base64: true });
      await sendPhoto(peerId, decodeBase64(out.base64!), out.width, out.height);
    } catch (e: any) {
      setErr(e.message || 'Could not send photo');
    } finally {
      setSending(false);
    }
  };

  const openPhoto = async (m: Msg) => {
    if (m.mine) return;
    setViewer({ msg: m, uri: null, loading: true });
    try {
      const bytes = await fetchPhoto(m);
      if (!bytes) throw new Error('This photo is gone');
      setViewer({ msg: m, uri: `data:image/jpeg;base64,${encodeBase64(bytes)}`, loading: false });
    } catch (e: any) {
      setViewer({ msg: m, uri: null, loading: false, error: e.message });
    }
  };

  const closeViewer = () => {
    if (viewer?.msg) markSeen([viewer.msg.id]); // view once: gone for both
    setViewer(null);
  };

  const sub = typing ? 'typing…' : lastSeenText(peer.online, peer.lastSeen);

  return (
    <SafeAreaView edges={['top', 'bottom']} style={{ flex: 1, backgroundColor: c.bg }}>
      <KeyboardAvoidingView style={{ flex: 1, width: '100%', maxWidth: 820, alignSelf: 'center' }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        {/* header */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 6, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: c.border }}>
          <IconButton icon="chevron-back" label="Back to chats" onPress={() => router.back()} />
          <Avatar name={peer.username} size={40} online={peer.online} />
          <View style={{ flex: 1, minWidth: 0, marginLeft: 6 }}>
            <T variant="bodyStrong" numberOfLines={1}>{peer.displayName !== peer.username ? peer.displayName : peer.username}</T>
            {sub ? <T variant="small" style={{ fontSize: 12 }} color={typing || peer.online ? c.success : c.faint}>{sub}</T> : null}
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Vanish timer: ${timerShort(timer)}`}
            onPress={() => setSheet('timer')}
            style={{ height: 36, paddingHorizontal: 12, borderRadius: 18, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface2, flexDirection: 'row', alignItems: 'center', gap: 6 }}
          >
            <Ionicons name="timer-outline" size={15} color={c.accentText} />
            <T style={{ fontFamily: fonts.semibold, fontSize: 12 }} color={c.muted}>{timerShort(timer)}</T>
          </Pressable>
          <IconButton icon="ellipsis-vertical" label="More options" color={c.muted} onPress={() => setSheet('more')} />
        </View>

        {/* messages */}
        <FlatList
          inverted
          data={list}
          keyExtractor={(m) => m.id}
          contentContainerStyle={{ padding: 16, gap: 8 }}
          keyboardShouldPersistTaps="handled"
          ListFooterComponent={
            <View style={{ alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8, paddingHorizontal: 14, borderRadius: 12, backgroundColor: c.surface2, marginBottom: 12, maxWidth: 340 }}>
              <Ionicons name="lock-closed" size={13} color={c.accentText} />
              <T variant="small" style={{ fontSize: 12, flexShrink: 1 }}>
                {isWeb ? 'End-to-end encrypted · Messages vanish once seen · Browsers can’t block screenshots' : 'End-to-end encrypted · Messages vanish once seen · Screenshots blocked'}
              </T>
            </View>
          }
          renderItem={({ item, index }) => {
            const newer = list[index - 1];
            const showMeta = !newer || newer.mine !== item.mine || newer.kind !== item.kind ||
              new Date(newer.createdAt).getTime() - new Date(item.createdAt).getTime() > 5 * 60_000;
            return (
              <MessageItem
                m={item}
                meId={me.id}
                peerName={peer.username}
                showMeta={showMeta}
                onLongPress={() => {
                  tap();
                  setMenuFor(item);
                }}
                onOpenPhoto={() => openPhoto(item)}
                onRetry={() => retry(item)}
                replySource={item.replyTo ? all[item.replyTo] : undefined}
              />
            );
          }}
        />

        {typing ? (
          <View style={{ paddingHorizontal: 16, paddingBottom: 6 }}>
            <View style={{ alignSelf: 'flex-start', flexDirection: 'row', gap: 5, paddingVertical: 14, paddingHorizontal: 16, borderRadius: 20, borderBottomLeftRadius: 6, backgroundColor: c.bubbleIn }} accessibilityLabel={`${peer.username} is typing`}>
              {[0.5, 0.75, 1].map((o, i) => <View key={i} style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: c.muted, opacity: o }} />)}
            </View>
          </View>
        ) : null}

        {err ? (
          <Pressable onPress={() => setErr(null)} style={{ marginHorizontal: 16, marginBottom: 8, padding: 12, borderRadius: 12, backgroundColor: c.dangerSoft }}>
            <T variant="small" color={c.danger}>{err}</T>
          </Pressable>
        ) : null}

        {/* reply preview */}
        {replyTo ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginHorizontal: 12, padding: 10, paddingLeft: 14, borderRadius: 12, backgroundColor: c.surface2 }}>
            <View style={{ width: 3, alignSelf: 'stretch', borderRadius: 2, backgroundColor: c.accent }} />
            <View style={{ flex: 1 }}>
              <T variant="label" color={c.accentText}>Replying to {replyTo.mine ? 'yourself' : peer.username}</T>
              <T variant="small" numberOfLines={1}>{replyTo.payload?.t === 'text' ? replyTo.payload.body : 'Photo'}</T>
            </View>
            <IconButton icon="close" label="Cancel reply" size={18} color={c.muted} onPress={() => setReplyTo(null)} />
          </View>
        ) : null}

        {/* composer */}
        <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 8, paddingHorizontal: 12, paddingVertical: 10, borderTopWidth: 1, borderTopColor: c.border }}>
          {mediaEnabled ? (
            sending ? (
              <View style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator color={c.accent} /></View>
            ) : (
              <IconButton icon="image-outline" label="Send a view-once photo" color={c.muted} onPress={pickPhoto} style={{ backgroundColor: c.surface }} />
            )
          ) : null}
          <View style={{ flex: 1, minHeight: 44, maxHeight: 140, borderRadius: 22, backgroundColor: c.surface, borderWidth: c.dark ? 0 : 1, borderColor: c.border, paddingHorizontal: 16, justifyContent: 'center' }}>
            <TextInput
              accessibilityLabel="Message"
              value={text}
              onChangeText={(t) => {
                setText(t);
                sendTyping(peerId, t.length > 0);
              }}
              placeholder={timer ? `Message · vanishes ${timerShort(timer)} after seen` : 'Message · vanishes once seen'}
              placeholderTextColor={c.faint}
              multiline
              onKeyPress={(e: any) => {
                if (isWeb && e.nativeEvent.key === 'Enter' && !e.nativeEvent.shiftKey) {
                  e.preventDefault?.();
                  send();
                }
              }}
              style={[{ color: c.text, fontFamily: fonts.regular, fontSize: 15, paddingVertical: 11, maxHeight: 130 }, isWeb ? ({ outlineStyle: 'none' } as any) : null]}
            />
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Send"
            disabled={!text.trim()}
            onPress={() => {
              tap();
              send();
            }}
            style={({ pressed }) => ({ width: 44, height: 44, borderRadius: 22, backgroundColor: c.accent, alignItems: 'center', justifyContent: 'center', opacity: text.trim() ? (pressed ? 0.8 : 1) : 0.4 })}
          >
            <Ionicons name="arrow-up" size={22} color={c.onAccent} />
          </Pressable>
        </View>
      </KeyboardAvoidingView>

      {/* long-press menu */}
      <Sheet visible={!!menuFor} onClose={() => setMenuFor(null)}>
        {menuFor && !menuFor.id.startsWith('local:') && (menuFor.kind === 'text' || menuFor.kind === 'photo') ? (
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 8 }}>
            {REACTIONS.map((e) => (
              <Pressable
                key={e}
                accessibilityLabel={`React ${e}`}
                onPress={() => {
                  tap();
                  react(menuFor, e);
                  setMenuFor(null);
                }}
                style={({ pressed }) => ({ width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', backgroundColor: menuFor.reactions[me.id] === e ? c.accentSoft : pressed ? c.surface2 : 'transparent' })}
              >
                <T style={{ fontSize: 26 }}>{e}</T>
              </Pressable>
            ))}
          </View>
        ) : null}
        {menuFor && (menuFor.kind === 'text' || menuFor.kind === 'photo') ? (
          <Row icon="arrow-undo-outline" label="Reply" onPress={() => { setReplyTo(menuFor); setMenuFor(null); }} />
        ) : null}
        {menuFor?.payload?.t === 'text' ? (
          <Row icon="copy-outline" label="Copy text" onPress={() => { Clipboard.setStringAsync((menuFor.payload as any).body); setMenuFor(null); }} />
        ) : null}
        {menuFor?.status === 'failed' ? <Row icon="refresh" label="Try sending again" onPress={() => { retry(menuFor); setMenuFor(null); }} /> : null}
        {menuFor?.mine && menuFor.kind !== 'screenshot' ? (
          <Row icon="trash-outline" label="Delete for everyone" danger onPress={() => { unsend(menuFor); setMenuFor(null); }} />
        ) : null}
        {menuFor && !menuFor.mine && menuFor.kind === 'text' ? (
          <Row icon="flag-outline" label="Report this message" danger onPress={() => { setReportMsg(menuFor); setMenuFor(null); setSheet('report'); }} />
        ) : null}
        {menuFor ? <T variant="small" style={{ textAlign: 'center', marginTop: 6 }}>{clock(menuFor.createdAt)}</T> : null}
      </Sheet>

      {/* timer */}
      <Sheet visible={sheet === 'timer'} onClose={() => setSheet(null)} title="Messages you send vanish…">
        {TIMER_OPTIONS.map((o) => (
          <Pressable
            key={String(o.value)}
            accessibilityRole="radio"
            accessibilityState={{ checked: timer === o.value }}
            onPress={() => {
              tap();
              setChatTimer(peerId, o.value);
              setSheet(null);
            }}
            style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 50 }}
          >
            <T style={{ fontFamily: timer === o.value ? fonts.semibold : fonts.regular }}>{o.label}</T>
            {timer === o.value ? <Ionicons name="checkmark" size={20} color={c.accent} /> : null}
          </Pressable>
        ))}
        <T variant="small" style={{ marginTop: 6 }}>Unopened messages vanish after 7 days.</T>
      </Sheet>

      {/* more */}
      <Sheet visible={sheet === 'more'} onClose={() => setSheet(null)} title={`@${peer.username}`}>
        <Row icon="shield-checkmark-outline" label="Verify safety code" sub="Make sure nobody is in the middle" onPress={() => setSheet('safety')} />
        <Row icon="flag-outline" label="Report" onPress={() => { setReportMsg(null); setSheet('report'); }} />
        <Row icon="person-remove-outline" label="Remove from chats" onPress={async () => { setSheet(null); await removeContact(peerId); router.replace('/chats'); }} />
        <Row icon="ban-outline" label={`Block @${peer.username}`} danger onPress={async () => { setSheet(null); await blockUser(peerId); router.replace('/chats'); }} />
      </Sheet>

      {/* safety code */}
      <Sheet visible={sheet === 'safety'} onClose={() => setSheet(null)} title="Safety code">
        <T variant="small">Compare this code with @{peer.username} in person or on a call. If it matches on both phones, your chat is private.</T>
        <View style={{ padding: 18, borderRadius: 14, backgroundColor: c.surface2, marginVertical: 10 }}>
          <T style={{ fontFamily: fonts.displayMedium, fontSize: 24, letterSpacing: 2, textAlign: 'center' }} selectable>
            {peer.publicKey ? safetyCode(keys.publicKey, peer.publicKey) : '—'}
          </T>
        </View>
        <T variant="small">The code changes if either of you logs in on a new device.</T>
      </Sheet>

      {/* report */}
      <ReportSheet
        visible={sheet === 'report'}
        onClose={() => setSheet(null)}
        username={peer.username}
        message={reportMsg}
        onSubmit={async (reason, attach, alsoBlock) => {
          const evidence = attach && reportMsg?.payload?.t === 'text' ? reportMsg.payload.body : undefined;
          await report(peerId, reason, evidence, alsoBlock);
          setSheet(null);
          if (alsoBlock) router.replace('/chats');
        }}
      />

      {/* view-once photo */}
      <Modal visible={!!viewer} animationType="fade" onRequestClose={closeViewer}>
        <SafeAreaView style={{ flex: 1, backgroundColor: '#000' }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 8 }}>
            <T variant="small" color="#C9C8CF" style={{ marginLeft: 12 }}>View once · vanishes when you close it</T>
            <IconButton icon="close" label="Close photo" color="#FFFFFF" onPress={closeViewer} />
          </View>
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            {viewer?.loading ? <ActivityIndicator color="#FFFFFF" /> : null}
            {viewer?.error ? <T color="#FFFFFF">{viewer.error}</T> : null}
            {viewer?.uri ? <Image source={{ uri: viewer.uri }} style={{ width: '100%', height: '100%' }} resizeMode="contain" accessibilityLabel="View-once photo" /> : null}
          </View>
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

function MessageItem({
  m, meId, peerName, showMeta, onLongPress, onOpenPhoto, onRetry, replySource,
}: {
  m: Msg; meId: string; peerName: string; showMeta: boolean; onLongPress: () => void; onOpenPhoto: () => void; onRetry: () => void; replySource?: Msg;
}) {
  const { c } = useTheme();

  if (m.kind === 'screenshot' || m.kind === 'recording') {
    const who = m.mine ? 'You' : peerName;
    const what = m.kind === 'screenshot' ? 'tried to take a screenshot' : 'tried to record the screen';
    return (
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginVertical: 8 }} accessibilityRole="text">
        <View style={{ flex: 1, height: 1, backgroundColor: c.warn + '44' }} />
        <Ionicons name="camera-outline" size={14} color={c.warn} />
        <T variant="small" style={{ fontFamily: fonts.medium, fontSize: 12 }} color={c.warn}>{who} {what} · {clock(m.createdAt)}</T>
        <View style={{ flex: 1, height: 1, backgroundColor: c.warn + '44' }} />
      </View>
    );
  }

  const mine = m.mine;
  const reactions = Object.values(m.reactions);
  const status =
    m.status === 'sending' ? 'Sending…'
      : m.status === 'failed' ? 'Not sent · tap to retry'
        : m.vanishing ? 'Seen · vanishing'
          : m.status === 'seen' && m.timer && m.expiresAt ? `Seen · vanishes in ${countdown(m.expiresAt)}`
            : m.status === 'seen' ? 'Seen'
              : m.status === 'delivered' ? 'Delivered' : 'Sent';

  const incomingTimed = !mine && m.timer && m.expiresAt && m.seenAt;

  const body = m.payload?.t === 'photo' ? (
    <Pressable
      onPress={mine ? undefined : onOpenPhoto}
      onLongPress={onLongPress}
      accessibilityRole={mine ? 'text' : 'button'}
      accessibilityLabel={mine ? 'View-once photo you sent' : 'View-once photo. Tap to open'}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, width: 230, borderRadius: 20, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface2, ...(mine ? { borderBottomRightRadius: 6 } : { borderBottomLeftRadius: 6 }) }}
    >
      <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: c.accentSoft, alignItems: 'center', justifyContent: 'center' }}>
        <Ionicons name="image-outline" size={20} color={c.accentText} />
      </View>
      <View style={{ flex: 1 }}>
        <T style={{ fontFamily: fonts.semibold, fontSize: 14 }}>Photo · view once</T>
        <T variant="small" style={{ fontSize: 12 }}>{mine ? 'Gone once they open it' : 'Tap to open'}</T>
      </View>
    </Pressable>
  ) : (
    <Pressable
      onLongPress={onLongPress}
      onPress={m.status === 'failed' ? onRetry : undefined}
      delayLongPress={300}
      style={{
        maxWidth: '80%', paddingVertical: 10, paddingHorizontal: 14, borderRadius: 20,
        backgroundColor: mine ? c.bubbleOut : c.bubbleIn,
        borderWidth: !mine && !c.dark ? 1 : 0, borderColor: c.border,
        ...(mine ? { borderBottomRightRadius: 6 } : { borderBottomLeftRadius: 6 }),
      }}
    >
      {m.payload?.t === 'text' && m.payload.replyText ? (
        <View style={{ borderLeftWidth: 3, borderLeftColor: mine ? c.onBubbleOut + '88' : c.accent, paddingLeft: 8, marginBottom: 6, opacity: 0.85 }}>
          <T variant="small" numberOfLines={2} color={mine ? c.onBubbleOut : c.muted} style={{ fontSize: 13 }}>
            {replySource?.payload?.t === 'text' ? replySource.payload.body : m.payload.replyText}
          </T>
        </View>
      ) : null}
      <T color={mine ? c.onBubbleOut : c.text} style={{ fontSize: 15, lineHeight: 21 }}>
        {m.payload?.t === 'text' ? m.payload.body : 'Message could not be decrypted (sent to an older device).'}
      </T>
    </Pressable>
  );

  return (
    <View style={{ alignItems: mine ? 'flex-end' : 'flex-start', gap: 4, opacity: m.vanishing ? 0.4 : 1 }}>
      {body}
      {reactions.length ? (
        <View style={{ flexDirection: 'row', gap: 2, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 12, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, marginTop: -8 }}>
          {reactions.map((r, i) => <T key={i} style={{ fontSize: 14 }}>{r}</T>)}
        </View>
      ) : null}
      {mine && (showMeta || m.status === 'failed' || m.vanishing) ? (
        <T variant="small" style={{ fontSize: 11 }} color={m.status === 'failed' ? c.danger : c.faint}>
          {status}{m.status !== 'sending' && m.status !== 'failed' ? ` · ${clock(m.createdAt)}` : ''}
        </T>
      ) : null}
      {!mine && (showMeta || incomingTimed) ? (
        <T variant="small" style={{ fontSize: 11 }} color={c.faint}>
          {clock(m.createdAt)}{incomingTimed ? ` · vanishes in ${countdown(m.expiresAt)}` : ''}
        </T>
      ) : null}
    </View>
  );
}

function ReportSheet({
  visible, onClose, username, message, onSubmit,
}: {
  visible: boolean; onClose: () => void; username: string; message: Msg | null;
  onSubmit: (reason: string, attach: boolean, block: boolean) => Promise<void>;
}) {
  const { c } = useTheme();
  const [reason, setReason] = useState<string | null>(null);
  const [attach, setAttach] = useState(true);
  const [block, setBlock] = useState(true);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (visible) {
      setReason(null);
      setAttach(true);
      setBlock(true);
    }
  }, [visible]);
  const check = (on: boolean, set: (v: boolean) => void, label: string) => (
    <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: on }} onPress={() => set(!on)} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 44 }}>
      <View style={{ width: 22, height: 22, borderRadius: 6, borderWidth: 1.5, borderColor: on ? c.accent : c.faint, backgroundColor: on ? c.accent : 'transparent', alignItems: 'center', justifyContent: 'center' }}>
        {on ? <Ionicons name="checkmark" size={16} color={c.onAccent} /> : null}
      </View>
      <T style={{ flex: 1 }}>{label}</T>
    </Pressable>
  );
  return (
    <Sheet visible={visible} onClose={onClose} title={`Report @${username}`}>
      {REPORT_REASONS.map((r) => (
        <Pressable key={r} accessibilityRole="radio" accessibilityState={{ checked: reason === r }} onPress={() => setReason(r)} style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', minHeight: 46 }}>
          <T style={{ fontFamily: reason === r ? fonts.semibold : fonts.regular }}>{r}</T>
          {reason === r ? <Ionicons name="checkmark" size={20} color={c.accent} /> : null}
        </Pressable>
      ))}
      <View style={{ height: 1, backgroundColor: c.border, marginVertical: 6 }} />
      {message?.payload?.t === 'text' ? check(attach, setAttach, 'Attach this message so moderators can see it') : null}
      {check(block, setBlock, `Also block @${username}`)}
      <Button title="Send report" onPress={async () => { setBusy(true); try { await onSubmit(reason!, attach, block); } finally { setBusy(false); } }} disabled={!reason} loading={busy} style={{ marginTop: 8 }} />
    </Sheet>
  );
}
