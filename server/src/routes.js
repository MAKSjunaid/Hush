import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { q, one, bumpStat, getSetting, getSettingSync, getUser, cacheUser, forgetUser } from './db.js';
import {
  normalizeUsername, validateUsername, validatePassword, hash, compare, newRecoveryKey,
  normalizeRecoveryKey, signToken, requireUser, publicUser, selfUser,
} from './auth.js';
import { emitTo, kickUser, isOnline, serializeMessage, invalidatePair, clearPendingCall } from './realtime.js';
import { pushNewMessage } from './push.js';
import { config, iceServers } from './config.js';
import express from 'express';
import { presignUpload, presignDownload, mediaEnabled, deleteMedia, checkSigned, dbPut, dbGet, DB_MAX_BYTES } from './storage.js';

export const api = Router();

const authLimit = rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many attempts. Wait a minute and try again.' } });
const searchLimit = rateLimit({ windowMs: 60_000, limit: 40, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Searching too fast. Wait a moment.' } });

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (res, error, code = 400) => res.status(code).json({ error });

function validKey(k) {
  return typeof k === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(k); // 32-byte base64 public key
}

// ---------- public config ----------
api.get('/config', wrap(async (_req, res) => {
  res.json({
    maintenance: await getSetting('maintenance', false),
    announcement: await getSetting('announcement', null),
    minAppVersion: await getSetting('minAppVersion', '1.0.0'),
    latestAppVersion: await getSetting('latestAppVersion', '1.0.0'),
    apkUrl: await getSetting('apkUrl', null),
    iosUrl: await getSetting('iosUrl', null),
    mediaEnabled: mediaEnabled(),
    editWindowMinutes: Number(getSettingSync('editWindowMinutes', 15)),
    vapidPublicKey: config.vapid.publicKey || null, // public: the PWA needs it to subscribe to Web Push
    iceServers: iceServers(), // STUN (+ optional TURN) for voice calls
  });
}));

// ---------- auth ----------
api.get('/auth/username-available', searchLimit, wrap(async (req, res) => {
  const u = normalizeUsername(req.query.u);
  const err = validateUsername(u);
  if (err) return res.json({ available: false, reason: err });
  const taken = await one('SELECT 1 FROM users WHERE lower(username) = $1', [u]);
  res.json({ available: !taken, reason: taken ? 'Already taken' : null });
}));

api.post('/auth/signup', authLimit, wrap(async (req, res) => {
  const username = normalizeUsername(req.body.username);
  const displayName = String(req.body.displayName || '').trim().slice(0, 40) || username;
  const { password, publicKey } = req.body;
  const uErr = validateUsername(username);
  if (uErr) return bad(res, uErr);
  const pErr = validatePassword(password);
  if (pErr) return bad(res, pErr);
  if (!validKey(publicKey)) return bad(res, 'Missing encryption key');

  const recoveryKey = newRecoveryKey();
  const keyBackup = req.body.keyBackup ? JSON.stringify(req.body.keyBackup) : null;
  try {
    const user = await one(
      `INSERT INTO users (username, display_name, password_hash, recovery_hash, public_key, key_backup)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [username, displayName, await hash(password), await hash(recoveryKey), publicKey, keyBackup],
    );
    bumpStat('signups');
    cacheUser(user);
    res.json({ token: signToken(user), user: selfUser(user), recoveryKey, keyBackup: user.key_backup || null });
  } catch (e) {
    if (e.code === '23505') return bad(res, 'That username was just taken', 409);
    throw e;
  }
}));

// Bump the session (one active device) without disturbing the account's keypair backup.
// public_key / key_backup are only written when provided (first backup or a legacy device), via COALESCE.
async function startSession(user, { publicKey = null, keyBackup = null, replaceKeys = false } = {}) {
  kickUser(user.id, 'session_replaced');
  const sql = replaceKeys
    ? `UPDATE users SET token_version = token_version + 1, public_key = $2, key_backup = $3, push_token = NULL, last_active_at = now() WHERE id = $1 RETURNING *`
    : `UPDATE users SET token_version = token_version + 1, public_key = COALESCE($2, public_key), key_backup = COALESCE($3, key_backup), push_token = NULL, last_active_at = now() WHERE id = $1 RETURNING *`;
  return cacheUser(await one(sql, [user.id, publicKey, keyBackup ? JSON.stringify(keyBackup) : null]));
}

api.post('/auth/login', authLimit, wrap(async (req, res) => {
  const username = normalizeUsername(req.body.username);
  const { password } = req.body;
  const user = await one('SELECT * FROM users WHERE lower(username) = $1', [username]);
  if (!user || !(await compare(String(password || ''), user.password_hash))) {
    return bad(res, 'Wrong username or password', 401);
  }
  if (user.status !== 'active') return bad(res, `This account is ${user.status}`, 403);
  // If the account already has a key backup, the device key comes from it — keep public_key as-is.
  // Otherwise (first backup or a legacy device), store what the client offers.
  let publicKey = null, keyBackup = null;
  if (!user.key_backup) {
    if (validKey(req.body.publicKey)) publicKey = req.body.publicKey;
    if (req.body.keyBackup) keyBackup = req.body.keyBackup;
  }
  const fresh = await startSession(user, { publicKey, keyBackup });
  res.json({ token: signToken(fresh), user: selfUser(fresh), keyBackup: fresh.key_backup || null });
}));

api.post('/auth/recover', authLimit, wrap(async (req, res) => {
  const username = normalizeUsername(req.body.username);
  const key = normalizeRecoveryKey(req.body.recoveryKey);
  const { newPassword, publicKey } = req.body;
  const pErr = validatePassword(newPassword);
  if (pErr) return bad(res, pErr);
  if (!validKey(publicKey)) return bad(res, 'Missing encryption key');
  const user = await one('SELECT * FROM users WHERE lower(username) = $1', [username]);
  if (!user || !(await compare(key, user.recovery_hash))) return bad(res, 'Username or recovery key is wrong', 401);
  if (user.status !== 'active') return bad(res, `This account is ${user.status}`, 403);
  await q('UPDATE users SET password_hash = $2 WHERE id = $1', [user.id, await hash(newPassword)]);
  // Password reset: the client re-wraps its key (same key if it still has it, else a new one).
  const fresh = await startSession(user, { publicKey, keyBackup: req.body.keyBackup || null, replaceKeys: true });
  res.json({ token: signToken(fresh), user: selfUser(fresh), keyBackup: fresh.key_backup || null });
}));

// ---------- me ----------
api.get('/me', requireUser, (req, res) => res.json({ user: selfUser(req.user) }));

const ALLOWED_SETTINGS = ['showOnline', 'showLastSeen', 'readReceipts', 'typing', 'discoverable', 'notifications', 'defaultTimer'];

api.patch('/me', requireUser, wrap(async (req, res) => {
  const displayName = req.body.displayName != null ? String(req.body.displayName).trim().slice(0, 40) : null;
  const settings = { ...(req.user.settings || {}) };
  for (const k of ALLOWED_SETTINGS) if (k in (req.body.settings || {})) settings[k] = req.body.settings[k];
  const user = await one(
    'UPDATE users SET display_name = COALESCE($2, display_name), settings = $3 WHERE id = $1 RETURNING *',
    [req.user.id, displayName || null, JSON.stringify(settings)],
  );
  cacheUser(user);
  res.json({ user: selfUser(user) });
}));

api.post('/me/username', requireUser, authLimit, wrap(async (req, res) => {
  const u = normalizeUsername(req.body.username);
  const err = validateUsername(u);
  if (err) return bad(res, err);
  const cooldownDays = Number(await getSetting('usernameCooldownDays', 30)) || 0; // 0 = unlimited
  const last = req.user.username_changed_at;
  if (cooldownDays > 0 && last) {
    const elapsed = Date.now() - new Date(last).getTime();
    const windowMs = cooldownDays * 864e5;
    if (elapsed < windowMs) {
      const wait = Math.ceil((windowMs - elapsed) / 864e5);
      return bad(res, `You can change your username once every ${cooldownDays} days — try again in ${wait} day${wait === 1 ? '' : 's'}`);
    }
  }
  try {
    const user = await one('UPDATE users SET username = $2, username_changed_at = now() WHERE id = $1 RETURNING *',
      [req.user.id, u]);
    cacheUser(user);
    res.json({ user: selfUser(user) });
  } catch (e) {
    if (e.code === '23505') return bad(res, 'Already taken', 409);
    throw e;
  }
}));

api.post('/me/password', requireUser, authLimit, wrap(async (req, res) => {
  if (!(await compare(String(req.body.currentPassword || ''), req.user.password_hash))) return bad(res, 'Current password is wrong', 401);
  const pErr = validatePassword(req.body.newPassword);
  if (pErr) return bad(res, pErr);
  // The client re-wraps the SAME keypair under the new password, so message history is preserved.
  const keyBackup = req.body.keyBackup ? JSON.stringify(req.body.keyBackup) : null;
  await q('UPDATE users SET password_hash = $2, key_backup = COALESCE($3, key_backup) WHERE id = $1',
    [req.user.id, await hash(req.body.newPassword), keyBackup]);
  forgetUser(req.user.id);
  res.json({ ok: true });
}));

// First-time key backup registration (legacy account, or a device that had no backup to restore).
// Only writes when none exists yet, so it can never silently rotate an established key.
api.post('/me/key-backup', requireUser, wrap(async (req, res) => {
  if (req.user.key_backup) return res.json({ ok: true, alreadySet: true });
  if (!validKey(req.body.publicKey) || !req.body.keyBackup) return bad(res, 'Missing key');
  cacheUser(await one('UPDATE users SET public_key = $2, key_backup = $3 WHERE id = $1 RETURNING *',
    [req.user.id, req.body.publicKey, JSON.stringify(req.body.keyBackup)]));
  res.json({ ok: true });
}));

// ---------- profile picture ----------
// The phone resizes the image to a small square JPEG before upload. Avatars aren't message
// content (any contact can see them, like your name), so they're stored plainly, one per user.
const AVATAR_MAX_BYTES = 400 * 1024;
api.put('/me/avatar', requireUser, express.raw({ type: () => true, limit: AVATAR_MAX_BYTES }), wrap(async (req, res) => {
  const buf = req.body;
  if (!buf?.length) return bad(res, 'No image');
  if (buf.length > AVATAR_MAX_BYTES) return bad(res, 'Image too large', 413);
  await q(
    `INSERT INTO avatars (user_id, data, mime, updated_at) VALUES ($1, $2, 'image/jpeg', now())
     ON CONFLICT (user_id) DO UPDATE SET data = EXCLUDED.data, mime = EXCLUDED.mime, updated_at = now()`,
    [req.user.id, buf],
  );
  const user = await one('UPDATE users SET avatar_at = now() WHERE id = $1 RETURNING *', [req.user.id]);
  cacheUser(user);
  res.json({ user: selfUser(user) });
}));

api.delete('/me/avatar', requireUser, wrap(async (req, res) => {
  await q('DELETE FROM avatars WHERE user_id = $1', [req.user.id]);
  const user = await one('UPDATE users SET avatar_at = NULL WHERE id = $1 RETURNING *', [req.user.id]);
  cacheUser(user);
  res.json({ user: selfUser(user) });
}));

// Public: a contact's <Image> loads this by URL. The ?v=<timestamp> makes each version
// immutably cacheable, so updating a photo busts the cache without a no-store penalty.
api.get('/avatar/:userId', wrap(async (req, res) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.userId)) return bad(res, 'Not found', 404);
  const row = await one('SELECT data, mime FROM avatars WHERE user_id = $1', [req.params.userId]);
  if (!row) return bad(res, 'No photo', 404);
  res.set({ 'Content-Type': row.mime || 'image/jpeg', 'Cache-Control': 'public, max-age=31536000, immutable' }).send(row.data);
}));

api.post('/me/push-token', requireUser, wrap(async (req, res) => {
  const token = req.body.token ? String(req.body.token).slice(0, 200) : null;
  if (token !== req.user.push_token) {
    cacheUser(await one('UPDATE users SET push_token = $2 WHERE id = $1 RETURNING *', [req.user.id, token]));
  }
  res.json({ ok: true });
}));

// ---------- Web Push (installed PWA, Android & iOS) ----------
api.post('/me/web-push', requireUser, wrap(async (req, res) => {
  const sub = req.body.subscription;
  if (!sub || typeof sub.endpoint !== 'string') return bad(res, 'Bad subscription');
  await q(
    `INSERT INTO web_push_subs (user_id, endpoint, sub) VALUES ($1, $2, $3)
     ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, sub = EXCLUDED.sub`,
    [req.user.id, sub.endpoint.slice(0, 1000), JSON.stringify(sub)],
  );
  res.json({ ok: true });
}));

api.delete('/me/web-push', requireUser, wrap(async (req, res) => {
  const endpoint = req.body?.endpoint;
  if (endpoint) await q('DELETE FROM web_push_subs WHERE endpoint = $1 AND user_id = $2', [endpoint, req.user.id]);
  else await q('DELETE FROM web_push_subs WHERE user_id = $1', [req.user.id]);
  res.json({ ok: true });
}));

// "Decline" tapped on a call notification — the service worker calls this without an auth token.
// Identity is proven by possession of the push subscription endpoint (only that device has it).
api.post('/call-action', wrap(async (req, res) => {
  const { action, callId, from, endpoint } = req.body || {};
  if (action !== 'decline' || !endpoint) return res.json({ ok: false });
  const { rows } = await q('SELECT user_id FROM web_push_subs WHERE endpoint = $1', [String(endpoint)]);
  const me = rows[0]?.user_id;
  if (!me) return res.json({ ok: false });
  clearPendingCall(me);
  if (from) emitTo(String(from), 'call:hangup', { from: me, callId: String(callId || ''), reason: 'decline' });
  res.json({ ok: true });
}));

api.delete('/me', requireUser, wrap(async (req, res) => {
  if (!(await compare(String(req.body?.password || ''), req.user.password_hash))) return bad(res, 'Password is wrong', 401);
  const { rows } = await q('SELECT media_key FROM messages WHERE sender_id = $1 AND media_key IS NOT NULL', [req.user.id]);
  rows.forEach((r) => deleteMedia(r.media_key));
  kickUser(req.user.id, 'account_deleted');
  const { rows: peers } = await q(
    'SELECT CASE WHEN requester_id = $1 THEN addressee_id ELSE requester_id END AS id FROM connections WHERE requester_id = $1 OR addressee_id = $1',
    [req.user.id],
  );
  await q('DELETE FROM users WHERE id = $1', [req.user.id]); // cascades: messages, connections, blocks…
  forgetUser(req.user.id);
  peers.forEach((p) => {
    invalidatePair(req.user.id, p.id);
    emitTo(p.id, 'connections', {});
  });
  res.json({ ok: true });
}));

// ---------- discovery ----------
api.get('/users/search', requireUser, searchLimit, wrap(async (req, res) => {
  const term = normalizeUsername(req.query.q).replace(/[%_\\]/g, '');
  if (term.length < 3) return res.json({ users: [] });
  const { rows } = await q(
    `SELECT u.id, u.username, u.display_name, u.public_key, u.avatar_at, c.status AS conn_status, c.requester_id
       FROM users u
       LEFT JOIN connections c ON (c.requester_id = $1 AND c.addressee_id = u.id) OR (c.addressee_id = $1 AND c.requester_id = u.id)
      WHERE lower(u.username) LIKE $2 AND u.id <> $1 AND u.status = 'active'
        AND (lower(u.username) = $3 OR COALESCE((u.settings->>'discoverable')::boolean, true))
        AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = u.id AND b.blocked_id = $1) OR (b.blocker_id = $1 AND b.blocked_id = u.id))
      ORDER BY (lower(u.username) = $3) DESC, length(u.username), u.username
      LIMIT 15`,
    [req.user.id, `${term}%`, term],
  );
  res.json({
    users: rows.map((u) => ({
      ...publicUser(u),
      connection: u.conn_status
        ? { status: u.conn_status, outgoing: u.requester_id === req.user.id }
        : null,
    })),
  });
}));

api.get('/connections', requireUser, wrap(async (req, res) => {
  const { rows } = await q(
    `SELECT u.id, u.username, u.display_name, u.public_key, u.avatar_at, u.settings, u.last_active_at, c.id AS connection_id, c.status AS conn_status, c.requester_id, c.created_at AS since
       FROM connections c
       JOIN users u ON u.id = CASE WHEN c.requester_id = $1 THEN c.addressee_id ELSE c.requester_id END
      WHERE (c.requester_id = $1 OR c.addressee_id = $1) AND c.status IN ('pending','accepted')
        AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.blocker_id = $1 AND b.blocked_id = u.id)
      ORDER BY c.updated_at DESC`,
    [req.user.id],
  );
  const map = (r) => {
    const showOnline = r.settings?.showOnline !== false;
    const showLastSeen = r.settings?.showLastSeen !== false;
    return {
      connectionId: r.connection_id,
      since: r.since,
      user: {
        ...publicUser(r),
        online: showOnline ? isOnline(r.id) : false,
        lastSeen: showLastSeen ? r.last_active_at : null,
      },
    };
  };
  res.json({
    contacts: rows.filter((r) => r.conn_status === 'accepted').map(map),
    incoming: rows.filter((r) => r.conn_status === 'pending' && r.requester_id !== req.user.id).map(map),
    outgoing: rows.filter((r) => r.conn_status === 'pending' && r.requester_id === req.user.id).map(map),
  });
}));

api.post('/connections/request', requireUser, searchLimit, wrap(async (req, res) => {
  const to = String(req.body.userId || '');
  if (to === req.user.id) return bad(res, "You can't add yourself");
  const target = await getUser(to);
  if (!target || target.status !== 'active') return bad(res, 'User not found', 404);
  const blocked = await one(
    'SELECT 1 FROM blocks WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)',
    [req.user.id, to],
  );
  if (blocked) return bad(res, 'User not found', 404);

  // If they already asked me, sending a request back simply accepts theirs.
  const reverse = await one(`SELECT id, status FROM connections WHERE requester_id = $1 AND addressee_id = $2`, [to, req.user.id]);
  if (reverse && reverse.status !== 'accepted') {
    await q(`UPDATE connections SET status = 'accepted', updated_at = now() WHERE id = $1`, [reverse.id]);
    invalidatePair(req.user.id, to);
    emitTo(to, 'connections', {});
    return res.json({ status: 'accepted' });
  }
  if (reverse) return res.json({ status: 'accepted' });

  const row = await one(
    `INSERT INTO connections (requester_id, addressee_id) VALUES ($1, $2)
     ON CONFLICT (requester_id, addressee_id) DO UPDATE
       SET status = CASE WHEN connections.status = 'accepted' THEN 'accepted' ELSE 'pending' END, updated_at = now()
     RETURNING status`,
    [req.user.id, to],
  );
  emitTo(to, 'connections', { request: true });
  if (!isOnline(to)) pushNewMessage(target, 'request');
  res.json({ status: row.status });
}));

async function answer(req, res, status) {
  const row = await one(
    `UPDATE connections SET status = $3, updated_at = now()
      WHERE id = $1 AND addressee_id = $2 AND status = 'pending' RETURNING requester_id`,
    [req.params.id, req.user.id, status],
  );
  if (!row) return bad(res, 'Request not found', 404);
  invalidatePair(req.user.id, row.requester_id);
  if (status === 'accepted') emitTo(row.requester_id, 'connections', {});
  res.json({ ok: true });
}
api.post('/connections/:id/accept', requireUser, wrap((req, res) => answer(req, res, 'accepted')));
api.post('/connections/:id/decline', requireUser, wrap((req, res) => answer(req, res, 'declined')));

api.delete('/connections/:userId', requireUser, wrap(async (req, res) => {
  await q(
    `DELETE FROM connections WHERE (requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1)`,
    [req.user.id, req.params.userId],
  );
  invalidatePair(req.user.id, req.params.userId);
  emitTo(req.params.userId, 'connections', {});
  res.json({ ok: true });
}));

// Delete chat: wipes every message between the two of you, on both phones. You stay connected.
api.delete('/messages/with/:userId', requireUser, wrap(async (req, res) => {
  const other = String(req.params.userId);
  if (!/^[0-9a-f-]{36}$/i.test(other)) return bad(res, 'Unknown chat');
  const { rows } = await q(
    `DELETE FROM messages WHERE (sender_id = $1 AND recipient_id = $2) OR (sender_id = $2 AND recipient_id = $1)
     RETURNING media_key`,
    [req.user.id, other],
  );
  rows.forEach((r) => r.media_key && deleteMedia(r.media_key));
  emitTo(other, 'chat_cleared', { userId: req.user.id });
  res.json({ ok: true });
}));

// ---------- block / report ----------
api.get('/blocks', requireUser, wrap(async (req, res) => {
  const { rows } = await q(
    'SELECT u.id, u.username, u.display_name, u.public_key, u.avatar_at FROM blocks b JOIN users u ON u.id = b.blocked_id WHERE b.blocker_id = $1 ORDER BY b.created_at DESC',
    [req.user.id],
  );
  res.json({ users: rows.map(publicUser) });
}));

api.post('/blocks', requireUser, wrap(async (req, res) => {
  const other = String(req.body.userId || '');
  await q('INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.user.id, other]);
  invalidatePair(req.user.id, other);
  // Blocking wipes pending messages between the two.
  const { rows } = await q(
    `DELETE FROM messages WHERE (sender_id = $1 AND recipient_id = $2) OR (sender_id = $2 AND recipient_id = $1)
     RETURNING id, media_key`,
    [req.user.id, other],
  );
  rows.forEach((r) => deleteMedia(r.media_key));
  emitTo(req.user.id, 'vanished', { ids: rows.map((r) => r.id) });
  emitTo(other, 'vanished', { ids: rows.map((r) => r.id) });
  emitTo(other, 'connections', {});
  res.json({ ok: true });
}));

api.delete('/blocks/:userId', requireUser, wrap(async (req, res) => {
  await q('DELETE FROM blocks WHERE blocker_id = $1 AND blocked_id = $2', [req.user.id, req.params.userId]);
  invalidatePair(req.user.id, req.params.userId);
  res.json({ ok: true });
}));

api.post('/reports', requireUser, searchLimit, wrap(async (req, res) => {
  const reason = String(req.body.reason || '').trim().slice(0, 200);
  if (!reason) return bad(res, 'Pick a reason');
  await q('INSERT INTO reports (reporter_id, reported_id, reason, evidence) VALUES ($1,$2,$3,$4)', [
    req.user.id, req.body.userId, reason, req.body.evidence ? String(req.body.evidence).slice(0, 4000) : null,
  ]);
  if (req.body.block) {
    await q('INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.user.id, req.body.userId]);
    invalidatePair(req.user.id, req.body.userId);
    emitTo(req.body.userId, 'connections', {});
  }
  res.json({ ok: true });
}));

// ---------- messages ----------
api.get('/messages/sync', requireUser, wrap(async (req, res) => {
  const { rows } = await q(
    // Only the columns the phone needs, and only the copy this user can decrypt.
    `SELECT id, client_id, sender_id, recipient_id, kind, sender_public_key, media_key, reply_to, view_once,
            timer_seconds, created_at, delivered_at, seen_at, expires_at, edited_at,
            CASE WHEN sender_id = $1 THEN self_ciphertext ELSE ciphertext END AS ciphertext,
            CASE WHEN sender_id = $1 THEN self_nonce ELSE nonce END AS nonce
       FROM messages WHERE (sender_id = $1 OR recipient_id = $1) AND expires_at > now()
      ORDER BY created_at ASC LIMIT 2000`,
    [req.user.id],
  );
  // Reactions only for the messages we're returning (and no query at all when there are none).
  const reacts = rows.length
    ? (await q('SELECT message_id, user_id, emoji FROM reactions WHERE message_id = ANY($1::uuid[])', [rows.map((m) => m.id)])).rows
    : [];
  res.json({
    messages: rows.map((m) => serializeMessage({ ...m, self_ciphertext: m.ciphertext, self_nonce: m.nonce }, req.user.id)),
    reactions: reacts.map((r) => ({ id: r.message_id, userId: r.user_id, emoji: r.emoji })),
  });
}));

// ---------- media (encrypted before upload) ----------
api.post('/media/upload-url', requireUser, wrap(async (req, res) => {
  try {
    res.json(await presignUpload(req.user.id, Number(req.body.size)));
  } catch (e) {
    bad(res, e.message);
  }
}));

// Database photo storage: upload/download with short-lived signed links (no login token needed in the URL).
api.put('/media/blob/*key', express.raw({ type: () => true, limit: DB_MAX_BYTES }), wrap(async (req, res) => {
  const key = [].concat(req.params.key).join('/');
  if (!checkSigned('put', key, req.query.e, req.query.s)) return bad(res, 'Upload link expired', 403);
  try {
    await dbPut(key, req.body);
  } catch (e) {
    return bad(res, e.message, 413);
  }
  res.status(204).end();
}));

api.get('/media/blob/*key', wrap(async (req, res) => {
  const key = [].concat(req.params.key).join('/');
  if (!checkSigned('get', key, req.query.e, req.query.s)) return bad(res, 'Link expired', 403);
  const data = await dbGet(key);
  if (!data) return bad(res, 'This photo is gone', 404);
  res.set({ 'Content-Type': 'application/octet-stream', 'Cache-Control': 'private, no-store' }).send(data);
}));

api.get('/media/download-url', requireUser, wrap(async (req, res) => {
  const key = String(req.query.key || '');
  const msg = await one(
    'SELECT 1 FROM messages WHERE media_key = $1 AND (sender_id = $2 OR recipient_id = $2)',
    [key, req.user.id],
  );
  if (!msg) return bad(res, 'This photo is gone', 404);
  res.json({ url: await presignDownload(key) });
}));
