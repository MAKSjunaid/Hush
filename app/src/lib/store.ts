import { useSyncExternalStore } from 'react';
import { io, Socket } from 'socket.io-client';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import { api, apiCached, clearApiCache, setApiToken } from './api';
import { API_URL } from './config';
import { getSecret, setSecret } from './secure';
import {
  KeyPair, Payload, newKeyPair, saveKeyPair, loadKeyPair, clearKeyPair, seal, open, sealBytes, decodeBase64,
  wrapSecret, unwrapSecret,
} from './crypto';

// ---------- types ----------
export type Settings = {
  showOnline?: boolean;
  showLastSeen?: boolean;
  typing?: boolean;
  discoverable?: boolean;
  notifications?: boolean;
};
export type User = { id: string; username: string; displayName: string; publicKey: string | null; avatarAt?: string | null };
export type Me = User & { settings: Settings; usernameChangedAt?: string | null };
export type Peer = User & { online?: boolean; lastSeen?: string | null };
export type Conn = { connectionId: string; since: string; user: Peer };

export type Msg = {
  id: string;
  clientId?: string | null;
  from: string;
  to: string;
  kind: 'text' | 'photo' | 'screenshot' | 'recording';
  mine: boolean;
  payload: Payload | null;
  mediaKey?: string | null;
  replyTo?: string | null;
  viewOnce?: boolean;
  timer: number | null;
  createdAt: string;
  deliveredAt?: string | null;
  seenAt?: string | null;
  expiresAt?: string | null;
  status: 'sending' | 'sent' | 'delivered' | 'seen' | 'failed';
  editedAt?: string | null;
  vanishing?: boolean; // sender side: seen, fading out
  readLocally?: boolean; // reader side: already gone from server, shown until you leave the chat
  reactions: Record<string, string>;
  raw?: any;
};

export type AppConfig = {
  maintenance: boolean;
  announcement: { text: string; at: string } | null;
  minAppVersion: string;
  latestAppVersion: string;
  apkUrl: string | null;
  iosUrl: string | null;
  mediaEnabled: boolean;
  editWindowMinutes?: number;
  vapidPublicKey?: string | null;
  iceServers?: RTCIceServer[];
};

type State = {
  ready: boolean;
  synced: boolean; // first contacts fetch done — until then, don't flash empty states
  token: string | null;
  me: Me | null;
  keys: KeyPair | null;
  contacts: Conn[];
  incoming: Conn[];
  outgoing: Conn[];
  messages: Record<string, Msg>;
  typing: Record<string, number>;
  typingText: Record<string, string>; // peerId -> what they're currently typing (live preview)
  connected: boolean;
  config: AppConfig | null;
  announcementDismissed: string | null;
  endedReason: string | null;
  pendingRecoveryKey: string | null;
  timers: Record<string, number | null>; // per-chat vanish timer (seconds) – null = on seen
};

let state: State = {
  ready: false,
  synced: false,
  token: null,
  me: null,
  keys: null,
  contacts: [],
  incoming: [],
  outgoing: [],
  messages: {},
  typing: {},
  typingText: {},
  connected: false,
  config: null,
  announcementDismissed: null,
  endedReason: null,
  pendingRecoveryKey: null,
  timers: {},
};

const listeners = new Set<() => void>();
function set(patch: Partial<State> | ((s: State) => Partial<State>)) {
  const p = typeof patch === 'function' ? patch(state) : patch;
  state = { ...state, ...p };
  listeners.forEach((l) => l());
}
export const getState = () => state;
export function useStore<T>(selector: (s: State) => T): T {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => selector(state),
    () => selector(state),
  );
}

// ---------- helpers ----------
export const peerOf = (m: Msg) => (m.mine ? m.to : m.from);

function decrypt(raw: any): Payload | null {
  const keys = state.keys;
  if (!keys || raw.kind === 'screenshot' || raw.kind === 'recording') return null;
  return raw.mine
    ? open(raw.ciphertext, raw.nonce, keys.publicKey, keys)
    : open(raw.ciphertext, raw.nonce, raw.senderPublicKey, keys);
}

function statusOf(raw: any): Msg['status'] {
  if (raw.seenAt) return 'seen';
  if (raw.deliveredAt) return 'delivered';
  return 'sent';
}

function toMsg(raw: any, prev?: Msg): Msg {
  return {
    id: raw.id,
    clientId: raw.clientId,
    from: raw.from,
    to: raw.to,
    kind: raw.kind,
    mine: raw.mine,
    // Re-decrypt only when the message was edited since we last saw it.
    payload: prev?.payload && (prev.editedAt ?? null) === (raw.editedAt ?? null) ? prev.payload : decrypt(raw),
    editedAt: raw.editedAt ?? null,
    mediaKey: raw.mediaKey,
    replyTo: raw.replyTo,
    viewOnce: raw.viewOnce,
    timer: raw.timer ?? null,
    createdAt: raw.createdAt,
    deliveredAt: raw.deliveredAt,
    seenAt: raw.seenAt,
    expiresAt: raw.expiresAt,
    status: statusOf(raw),
    reactions: prev?.reactions ?? {},
  };
}

function upsertRaw(raw: any) {
  set((s) => {
    const messages = { ...s.messages };
    // Replace the optimistic local copy (same clientId) with the server's.
    let prev: Msg | undefined = messages[raw.id];
    if (!prev && raw.mine && raw.clientId) {
      const localId = `local:${raw.clientId}`;
      prev = messages[localId];
      delete messages[localId];
    }
    messages[raw.id] = toMsg(raw, prev);
    return { messages };
  });
}

function removeIds(ids: string[]) {
  if (!ids.length) return;
  set((s) => {
    const messages = { ...s.messages };
    ids.forEach((id) => delete messages[id]);
    return { messages };
  });
}

function patchMsg(id: string, patch: Partial<Msg>) {
  set((s) => (s.messages[id] ? { messages: { ...s.messages, [id]: { ...s.messages[id], ...patch } } } : {}));
}

// ---------- socket ----------
let socket: Socket | null = null;
const typingTimers: Record<string, ReturnType<typeof setTimeout>> = {};

function connectSocket() {
  socket?.disconnect();
  if (!state.token) return;
  socket = io(API_URL, { auth: { token: state.token }, transports: ['websocket'], reconnectionDelayMax: 8000 });

  socket.on('connect', async () => {
    set({ connected: true });
    await Promise.all([syncMessages(), refreshConnections()]).catch(() => {});
    flushQueue();
  });
  socket.on('disconnect', () => set({ connected: false }));
  socket.on('connect_error', (err) => {
    set({ connected: false });
    if (err.message === 'unauthorized') endSession('Please log in again.');
    if (err.message.startsWith('account_')) endSession(`Your account is ${err.message.slice(8)}.`);
  });

  socket.on('message', (raw) => upsertRaw(raw));
  socket.on('delivered', ({ id }) => {
    const m = state.messages[id];
    if (m && m.status === 'sent') patchMsg(id, { status: 'delivered' });
  });
  socket.on('seen', ({ id, vanishing, expiresAt }) => {
    if (vanishing) {
      // Gone from the server already, but stays on your screen until you leave this chat.
      patchMsg(id, { status: 'seen', vanishing: true, readLocally: true });
    } else {
      patchMsg(id, { status: 'seen', seenAt: new Date().toISOString(), expiresAt });
    }
  });
  socket.on('vanished', ({ ids }: { ids: string[] }) => {
    // Timer ran out. If that chat is open right now, keep showing it until you leave.
    const keep = ids.filter((id) => { const m = state.messages[id]; return m && openChat && peerOf(m) === openChat; });
    keep.forEach((id) => patchMsg(id, { vanishing: true, readLocally: true, expiresAt: null }));
    removeIds(ids.filter((id) => !keep.includes(id)));
  });
  // A message I already read (still on my screen) was corrected by the sender.
  socket.on('message_edited', ({ id, ciphertext, nonce, editedAt }: { id: string; ciphertext: string; nonce: string; editedAt: string }) => {
    const m = state.messages[id];
    const pk = m && contactById(m.from)?.publicKey;
    if (!m || m.mine || !pk) return;
    const payload = decrypt({ kind: 'text', mine: false, ciphertext, nonce, senderPublicKey: pk });
    if (payload) patchMsg(id, { payload, editedAt });
  });
  // The other person deleted the chat: it's gone here too, right away.
  socket.on('chat_cleared', ({ userId }: { userId: string }) => clearChatLocally(userId));
  socket.on('reaction', ({ id, userId, emoji }) => {
    const m = state.messages[id];
    if (!m) return;
    const reactions = { ...m.reactions };
    if (emoji) reactions[userId] = emoji;
    else delete reactions[userId];
    patchMsg(id, { reactions });
  });
  socket.on('typing', ({ from, on }) => {
    clearTimeout(typingTimers[from]);
    set((s) => {
      const typing = { ...s.typing };
      const typingText = { ...s.typingText };
      if (on) typing[from] = Date.now();
      else { delete typing[from]; delete typingText[from]; }
      return { typing, typingText };
    });
    if (on) typingTimers[from] = setTimeout(() => set((s) => {
      const typing = { ...s.typing };
      const typingText = { ...s.typingText };
      delete typing[from];
      delete typingText[from];
      return { typing, typingText };
    }), 6000);
  });
  // Live preview of what the other person is typing (encrypted, never stored).
  socket.on('typing_text', ({ from, ciphertext, nonce }) => {
    const keys = state.keys;
    const pk = contactById(from)?.publicKey;
    if (!keys || !pk) return;
    const payload = open(ciphertext, nonce, pk, keys);
    const body = payload?.t === 'text' ? payload.body : '';
    set((s) => (s.typing[from] !== undefined || body ? { typingText: { ...s.typingText, [from]: body } } : {}));
  });
  socket.on('presence', ({ userId, online, lastSeen }) => {
    set((s) => ({
      contacts: s.contacts.map((c) => (c.user.id === userId ? { ...c, user: { ...c.user, online, lastSeen } } : c)),
    }));
  });
  socket.on('connections', () => refreshConnections());
  socket.on('announcement', (a) => set((s) => ({ config: s.config ? { ...s.config, announcement: a } : s.config })));
  socket.on('session_replaced', () => endSession('You logged in on another device. HushChat works on one device at a time.'));
  socket.on('account_suspended', () => endSession('Your account has been suspended.'));
  socket.on('account_banned', () => endSession('Your account has been banned.'));
  socket.on('account_deleted', () => endSession(null));

  // Voice-call signaling. The heavy WebRTC engine is loaded lazily (only when a call happens) via ./call.
  const call = (fn: string, data: any) => import('./call').then((m) => (m as any)[fn]?.(data)).catch(() => {});
  socket.on('call:offer', (d) => call('onOffer', d));
  socket.on('call:answer', (d) => call('onAnswer', d));
  socket.on('call:ice', (d) => call('onIce', d));
  socket.on('call:hangup', (d) => call('onHangup', d));
}

/** Emit a call signaling event over the shared socket (with ack for offer). Used by the call module. */
export function emitCall(event: string, data: any): Promise<any> {
  if (!socket) return Promise.resolve({ error: 'offline' });
  return new Promise((resolve) => {
    socket!.timeout(8000).emit(event, data, (err: any, res: any) => resolve(err ? { error: 'timeout' } : res));
  });
}

export function peerById(id: string): User | undefined {
  return state.contacts.find((c) => c.user.id === id)?.user;
}

async function syncMessages() {
  const data = await api<{ messages: any[]; reactions: { id: string; userId: string; emoji: string }[] }>('/messages/sync');
  set((s) => {
    const messages: Record<string, Msg> = {};
    // keep unsent local messages and locally-read ones
    Object.values(s.messages).forEach((m) => {
      if (m.status === 'sending' || m.status === 'failed' || m.readLocally || m.vanishing) messages[m.id] = m;
    });
    for (const raw of data.messages) messages[raw.id] = toMsg(raw, s.messages[raw.id]);
    for (const r of data.reactions) {
      if (messages[r.id]) messages[r.id] = { ...messages[r.id], reactions: { ...messages[r.id].reactions, [r.userId]: r.emoji } };
    }
    return { messages };
  });
}

function flushQueue() {
  Object.values(state.messages)
    .filter((m) => m.status === 'sending' && m.raw)
    .forEach((m) => emitSend(m));
}

function emitSend(m: Msg) {
  if (!socket?.connected) return;
  socket.timeout(10_000).emit('send', m.raw, (err: any, res: any) => {
    if (err) return; // stays "sending"; retried on reconnect
    if (res?.error) return patchMsg(m.id, { status: 'failed' });
    if (res?.message) upsertRaw(res.message);
  });
}

// ---------- session ----------
async function startSession(token: string, me: Me, keys: KeyPair) {
  await setSecret('hush.token', token);
  await saveKeyPair(keys, me.username);
  setApiToken(token);
  const timers = JSON.parse((await AsyncStorage.getItem('hush.timers')) || '{}');
  set({ token, me, keys, endedReason: null, messages: {}, timers });
  connectSocket();
  registerPush();
}

export async function init() {
  loadConfig();
  const token = await getSecret('hush.token');
  if (token) {
    setApiToken(token);
    try {
      const { user } = await api<{ user: Me }>('/me');
      // Load THIS account's keypair (migrating the legacy device-wide key if present), then
      // persist it per-account so the identity is stable across reloads and logouts.
      const keys = await loadKeyPair(user.username);
      if (keys) await saveKeyPair(keys, user.username);
      const timers = JSON.parse((await AsyncStorage.getItem('hush.timers')) || '{}');
      set({ token, keys, me: user, timers });
      connectSocket();
      registerPush();
    } catch (e: any) {
      if (e.status === 401 || e.status === 403) {
        await wipeLocal(); // forced logout keeps the keypair, so a re-login restores history
      } else {
        // Offline: recover identity from the cached profile so cached messages still decrypt.
        const cached = await AsyncStorage.getItem('hush.me');
        const me = cached ? (JSON.parse(cached) as Me) : null;
        const keys = me ? await loadKeyPair(me.username) : await loadKeyPair();
        set({ token, keys, me });
        if (me) connectSocket();
      }
    }
  }
  set({ ready: true });
}

export async function loadConfig() {
  try {
    set({ config: await apiCached<AppConfig>('/config', 5 * 60_000) });
  } catch {}
}

export async function checkUsername(u: string) {
  return apiCached<{ available: boolean; reason: string | null }>(`/auth/username-available?u=${encodeURIComponent(u)}`, 15_000);
}

export async function signup(username: string, displayName: string, password: string) {
  const keys = newKeyPair();
  const res = await api<{ token: string; user: Me; recoveryKey: string }>('/auth/signup', {
    body: { username, displayName, password, publicKey: keys.publicKey, keyBackup: wrapSecret(keys.secretKey, password) },
  });
  set({ pendingRecoveryKey: res.recoveryKey });
  await startSession(res.token, res.user, keys);
  AsyncStorage.setItem('hush.me', JSON.stringify(res.user));
}

export async function login(username: string, password: string) {
  // The account's keypair is restored from the server's password-encrypted backup, so this works
  // even if this device never had the key (or the browser cleared its storage). Same key everywhere.
  const local = await loadKeyPair(username);
  const res = await api<{ token: string; user: Me; keyBackup: any }>('/auth/login', {
    body: { username, password, ...(local ? { publicKey: local.publicKey, keyBackup: wrapSecret(local.secretKey, password) } : {}) },
  });
  setApiToken(res.token);
  let keys = res.keyBackup ? unwrapSecret(res.keyBackup, password) : null; // backup is authoritative
  if (!keys) keys = local ?? newKeyPair();
  if (!res.keyBackup) {
    // No backup on the server yet (legacy account or a fresh device): register this key once so it's
    // stable from now on. Won't overwrite an existing backup.
    await api('/me/key-backup', { body: { publicKey: keys.publicKey, keyBackup: wrapSecret(keys.secretKey, password) } }).catch(() => {});
  }
  await startSession(res.token, res.user, keys);
  AsyncStorage.setItem('hush.me', JSON.stringify(res.user));
}

export async function recover(username: string, recoveryKey: string, newPassword: string) {
  const keys = (await loadKeyPair(username)) ?? newKeyPair();
  const res = await api<{ token: string; user: Me; keyBackup: any }>('/auth/recover', {
    body: { username, recoveryKey, newPassword, publicKey: keys.publicKey, keyBackup: wrapSecret(keys.secretKey, newPassword) },
  });
  await startSession(res.token, res.user, keys);
}

export const clearRecoveryKey = () => set({ pendingRecoveryKey: null });

// forgetKeys=true only on an explicit log out / delete account. A transient or forced session end
// KEEPS the device's keypair, so logging back in on the same device restores identity and message history
// (otherwise a new keypair would be made and old messages show "could not be decrypted").
async function wipeLocal(forgetKeys = false) {
  socket?.disconnect();
  socket = null;
  setApiToken(null);
  await setSecret('hush.token', null);
  if (forgetKeys) await clearKeyPair();
  await AsyncStorage.multiRemove(['hush.me', 'hush.timers']);
  clearApiCache();
  set({ token: null, me: null, keys: forgetKeys ? null : state.keys, contacts: [], incoming: [], outgoing: [], messages: {}, typing: {}, typingText: {}, connected: false, synced: false });
}

export async function logout() {
  await api('/me/push-token', { body: { token: null } }).catch(() => {});
  // Keep this account's keypair on the device so logging back in restores identity and history.
  await wipeLocal(false);
}

async function endSession(reason: string | null) {
  await wipeLocal();
  set({ endedReason: reason });
}

export async function deleteAccount(password: string) {
  await api('/me', { method: 'DELETE', body: { password } });
  await clearKeyPair(state.me?.username); // account is gone — drop its key for good
  await wipeLocal(false);
}

export async function updateMe(patch: { displayName?: string; settings?: Settings }) {
  const cur = state.me;
  if (cur && (patch.displayName == null || patch.displayName === cur.displayName) &&
    (!patch.settings || JSON.stringify({ ...cur.settings, ...patch.settings }) === JSON.stringify(cur.settings))) return;
  const { user } = await api<{ user: Me }>('/me', { method: 'PATCH', body: patch });
  set({ me: user });
  AsyncStorage.setItem('hush.me', JSON.stringify(user));
}

function saveMe(user: Me) {
  set({ me: user });
  AsyncStorage.setItem('hush.me', JSON.stringify(user));
}

/** Change username. Connections are keyed by user id, so your contacts and chats are untouched. */
export async function changeUsername(username: string) {
  const { user } = await api<{ user: Me }>('/me/username', { body: { username: username.trim().replace(/^@/, '') } });
  clearApiCache('/users/search');
  clearApiCache('/auth/username-available');
  saveMe(user);
}

/** Change password. The key backup is re-wrapped under the new password (same keypair), so all your
 *  message history stays readable. The server keeps your session, so you stay logged in. */
export async function changePassword(currentPassword: string, newPassword: string) {
  const keyBackup = state.keys ? wrapSecret(state.keys.secretKey, newPassword) : undefined;
  await api('/me/password', { body: { currentPassword, newPassword, keyBackup } });
}

/** The public URL for a user's photo, or null. ?v=<timestamp> makes each version cacheable. */
export function avatarUrl(user?: { id: string; avatarAt?: string | null } | null): string | null {
  if (!user?.avatarAt) return null;
  return `${API_URL}/api/avatar/${user.id}?v=${Date.parse(user.avatarAt) || 0}`;
}

/** Resize a picked image to a small square JPEG and upload it as the profile photo. */
export async function setAvatar(uri: string) {
  const ImageManipulator = await import('expo-image-manipulator');
  const out = await ImageManipulator.manipulateAsync(
    uri,
    [{ resize: { width: 256, height: 256 } }],
    { compress: 0.7, format: ImageManipulator.SaveFormat.JPEG, base64: true },
  );
  if (!out.base64) throw new Error('Could not process image');
  const bytes = decodeBase64(out.base64);
  const res = await fetch(`${API_URL}/api/me/avatar`, {
    method: 'PUT',
    headers: { 'content-type': 'image/jpeg', ...(state.token ? { authorization: `Bearer ${state.token}` } : {}) },
    body: bytes as any,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Could not upload photo');
  saveMe(data.user);
}

export async function removeAvatar() {
  const { user } = await api<{ user: Me }>('/me/avatar', { method: 'DELETE' });
  saveMe(user);
}

// ---------- connections ----------
// Several "connections changed" events in a row become a single request.
let connTimer: ReturnType<typeof setTimeout> | null = null;
let connWaiters: (() => void)[] = [];
export function refreshConnections(): Promise<void> {
  return new Promise((resolve) => {
    connWaiters.push(resolve);
    if (connTimer) clearTimeout(connTimer);
    connTimer = setTimeout(async () => {
      connTimer = null;
      const waiters = connWaiters;
      connWaiters = [];
      try {
        const d = await api<{ contacts: Conn[]; incoming: Conn[]; outgoing: Conn[] }>('/connections');
        set({ contacts: d.contacts, incoming: d.incoming, outgoing: d.outgoing });
        clearApiCache('/users/search');
      } catch {}
      if (!state.synced) set({ synced: true });
      waiters.forEach((w) => w());
    }, 150);
  });
}

export async function searchUsers(q: string) {
  return (await apiCached<{ users: (User & { connection: { status: string; outgoing: boolean } | null })[] }>(
    `/users/search?q=${encodeURIComponent(q)}`,
    20_000,
  )).users;
}

export async function requestChat(userId: string) {
  const r = await api<{ status: string }>('/connections/request', { body: { userId } });
  clearApiCache('/users/search');
  refreshConnections();
  return r.status;
}

export async function answerRequest(connectionId: string, accept: boolean) {
  await api(`/connections/${connectionId}/${accept ? 'accept' : 'decline'}`, { method: 'POST' });
  await refreshConnections();
}

function clearChatLocally(peerId: string) {
  removeIds(Object.values(state.messages).filter((m) => peerOf(m) === peerId).map((m) => m.id));
}

/** Delete chat: every message between you two disappears from both phones and the server. */
export async function deleteChat(peerId: string) {
  await api(`/messages/with/${peerId}`, { method: 'DELETE' });
  clearChatLocally(peerId);
}

export async function removeContact(userId: string) {
  await api(`/connections/${userId}`, { method: 'DELETE' });
  await refreshConnections();
}

export async function blockUser(userId: string) {
  await api('/blocks', { body: { userId } });
  await refreshConnections();
}

export async function unblockUser(userId: string) {
  await api(`/blocks/${userId}`, { method: 'DELETE' });
}

export async function listBlocked() {
  return (await api<{ users: User[] }>('/blocks')).users;
}

export async function report(userId: string, reason: string, evidence?: string, block?: boolean) {
  await api('/reports', { body: { userId, reason, evidence, block } });
  if (block) await refreshConnections();
}

// ---------- messaging ----------
export function contactById(id: string): Peer | undefined {
  return state.contacts.find((c) => c.user.id === id)?.user;
}

export async function setChatTimer(peerId: string, timer: number | null) {
  const timers = { ...state.timers, [peerId]: timer };
  set({ timers });
  await AsyncStorage.setItem('hush.timers', JSON.stringify(timers));
}

function queue(peerId: string, kind: 'text' | 'photo', payload: Payload, extra: { mediaKey?: string; replyTo?: string | null } = {}) {
  const peer = contactById(peerId);
  const keys = state.keys;
  if (!peer?.publicKey || !keys) throw new Error('This contact has no encryption key yet');
  const clientId = Crypto.randomUUID();
  const timer = state.timers[peerId] ?? null;
  const sealed = seal(payload, peer.publicKey, keys);
  const raw = { to: peerId, kind, timer, clientId, mediaKey: extra.mediaKey, replyTo: extra.replyTo ?? null, ...sealed };
  const local: Msg = {
    id: `local:${clientId}`,
    clientId,
    from: state.me!.id,
    to: peerId,
    kind,
    mine: true,
    payload,
    timer,
    replyTo: extra.replyTo ?? null,
    viewOnce: kind === 'photo',
    createdAt: new Date().toISOString(),
    status: 'sending',
    reactions: {},
    raw,
  };
  set((s) => ({ messages: { ...s.messages, [local.id]: local } }));
  emitSend(local);
}

export function sendText(peerId: string, body: string, replyTo?: Msg | null) {
  const text = body.trim();
  if (!text) return;
  const replyText = replyTo?.payload?.t === 'text' ? replyTo.payload.body.slice(0, 120) : replyTo ? 'Photo' : undefined;
  queue(peerId, 'text', { t: 'text', body: text.slice(0, 4000), replyText }, { replyTo: replyTo?.id ?? null });
}

/** Server-relative links (database photo storage) need the server address on phones. */
const absUrl = (u: string) => (u.startsWith('/') ? API_URL + u : u);

export async function sendPhoto(peerId: string, bytes: Uint8Array, w?: number, h?: number) {
  const sealedFile = sealBytes(bytes);
  const { key, uploadUrl } = await api<{ key: string; uploadUrl: string }>('/media/upload-url', {
    body: { size: sealedFile.data.length },
  });
  const put = await fetch(absUrl(uploadUrl), {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream' },
    body: sealedFile.data as any,
  });
  if (!put.ok) throw new Error('Upload failed');
  queue(peerId, 'photo', { t: 'photo', key: sealedFile.key, nonce: sealedFile.nonce, w, h }, { mediaKey: key });
}

export async function fetchPhoto(m: Msg, onProgress?: (fraction: number) => void): Promise<Uint8Array | null> {
  if (m.payload?.t !== 'photo' || !m.mediaKey) return null;
  const { url } = await api<{ url: string }>(`/media/download-url?key=${encodeURIComponent(m.mediaKey)}`);
  const res = await fetch(absUrl(url));
  if (!res.ok) throw new Error(res.status === 404 ? 'This photo is gone' : 'Could not load photo');

  // Stream the download so a big photo can show a real progress %, instead of a long black screen.
  const total = Number(res.headers.get('Content-Length')) || 0;
  let buf: Uint8Array;
  const reader = res.body?.getReader?.();
  if (reader) {
    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        received += value.length;
        if (onProgress) onProgress(total ? Math.min(0.99, received / total) : 0);
      }
    }
    buf = new Uint8Array(received);
    let off = 0;
    for (const c of chunks) { buf.set(c, off); off += c.length; }
  } else {
    buf = new Uint8Array(await res.arrayBuffer());
  }
  if (onProgress) onProgress(1);
  const { openBytes } = await import('./crypto');
  return openBytes(buf, m.payload.key, m.payload.nonce);
}

/** Can I still edit this message? (my own text, on the server, inside the admin-set window) */
export function canEdit(m: Msg): boolean {
  const mins = state.config?.editWindowMinutes ?? 15;
  return (
    m.mine && m.kind === 'text' && m.payload?.t === 'text' && !m.id.startsWith('local:') && m.status !== 'failed' &&
    mins > 0 && Date.now() - Date.parse(m.createdAt) < mins * 60_000
  );
}

/** Fix a typo: re-encrypt the new text for both people and replace it. Shows instantly; rolls back if the server says no. */
export function editMessage(m: Msg, body: string): Promise<void> {
  const text = body.trim().slice(0, 4000);
  const old = m.payload;
  if (!text || old?.t !== 'text' || text === old.body) return Promise.resolve();
  const peer = contactById(m.to);
  const keys = state.keys;
  if (!peer?.publicKey || !keys) return Promise.reject(new Error('This contact has no encryption key yet'));
  if (!socket?.connected) return Promise.reject(new Error('You are offline'));
  const payload: Payload = { ...old, body: text };
  const sealed = seal(payload, peer.publicKey, keys);
  const prevEdited = m.editedAt ?? null;
  patchMsg(m.id, { payload, editedAt: new Date().toISOString() });
  return new Promise((resolve, reject) => {
    socket!.timeout(10_000).emit('edit', { id: m.id, ...sealed }, (err: any, res: any) => {
      if (err || res?.error) {
        patchMsg(m.id, { payload: old, editedAt: prevEdited });
        return reject(new Error(res?.error || 'Could not edit. Check your connection.'));
      }
      const at = res?.message?.editedAt ?? res?.editedAt;
      if (at) patchMsg(m.id, { editedAt: at });
      resolve();
    });
  });
}

export function retry(m: Msg) {
  patchMsg(m.id, { status: 'sending' });
  emitSend({ ...m, status: 'sending' });
}

/** Tell the server these were seen. Vanish-on-seen messages are deleted from the server right away. */
export function markSeen(ids: string[]) {
  const fresh = ids.filter((id) => {
    const m = state.messages[id];
    return m && !m.mine && !m.seenAt && !m.readLocally && (m.kind === 'text' || m.kind === 'photo');
  });
  if (!fresh.length || !socket?.connected) return;
  fresh.forEach((id) => {
    const m = state.messages[id];
    if (m.timer == null) patchMsg(id, { readLocally: true, seenAt: new Date().toISOString() });
  });
  socket.emit('seen', { ids: fresh });
}

/** The chat currently on screen (messages there never disappear while you're looking at them). */
let openChat: string | null = null;
export function setOpenChat(peerId: string | null) {
  openChat = peerId;
}

/** Leaving a chat clears what you've already read. */
export function purgeRead(peerId: string) {
  removeIds(Object.values(state.messages).filter((m) => peerOf(m) === peerId && m.readLocally).map((m) => m.id));
}

export function unsend(m: Msg) {
  if (m.id.startsWith('local:')) return removeIds([m.id]);
  socket?.emit('unsend', { id: m.id });
  removeIds([m.id]);
}

export function react(m: Msg, emoji: string | null) {
  if (m.id.startsWith('local:')) return;
  const me = state.me!.id;
  const reactions = { ...m.reactions };
  if (emoji && reactions[me] !== emoji) reactions[me] = emoji;
  else delete reactions[me];
  patchMsg(m.id, { reactions });
  socket?.emit('react', { id: m.id, emoji: reactions[me] ?? null });
}

let lastTyping = 0;
export function sendTyping(peerId: string, on: boolean) {
  if (state.me?.settings?.typing === false || !socket?.connected) return;
  const now = Date.now();
  if (on && now - lastTyping < 2500) return;
  lastTyping = on ? now : 0;
  socket.emit('typing', { to: peerId, on });
}

// Live typing preview — kept light: at most one socket frame per 600ms, and only when the text
// actually changed since the last frame (a long pause or an unchanged value sends nothing).
let typingTextTimer: ReturnType<typeof setTimeout> | null = null;
let pendingTypingText = '';
let lastSentTypingText = '\u0000'; // sentinel so the first frame always sends
export function sendTypingText(peerId: string, text: string) {
  if (state.me?.settings?.typing === false || !socket?.connected) return;
  pendingTypingText = text.slice(0, 500);
  if (typingTextTimer) return;
  typingTextTimer = setTimeout(() => {
    typingTextTimer = null;
    if (pendingTypingText === lastSentTypingText) return; // nothing new → no frame
    const peer = contactById(peerId);
    const keys = state.keys;
    if (!peer?.publicKey || !keys || !socket?.connected) return;
    lastSentTypingText = pendingTypingText;
    const sealed = seal({ t: 'text', body: pendingTypingText }, peer.publicKey, keys);
    socket.emit('typing_text', { to: peerId, ciphertext: sealed.ciphertext, nonce: sealed.nonce });
  }, 600);
}

/** A view-once photo you just opened/closed: show it as opened here so it no longer invites a tap. */
export function markPhotoViewed(id: string) {
  patchMsg(id, { readLocally: true });
}

export function reportScreenshot(peerId: string) {
  socket?.emit('screenshot', { with: peerId });
}

export function dismissAnnouncement() {
  set({ announcementDismissed: state.config?.announcement?.at ?? null });
}

// ---------- push ----------
async function registerPush() {
  try {
    // Web (installed PWA): if the user already granted notifications, keep the server subscription fresh.
    // The first opt-in needs a user tap (see enableNotifications), which Settings triggers.
    const { refreshWebPush } = await import('./webpush');
    await refreshWebPush(state.config?.vapidPublicKey);
  } catch {}
  try {
    const { registerForPush } = await import('./push');
    const token = await registerForPush();
    if (token) await api('/me/push-token', { body: { token } });
  } catch {}
}

/** Turn notifications on from a user tap (required on iOS). Subscribes the installed PWA to Web Push. */
export async function enableNotifications(): Promise<boolean> {
  if (!state.config) await loadConfig();
  const { enableWebPush } = await import('./webpush');
  return enableWebPush(state.config?.vapidPublicKey);
}

export async function disableNotifications(): Promise<void> {
  const { disableWebPush } = await import('./webpush');
  await disableWebPush();
}

/** Web only: whether the browser actually granted permission AND this device has a live subscription. */
export async function notificationsActive(): Promise<boolean> {
  const { webPushActive } = await import('./webpush');
  return webPushActive();
}

export { decodeBase64 };
