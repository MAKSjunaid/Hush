import { useSyncExternalStore } from 'react';
import { io, Socket } from 'socket.io-client';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import { api, apiCached, clearApiCache, setApiToken } from './api';
import { API_URL } from './config';
import { getSecret, setSecret } from './secure';
import {
  KeyPair, Payload, newKeyPair, saveKeyPair, loadKeyPair, clearKeyPair, seal, open, sealBytes, decodeBase64,
} from './crypto';

// ---------- types ----------
export type Settings = {
  showOnline?: boolean;
  showLastSeen?: boolean;
  typing?: boolean;
  discoverable?: boolean;
  notifications?: boolean;
};
export type User = { id: string; username: string; displayName: string; publicKey: string | null };
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
};

type State = {
  ready: boolean;
  token: string | null;
  me: Me | null;
  keys: KeyPair | null;
  contacts: Conn[];
  incoming: Conn[];
  outgoing: Conn[];
  messages: Record<string, Msg>;
  typing: Record<string, number>;
  connected: boolean;
  config: AppConfig | null;
  announcementDismissed: string | null;
  endedReason: string | null;
  pendingRecoveryKey: string | null;
  timers: Record<string, number | null>; // per-chat vanish timer (seconds) – null = on seen
};

let state: State = {
  ready: false,
  token: null,
  me: null,
  keys: null,
  contacts: [],
  incoming: [],
  outgoing: [],
  messages: {},
  typing: {},
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
    payload: prev?.payload ?? decrypt(raw),
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
      if (on) typing[from] = Date.now();
      else delete typing[from];
      return { typing };
    });
    if (on) typingTimers[from] = setTimeout(() => set((s) => {
      const typing = { ...s.typing };
      delete typing[from];
      return { typing };
    }), 6000);
  });
  socket.on('presence', ({ userId, online, lastSeen }) => {
    set((s) => ({
      contacts: s.contacts.map((c) => (c.user.id === userId ? { ...c, user: { ...c.user, online, lastSeen } } : c)),
    }));
  });
  socket.on('connections', () => refreshConnections());
  socket.on('announcement', (a) => set((s) => ({ config: s.config ? { ...s.config, announcement: a } : s.config })));
  socket.on('session_replaced', () => endSession('You logged in on another device. Hush works on one device at a time.'));
  socket.on('account_suspended', () => endSession('Your account has been suspended.'));
  socket.on('account_banned', () => endSession('Your account has been banned.'));
  socket.on('account_deleted', () => endSession(null));
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
  await saveKeyPair(keys);
  setApiToken(token);
  const timers = JSON.parse((await AsyncStorage.getItem('hush.timers')) || '{}');
  set({ token, me, keys, endedReason: null, messages: {}, timers });
  connectSocket();
  registerPush();
}

export async function init() {
  loadConfig();
  const [token, keys] = await Promise.all([getSecret('hush.token'), loadKeyPair()]);
  if (token && keys) {
    setApiToken(token);
    try {
      const { user } = await api<{ user: Me }>('/me');
      const timers = JSON.parse((await AsyncStorage.getItem('hush.timers')) || '{}');
      set({ token, keys, me: user, timers });
      connectSocket();
      registerPush();
    } catch (e: any) {
      if (e.status === 401 || e.status === 403) await wipeLocal();
      else set({ token, keys, me: null }); // offline: try later
      if (e.status === 0) {
        const cached = await AsyncStorage.getItem('hush.me');
        if (cached) set({ me: JSON.parse(cached) });
        connectSocket();
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
    body: { username, displayName, password, publicKey: keys.publicKey },
  });
  set({ pendingRecoveryKey: res.recoveryKey });
  await startSession(res.token, res.user, keys);
  AsyncStorage.setItem('hush.me', JSON.stringify(res.user));
}

export async function login(username: string, password: string) {
  const keys = newKeyPair();
  const res = await api<{ token: string; user: Me }>('/auth/login', { body: { username, password, publicKey: keys.publicKey } });
  await startSession(res.token, res.user, keys);
  AsyncStorage.setItem('hush.me', JSON.stringify(res.user));
}

export async function recover(username: string, recoveryKey: string, newPassword: string) {
  const keys = newKeyPair();
  const res = await api<{ token: string; user: Me }>('/auth/recover', {
    body: { username, recoveryKey, newPassword, publicKey: keys.publicKey },
  });
  await startSession(res.token, res.user, keys);
}

export const clearRecoveryKey = () => set({ pendingRecoveryKey: null });

async function wipeLocal() {
  socket?.disconnect();
  socket = null;
  setApiToken(null);
  await setSecret('hush.token', null);
  await clearKeyPair();
  await AsyncStorage.multiRemove(['hush.me', 'hush.timers']);
  clearApiCache();
  set({ token: null, me: null, keys: null, contacts: [], incoming: [], outgoing: [], messages: {}, typing: {}, connected: false });
}

export async function logout() {
  await api('/me/push-token', { body: { token: null } }).catch(() => {});
  await wipeLocal();
}

async function endSession(reason: string | null) {
  await wipeLocal();
  set({ endedReason: reason });
}

export async function deleteAccount(password: string) {
  await api('/me', { method: 'DELETE', body: { password } });
  await wipeLocal();
}

export async function updateMe(patch: { displayName?: string; settings?: Settings }) {
  const cur = state.me;
  if (cur && (patch.displayName == null || patch.displayName === cur.displayName) &&
    (!patch.settings || JSON.stringify({ ...cur.settings, ...patch.settings }) === JSON.stringify(cur.settings))) return;
  const { user } = await api<{ user: Me }>('/me', { method: 'PATCH', body: patch });
  set({ me: user });
  AsyncStorage.setItem('hush.me', JSON.stringify(user));
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

export async function sendPhoto(peerId: string, bytes: Uint8Array, w?: number, h?: number) {
  const sealedFile = sealBytes(bytes);
  const { key, uploadUrl } = await api<{ key: string; uploadUrl: string }>('/media/upload-url', {
    body: { size: sealedFile.data.length },
  });
  const put = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream' },
    body: sealedFile.data as any,
  });
  if (!put.ok) throw new Error('Upload failed');
  queue(peerId, 'photo', { t: 'photo', key: sealedFile.key, nonce: sealedFile.nonce, w, h }, { mediaKey: key });
}

export async function fetchPhoto(m: Msg): Promise<Uint8Array | null> {
  if (m.payload?.t !== 'photo' || !m.mediaKey) return null;
  const { url } = await api<{ url: string }>(`/media/download-url?key=${encodeURIComponent(m.mediaKey)}`);
  const res = await fetch(url);
  const buf = new Uint8Array(await res.arrayBuffer());
  const { openBytes } = await import('./crypto');
  return openBytes(buf, m.payload.key, m.payload.nonce);
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

export function reportScreenshot(peerId: string) {
  socket?.emit('screenshot', { with: peerId });
}

export function dismissAnnouncement() {
  set({ announcementDismissed: state.config?.announcement?.at ?? null });
}

// ---------- push ----------
async function registerPush() {
  try {
    const { registerForPush } = await import('./push');
    const token = await registerForPush();
    if (token) await api('/me/push-token', { body: { token } });
  } catch {}
}

export { decodeBase64 };
