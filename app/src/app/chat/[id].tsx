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
  Msg, peerOf, useStore, markSeen, purgeRead, setOpenChat, deleteChat, canEdit, editMessage, sendText, sendPhoto, fetchPhoto, unsend, react, retry, sendTyping, sendTypingText, markPhotoViewed, avatarUrl,
  reportScreenshot, setChatTimer, blockUser, report, removeContact, getState, decodeBase64,
} from '@/lib/store';
import { placeCall } from '@/lib/call';
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
  const synced = useStore((s) => s.synced);
  const typingText = useStore((s) => s.typingText[peerId] || '');
  const timer = useStore((s) => s.timers[peerId] ?? null);
  const mediaEnabled = useStore((s) => s.config?.mediaEnabled);

  const [text, setText] = useState('');
  const [replyTo, setReplyTo] = useState<Msg | null>(null);
  const [menuFor, setMenuFor] = useState<Msg | null>(null);
  const [sheet, setSheet] = useState<null | 'timer' | 'more' | 'report' | 'safety' | 'delete'>(null);
  const [reportMsg, setReportMsg] = useState<Msg | null>(null);
  const [viewer, setViewer] = useState<{ msg: Msg; uri: string | null; loading: boolean; error?: string; progress?: number; rendered?: boolean } | null>(null);
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<Msg | null>(null);
  const [, tick] = useState(0);
  const appActive = useRef(AppState.currentState === 'active');
  const viewerOpen = useRef(false); // while the full-screen photo viewer covers the chat, don't mark messages seen
  const inputRef = useRef<any>(null); // keep focus after sending so the user can keep typing

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
    if (!appActive.current || viewerOpen.current) return;
    const ids = getState()
      ? Object.values(getState().messages)
          .filter((m) => peerOf(m) === peerId && !m.mine && m.kind === 'text' && !!m.payload && !m.seenAt && !m.readLocally)
          .map((m) => m.id)
      : [];
    if (ids.length) markSeen(ids);
  }, [peerId]);

  useEffect(() => {
    seeVisible();
  }, [list.length, seeVisible]);

  // The photo viewer is a full-screen overlay: pause seen-marking while it's up, resume (and catch up) on close.
  useEffect(() => {
    viewerOpen.current = !!viewer;
    if (!viewer) seeVisible();
  }, [viewer, seeVisible]);

  // Revoke the decrypted blob: URL if we leave the chat with the viewer still open.
  useEffect(() => () => {
    const u = viewer?.uri;
    if (u && u.startsWith('blob:')) URL.revokeObjectURL(u);
  }, [viewer?.uri]);

  useEffect(() => {
    setOpenChat(peerId);
    const sub = AppState.addEventListener('change', (s) => {
      appActive.current = s === 'active';
      if (s === 'active') seeVisible();
    });
    return () => {
      sub.remove();
      setOpenChat(null);
      purgeRead(peerId); // leaving the chat: messages that were seen are gone (both sides)
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

  if (!me || !keys) {
    // Never render a blank (black) screen while the session/keys are still loading — show a spinner so
    // the chat is obviously "loading" rather than broken.
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: c.bg, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={c.accent} />
      </SafeAreaView>
    );
  }
  if (!peer) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: c.bg, alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24 }}>
        {!synced ? (
          <ActivityIndicator color={c.accent} />
        ) : (
          <>
            <T variant="heading">Chat not available</T>
            <T variant="small" style={{ textAlign: 'center' }}>You're no longer connected with this person.</T>
            <Button title="Back to chats" small onPress={() => router.replace('/chats')} />
          </>
        )}
      </SafeAreaView>
    );
  }

  const send = () => {
    if (!text.trim()) return;
    if (editing) {
      const m = editing;
      setEditing(null);
      setText('');
      sendTyping(peerId, false);
      editMessage(m, text).catch((e) => setErr(e.message));
      return;
    }
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
      // ~1280px JPEG is sharp on any phone and only ~150–300 KB to store and send.
      const a = res.assets[0];
      if ((a.width || 0) >= (a.height || 0) && (a.width || 0) > 1280) ctx.resize({ width: 1280 });
      else if ((a.height || 0) > 1280) ctx.resize({ height: 1280 });
      const img = await ctx.renderAsync();
      const out = await img.saveAsync({ format: SaveFormat.JPEG, compress: 0.65, base64: true });
      await sendPhoto(peerId, decodeBase64(out.base64!), out.width, out.height);
    } catch (e: any) {
      setErr(e.message || 'Could not send photo');
    } finally {
      setSending(false);
    }
  };

  const openPhoto = async (m: Msg) => {
    if (m.mine) return;
    setViewer({ msg: m, uri: null, loading: true, progress: 0 });
    try {
      const bytes = await fetchPhoto(m, (p) =>
        setViewer((v) => (v && v.msg.id === m.id && v.loading ? { ...v, progress: p } : v)));
      if (!bytes) throw new Error('This photo is gone');
      // On web, hand the <img> a blob: URL we can revoke on close, so the decrypted image
      // can't be re-opened from that URL afterwards (a data: URL would linger). On native a
      // data: URI is fine. Either way it only ever lives in this page's memory, never on disk.
      const uri = isWeb
        ? URL.createObjectURL(new Blob([bytes as any], { type: 'image/jpeg' }))
        : `data:image/jpeg;base64,${encodeBase64(bytes)}`;
      markSeen([m.id]); // tell the sender it's been opened the moment it opens, not on close
      setViewer({ msg: m, uri, loading: false });
    } catch (e: any) {
      markPhotoViewed(m.id);
      setViewer({ msg: m, uri: null, loading: false, error: e.message });
    }
  };

  const closeViewer = () => {
    if (viewer?.uri && viewer.uri.startsWith('blob:')) URL.revokeObjectURL(viewer.uri);
    if (viewer?.msg) markPhotoViewed(viewer.msg.id); // mark it opened here, no longer tappable
    setViewer(null);
  };

  const sub = typing ? 'typing…' : lastSeenText(peer.online, peer.lastSeen);

  return (
    <SafeAreaView edges={['top', 'bottom']} style={{ flex: 1, backgroundColor: c.bg }}>
      <KeyboardAvoidingView style={{ flex: 1, width: '100%', maxWidth: 820, alignSelf: 'center' }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        {/* header */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 6, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: c.border }}>
          <IconButton icon="chevron-back" label="Back to chats" onPress={() => { if (router.canGoBack()) router.back(); else router.replace('/chats'); }} />
          <Avatar name={peer.username} size={40} online={peer.online} uri={avatarUrl(peer)} />
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
          <IconButton icon="call-outline" label={`Voice call ${peer.displayName || peer.username}`} color={c.accentText} onPress={() => placeCall(peer)} />
          <IconButton icon="ellipsis-vertical" label="More options" color={c.muted} onPress={() => setSheet('more')} />
        </View>

        {/* messages */}
        <FlatList
          inverted
          data={list}
          keyExtractor={(m) => m.id}
          contentContainerStyle={{ padding: 16, gap: 8 }}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          ListFooterComponent={
            // Inverted list: this sits at the very top of the conversation and scrolls up out of view
            // as messages fill in — exactly like a chat's "start of conversation" notice. Compact + centered.
            <View style={{ alignSelf: 'center', alignItems: 'center', gap: 4, paddingVertical: 8, paddingHorizontal: 14, borderRadius: 12, backgroundColor: c.surface2, marginTop: 2, marginBottom: 12, maxWidth: 420 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Ionicons name="lock-closed" size={12} color={c.accentText} />
                <T variant="label" color={c.accentText} style={{ fontSize: 12 }}>End-to-end encrypted</T>
              </View>
              <T variant="small" color={c.muted} style={{ fontSize: 11.5, lineHeight: 16, textAlign: 'center' }}>
                Private, just between the two of you. Messages disappear once seen and can’t be recovered — no permanent history.{isWeb ? ' Browsers can’t block screenshots.' : ' Screenshots are blocked.'} Read attentively, think before you send, and treat every conversation with care.
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
            <View style={{ alignSelf: 'flex-start', maxWidth: '82%', paddingVertical: typingText ? 10 : 14, paddingHorizontal: 16, borderRadius: 20, borderBottomLeftRadius: 6, backgroundColor: c.bubbleIn }} accessibilityLabel={typingText ? `${peer.username} is typing: ${typingText}` : `${peer.username} is typing`}>
              {typingText ? (
                <T style={{ fontSize: 15, color: c.muted, fontStyle: 'italic' }}>{typingText}</T>
              ) : (
                <View style={{ flexDirection: 'row', gap: 5 }}>
                  {[0.5, 0.75, 1].map((o, i) => <View key={i} style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: c.muted, opacity: o }} />)}
                </View>
              )}
            </View>
          </View>
        ) : null}

        {err ? (
          <View style={{ marginHorizontal: 16, marginBottom: 8, padding: 12, borderRadius: 12, backgroundColor: c.dangerSoft, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <T variant="small" color={c.danger} style={{ flex: 1 }}>{err}</T>
            <Pressable
              onPress={() => setErr(null)}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Dismiss"
              style={{ width: 24, height: 24, borderRadius: 12, borderWidth: 1.5, borderColor: c.danger, alignItems: 'center', justifyContent: 'center' }}
            >
              <Ionicons name="close" size={14} color={c.danger} />
            </Pressable>
          </View>
        ) : null}

        {/* editing bar */}
        {editing ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginHorizontal: 12, padding: 10, paddingLeft: 14, borderRadius: 12, backgroundColor: c.surface2 }}>
            <Ionicons name="create-outline" size={18} color={c.accentText} />
            <View style={{ flex: 1 }}>
              <T variant="label" color={c.accentText}>Editing message</T>
              <T variant="small" numberOfLines={1}>{editing.payload?.t === 'text' ? editing.payload.body : ''}</T>
            </View>
            <IconButton icon="close" label="Cancel editing" size={18} color={c.muted} onPress={() => { setEditing(null); setText(''); }} />
          </View>
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
              ref={inputRef}
              accessibilityLabel="Message"
              value={text}
              onChangeText={(t) => {
                setText(t);
                if (!editing) {
                  sendTyping(peerId, t.length > 0);
                  sendTypingText(peerId, t);
                }
              }}
              placeholder={timer ? `Message · ${timerShort(timer)}` : 'Message'}
              placeholderTextColor={c.faint}
              multiline
              blurOnSubmit={false}
              onKeyPress={(e: any) => {
                if (isWeb && e.nativeEvent.key === 'Enter' && !e.nativeEvent.shiftKey) {
                  e.preventDefault?.();
                  send();
                  inputRef.current?.focus(); // keep typing without re-tapping
                }
              }}
              style={[{ color: c.text, fontFamily: fonts.regular, fontSize: 16, paddingVertical: 11, maxHeight: 130 }, isWeb ? ({ outlineStyle: 'none' } as any) : null]}
            />
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Send"
            disabled={!text.trim()}
            // Don't let the button steal focus from the input (web), so the keyboard stays open.
            onStartShouldSetResponder={() => true}
            {...(isWeb ? { onMouseDown: (e: any) => e.preventDefault?.() } : {})}
            onPress={() => {
              tap();
              send();
              inputRef.current?.focus(); // keep focus so the keyboard stays up for the next message
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
        {menuFor && canEdit(menuFor) ? (
          <Row icon="create-outline" label="Edit" onPress={() => { setReplyTo(null); sendTyping(peerId, false); sendTypingText(peerId, ''); setEditing(menuFor); setText((menuFor.payload as any).body); setMenuFor(null); }} />
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
        <Row icon="trash-outline" label="Delete chat" sub="Clears all messages for both of you" danger onPress={() => setSheet('delete')} />
        <Row icon="ban-outline" label={`Block @${peer.username}`} danger onPress={async () => { setSheet(null); await blockUser(peerId); router.replace('/chats'); }} />
      </Sheet>

      {/* delete chat */}
      <Sheet visible={sheet === 'delete'} onClose={() => setSheet(null)} title="Delete this chat?">
        <T variant="small">Every message in this chat will be deleted for you and @{peer.username}. This can't be undone. You'll still be connected.</T>
        <View style={{ gap: 10, marginTop: 14 }}>
          <Button
            title="Delete for both"
            variant="danger"
            onPress={async () => {
              setSheet(null);
              try {
                await deleteChat(peerId);
              } catch (e: any) {
                setErr(e.message || 'Could not delete chat');
              }
            }}
          />
          <Button title="Cancel" variant="secondary" onPress={() => setSheet(null)} />
        </View>
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
          {/* Busy until the photo has actually painted — covers both the download and the decode/render
              gap, so a big image never shows as a blank black screen. */}
          {(() => {
            const downloading = !!viewer?.loading;
            const decoding = !!viewer?.uri && !viewer?.rendered && !viewer?.error; // bytes in hand, not painted yet
            const busy = downloading || decoding;
            const pct = Math.round((viewer?.progress ?? 0) * 100);
            return (
              <>
                {busy ? (
                  <View style={{ height: 3, backgroundColor: 'rgba(255,255,255,0.15)' }}>
                    <View style={{ height: 3, width: downloading ? `${pct}%` : '100%', backgroundColor: c.accent }} />
                  </View>
                ) : <View style={{ height: 3 }} />}
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 8 }}>
                  <T variant="small" color="#C9C8CF" style={{ marginLeft: 12 }}>
                    {downloading ? `Loading… ${pct}%` : decoding ? 'Loading… 100%' : 'View once · vanishes when you close it'}
                  </T>
                  <IconButton icon="close" label="Close photo" color="#FFFFFF" onPress={closeViewer} />
                </View>
                <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                  {busy ? <ActivityIndicator color="#FFFFFF" /> : null}
                  {viewer?.error ? <T color="#FFFFFF">{viewer.error}</T> : null}
                  {viewer?.uri && !viewer?.error ? (
                    <Image
                      source={{ uri: viewer.uri }}
                      style={{ position: 'absolute', width: '100%', height: '100%', opacity: viewer.rendered ? 1 : 0 }}
                      resizeMode="contain"
                      accessibilityLabel="View-once photo"
                      onLoad={() => setViewer((v) => (v && v.uri === viewer.uri ? { ...v, rendered: true } : v))}
                      onError={() => setViewer((v) => (v && v.uri === viewer.uri ? { ...v, error: "Couldn't display this photo", rendered: true } : v))}
                    />
                  ) : null}
                </View>
              </>
            );
          })()}
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
  // WhatsApp-style ticks: one grey = sent, two grey = delivered, two coloured = read.
  const tick =
    m.status === 'sending' ? <Ionicons name="time-outline" size={13} color={c.faint} />
      : m.status === 'seen' || m.vanishing ? <Ionicons name="checkmark-done" size={16} color={c.accentText} />
        : m.status === 'delivered' ? <Ionicons name="checkmark-done" size={16} color={c.faint} />
          : m.status === 'sent' ? <Ionicons name="checkmark" size={15} color={c.faint} />
            : null;

  const incomingTimed = !mine && m.timer && m.expiresAt && m.seenAt;

  const photoViewed = !mine && !!m.readLocally;
  const mineViewed = mine && m.status === 'seen'; // they opened the view-once photo I sent — it's gone now
  const photoGone = photoViewed || mineViewed;
  const body = m.payload?.t === 'photo' ? (
    <Pressable
      onPress={mine || photoViewed ? undefined : onOpenPhoto}
      onLongPress={onLongPress}
      accessibilityRole={mine || photoViewed ? 'text' : 'button'}
      accessibilityLabel={mineViewed ? 'View-once photo you sent, now opened and gone' : mine ? 'View-once photo you sent' : photoViewed ? 'Photo already opened and gone' : 'View-once photo. Tap to open'}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, width: 230, borderRadius: 20, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface2, opacity: photoGone ? 0.6 : 1, ...(mine ? { borderBottomRightRadius: 6 } : { borderBottomLeftRadius: 6 }) }}
    >
      <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: c.accentSoft, alignItems: 'center', justifyContent: 'center' }}>
        <Ionicons name={photoGone ? 'eye-off-outline' : 'image-outline'} size={20} color={c.accentText} />
      </View>
      <View style={{ flex: 1 }}>
        <T style={{ fontFamily: fonts.semibold, fontSize: 14 }}>Photo · view once</T>
        <T variant="small" style={{ fontSize: 12 }}>{mine ? (mineViewed ? 'Opened · no longer available' : 'Gone once they open it') : photoViewed ? 'Opened · no longer available' : 'Tap to open'}</T>
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
    <View style={{ alignItems: mine ? 'flex-end' : 'flex-start', gap: 4, opacity: m.vanishing ? 0.75 : 1 }}>
      {body}
      {reactions.length ? (
        <View style={{ flexDirection: 'row', gap: 2, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 12, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, marginTop: -8 }}>
          {reactions.map((r, i) => <T key={i} style={{ fontSize: 14 }}>{r}</T>)}
        </View>
      ) : null}
      {mine && (showMeta || m.status === 'failed' || m.vanishing || m.editedAt) ? (
        m.status === 'failed' ? (
          <T variant="small" style={{ fontSize: 11 }} color={c.danger}>Not sent · tap to retry</T>
        ) : (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <T variant="small" style={{ fontSize: 11 }} color={c.faint}>
              {m.editedAt ? 'Edited · ' : ''}{m.status === 'sending' ? 'Sending…' : clock(m.createdAt)}{m.status === 'seen' && m.timer && m.expiresAt ? ` · ${countdown(m.expiresAt)}` : ''}
            </T>
            {tick}
          </View>
        )
      ) : null}
      {!mine && (showMeta || incomingTimed || m.editedAt) ? (
        <T variant="small" style={{ fontSize: 11 }} color={c.faint}>
          {m.editedAt ? 'Edited · ' : ''}{clock(m.createdAt)}{incomingTimed ? ` · vanishes in ${countdown(m.expiresAt)}` : ''}
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
