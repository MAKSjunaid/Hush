import { Server } from 'socket.io';
import { q, one, bumpStat, getSettingSync, getUser, cacheUser } from './db.js';
import { TTLCache, registerCache } from './cache.js';
import { userFromToken } from './auth.js';
import { pushNewMessage, sendWebPush } from './push.js';
import { deleteMedia } from './storage.js';
import { config } from './config.js';

let io = null;
/** userId -> Set<socketId> */
const online = new Map();
// Briefly holds a ringing call's offer per callee, so if their app was backgrounded (socket asleep)
// a push wakes them, and on reconnect we re-deliver the offer and it rings. Cleared on answer/hangup.
const pendingCalls = new Map();
export function clearPendingCall(calleeId) {
  const p = pendingCalls.get(calleeId);
  if (p) { clearTimeout(p.timer); pendingCalls.delete(calleeId); }
}

export const isOnline = (userId) => online.has(userId);
export const onlineCount = () => online.size;

export function emitTo(userId, event, data) {
  if (io) io.to(`u:${userId}`).emit(event, data);
}

export function kickUser(userId, reason = 'session_replaced') {
  if (!io) return;
  emitTo(userId, reason, {});
  io.in(`u:${userId}`).disconnectSockets(true);
}

const MESSAGE_KINDS = new Set(['text', 'photo']);
const TIMERS = new Set([null, 5, 30, 60, 3600, 86400, 604800]);

export function serializeMessage(m, viewerId) {
  const mine = m.sender_id === viewerId;
  return {
    id: m.id,
    clientId: m.client_id,
    from: m.sender_id,
    to: m.recipient_id,
    kind: m.kind,
    mine,
    ciphertext: mine ? m.self_ciphertext : m.ciphertext,
    nonce: mine ? m.self_nonce : m.nonce,
    senderPublicKey: m.sender_public_key,
    mediaKey: m.media_key,
    replyTo: m.reply_to,
    viewOnce: m.view_once,
    timer: m.timer_seconds,
    createdAt: m.created_at,
    deliveredAt: m.delivered_at,
    seenAt: m.seen_at,
    expiresAt: m.expires_at,
    editedAt: m.edited_at ?? null,
  };
}

// "Can these two message each other?" and "who are my contacts?" are asked on every message,
// typing event and presence change, so they're answered from memory and refreshed on changes.
const pairCache = registerCache(new TTLCache({ ttlMs: 10 * 60_000, max: 20_000 }));
const contactsCache = registerCache(new TTLCache({ ttlMs: 10 * 60_000, max: 10_000 }));
const pairKey = (a, b) => (a < b ? `${a}:${b}` : `${b}:${a}`);
export function invalidatePair(a, b) {
  pairCache.delete(pairKey(a, b));
  contactsCache.delete(a);
  contactsCache.delete(b);
}

export async function canMessage(a, b) {
  if (!a || !b || a === b) return false;
  const key = pairKey(a, b);
  const hit = pairCache.get(key);
  if (hit !== undefined) return hit;
  const row = await one(
    `SELECT
       EXISTS (SELECT 1 FROM connections
               WHERE status = 'accepted'
                 AND ((requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1))) AS connected,
       EXISTS (SELECT 1 FROM blocks
               WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)) AS blocked`,
    [a, b],
  );
  return pairCache.set(key, Boolean(row.connected && !row.blocked));
}

async function contactsOf(userId) {
  const hit = contactsCache.get(userId);
  if (hit) return hit;
  const { rows } = await q(
    `SELECT CASE WHEN requester_id = $1 THEN addressee_id ELSE requester_id END AS id
       FROM connections WHERE status = 'accepted' AND (requester_id = $1 OR addressee_id = $1)`,
    [userId],
  );
  return contactsCache.set(userId, rows.map((r) => r.id));
}

async function broadcastPresence(user, isOn) {
  if (user.settings?.showOnline === false) return;
  const showLastSeen = user.settings?.showLastSeen !== false;
  const payload = { userId: user.id, online: isOn, lastSeen: showLastSeen ? new Date().toISOString() : null };
  for (const id of await contactsOf(user.id)) emitTo(id, 'presence', payload);
}

async function vanish(rows) {
  for (const r of rows) {
    emitTo(r.sender_id, 'vanished', { ids: [r.id] });
    emitTo(r.recipient_id, 'vanished', { ids: [r.id] });
    if (r.media_key) deleteMedia(r.media_key);
  }
}

/**
 * Deletes expired messages and tells both phones.
 * The database is only queried when something is actually due (or every 30 min as a safety net),
 * so an idle Hush makes no database calls and Neon can sleep.
 */
let nextSweepAt = 0;
let sweeping = false;
export function scheduleSweep(at) {
  const t = new Date(at).getTime();
  if (Number.isFinite(t) && t < nextSweepAt) nextSweepAt = t;
}
async function sweep() {
  if (sweeping) return;
  sweeping = true;
  try {
    const { rows } = await q(
      'DELETE FROM messages WHERE expires_at <= now() RETURNING id, sender_id, recipient_id, media_key',
    );
    if (rows.length) await vanish(rows);
    const next = await one('SELECT min(expires_at) AS at FROM messages');
    const safety = Date.now() + 30 * 60_000;
    nextSweepAt = next?.at ? Math.min(new Date(next.at).getTime() + 250, safety) : safety;
  } catch (e) {
    console.warn('[sweeper]', e.message);
    nextSweepAt = Date.now() + 60_000;
  } finally {
    sweeping = false;
  }
}
function startSweeper() {
  nextSweepAt = Date.now() + 5000; // first pass once the database is ready
  setInterval(() => {
    if (Date.now() >= nextSweepAt) sweep();
  }, 1000).unref();
}

function rateLimiter(limit, windowMs) {
  const hits = new Map();
  // forget idle users so the map never grows without bound
  setInterval(() => {
    const now = Date.now();
    for (const [k, arr] of hits) if (!arr.length || now - arr[arr.length - 1] > windowMs) hits.delete(k);
  }, 60_000).unref();
  return (key) => {
    const now = Date.now();
    const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
    arr.push(now);
    hits.set(key, arr);
    return arr.length <= limit;
  };
}
const sendLimit = rateLimiter(30, 10_000);
const editLimit = rateLimiter(30, 60_000);
// Read-and-deleted text messages, kept in memory only for the longest possible edit window (capped size).
const recentlySeen = registerCache(new TTLCache({ ttlMs: 24 * 3600_000, max: 50_000 }));
const eventLimit = rateLimiter(60, 10_000);
const typingTextLimit = rateLimiter(40, 10_000);

// Who might have undelivered messages: anyone a message was queued for, plus everyone once after a restart.
const pendingFor = new Set();
const checkedSinceBoot = registerCache(new TTLCache({ ttlMs: 24 * 3600_000, max: 50_000 }));
function mayHavePending(userId) {
  const yes = pendingFor.has(userId) || !checkedSinceBoot.get(userId);
  pendingFor.delete(userId);
  checkedSinceBoot.set(userId, true);
  return yes;
}

// Last-active + daily-active tracking: at most one small write per user every 5 minutes.
const OFFLINE_GRACE_MS = 20_000;
const goingOffline = new Map(); // userId -> timer (cleared on reconnect, so the map never grows past live sockets)
const lastTouch = registerCache(new TTLCache({ ttlMs: 5 * 60_000, max: 20_000 }));
async function touchActive(userId) {
  if (lastTouch.get(userId)) return;
  lastTouch.set(userId, true);
  await q(
    `WITH u AS (UPDATE users SET last_active_at = now() WHERE id = $1)
     INSERT INTO user_activity (user_id) VALUES ($1) ON CONFLICT DO NOTHING`,
    [userId],
  ).catch(() => {});
}

export function attachRealtime(httpServer) {
  io = new Server(httpServer, {
    cors: { origin: config.corsOrigins.includes('*') ? true : config.corsOrigins },
    pingInterval: 20_000,
  });

  io.use(async (socket, next) => {
    const user = await userFromToken(socket.handshake.auth?.token);
    if (!user) return next(new Error('unauthorized'));
    if (user.blockedStatus) return next(new Error(`account_${user.blockedStatus}`));
    socket.data.userId = user.id;
    next();
  });

  io.on('connection', async (socket) => {
    const userId = socket.data.userId;
    socket.join(`u:${userId}`);
    // Back within the grace period (page reload, network blip)? Then nobody ever saw them go offline.
    const wasGoingOffline = goingOffline.has(userId);
    if (wasGoingOffline) {
      clearTimeout(goingOffline.get(userId));
      goingOffline.delete(userId);
    }
    const first = !online.has(userId);
    if (first) online.set(userId, new Set());
    online.get(userId).add(socket.id);

    const me = await getUser(userId);
    await touchActive(userId);
    if (first && me && !wasGoingOffline) broadcastPresence(me, true);

    // Everything waiting for this user is now delivered (only queried if something may be waiting).
    if (mayHavePending(userId)) {
      const { rows: delivered } = await q(
        `UPDATE messages SET delivered_at = now()
          WHERE recipient_id = $1 AND delivered_at IS NULL RETURNING id, sender_id, delivered_at`,
        [userId],
      );
      for (const d of delivered) emitTo(d.sender_id, 'delivered', { id: d.id, at: d.delivered_at });
    }

    // If a call was ringing for this user while their app was asleep, deliver it now that they're back.
    const pending = pendingCalls.get(userId);
    if (pending) socket.emit('call:offer', { from: pending.from, sdp: pending.sdp, callId: pending.callId, name: pending.name });

    const announcement = getSettingSync('announcement', null);
    if (announcement?.text) socket.emit('announcement', announcement);

    const guard = (fn) => async (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      if (!eventLimit(userId)) return reply({ error: 'Slow down a little' });
      try {
        await fn(payload || {}, reply);
      } catch (e) {
        console.error('[socket]', e);
        reply({ error: 'Something went wrong' });
      }
    };

    socket.on('send', guard(async (p, reply) => {
      if (!sendLimit(userId)) return reply({ error: 'You are sending too fast' });
      const to = String(p.to || '');
      const kind = MESSAGE_KINDS.has(p.kind) ? p.kind : 'text';
      const timer = p.timer == null ? null : Number(p.timer);
      if (!TIMERS.has(timer)) return reply({ error: 'Invalid timer' });
      if (!p.ciphertext || !p.nonce || !p.selfCiphertext || !p.selfNonce) return reply({ error: 'Not encrypted' });
      if (String(p.ciphertext).length > 20_000) return reply({ error: 'Message too long' });
      if (!(await canMessage(userId, to))) return reply({ error: 'You can only message accepted contacts' });

      const sender = await getUser(userId);
      const recipient = await getUser(to);
      const deliveredNow = isOnline(to);

      const row = await one(
        `INSERT INTO messages (client_id, sender_id, recipient_id, kind, ciphertext, nonce, self_ciphertext, self_nonce,
                               sender_public_key, media_key, reply_to, view_once, timer_seconds, delivered_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, CASE WHEN $14 THEN now() END)
         ON CONFLICT (sender_id, client_id) DO NOTHING
         RETURNING id, client_id, sender_id, recipient_id, kind, ciphertext, nonce, self_ciphertext, self_nonce,
                   sender_public_key, media_key, reply_to, view_once, timer_seconds, created_at, delivered_at, seen_at, expires_at`,
        [
          String(p.clientId || '').slice(0, 64) || null, userId, to, kind, p.ciphertext, p.nonce, p.selfCiphertext,
          p.selfNonce, sender.public_key, p.mediaKey || null, p.replyTo || null, Boolean(p.viewOnce) || kind === 'photo',
          timer, deliveredNow,
        ],
      );
      if (!row) return reply({ duplicate: true }); // already received (retry after reconnect)

      bumpStat('messages');
      reply({ message: serializeMessage(row, userId) });
      emitTo(userId, 'message', serializeMessage(row, userId));
      emitTo(to, 'message', serializeMessage(row, to));
      if (!deliveredNow) {
        pendingFor.add(to);
        pushNewMessage(recipient, kind);
      }
    }));

    // Edit your own text message within the edit window (admin setting, default 15 min). One UPDATE, no reads:
    // the WHERE clause checks ownership, kind and time, and RETURNING gives everything needed to notify.
    socket.on('edit', guard(async (p, reply) => {
      if (!editLimit(userId)) return reply({ error: 'You are editing too fast' });
      const mins = Math.max(0, Math.min(1440, Number(getSettingSync('editWindowMinutes', 15)) || 0));
      if (!mins) return reply({ error: 'Editing is turned off' });
      if (!p.ciphertext || !p.nonce || !p.selfCiphertext || !p.selfNonce) return reply({ error: 'Not encrypted' });
      if (String(p.ciphertext).length > 20_000) return reply({ error: 'Message too long' });
      const id = String(p.id || '');
      // Already read (and deleted from the server) but still on their screen: relay the edit, zero database work.
      const seen = recentlySeen.get(id);
      if (seen) {
        if (seen.s !== userId || Date.now() - seen.c > mins * 60_000) return reply({ error: 'This message can no longer be edited' });
        const editedAt = new Date().toISOString();
        emitTo(seen.r, 'message_edited', { id, ciphertext: p.ciphertext, nonce: p.nonce, editedAt });
        return reply({ editedAt });
      }
      const row = await one(
        `UPDATE messages SET ciphertext = $3, nonce = $4, self_ciphertext = $5, self_nonce = $6, edited_at = now()
          WHERE id = $1 AND sender_id = $2 AND kind = 'text' AND created_at > now() - make_interval(mins => $7)
         RETURNING id, client_id, sender_id, recipient_id, kind, ciphertext, nonce, self_ciphertext, self_nonce,
                   sender_public_key, media_key, reply_to, view_once, timer_seconds, created_at, delivered_at, seen_at,
                   expires_at, edited_at`,
        [id, userId, p.ciphertext, p.nonce, p.selfCiphertext, p.selfNonce, mins],
      ).catch(() => null);
      if (!row) return reply({ error: 'This message can no longer be edited' });
      reply({ message: serializeMessage(row, userId) });
      emitTo(row.recipient_id, 'message', serializeMessage(row, row.recipient_id));
    }));

    socket.on('seen', guard(async (p, reply) => {
      const ids = Array.isArray(p.ids) ? p.ids.slice(0, 200) : [];
      if (!ids.length) return reply({ ok: true });
      const { rows } = await q(
        `SELECT id, sender_id, recipient_id, timer_seconds, media_key, view_once, kind, created_at
           FROM messages WHERE id = ANY($1::uuid[]) AND recipient_id = $2 AND seen_at IS NULL
            AND kind IN ('text','photo')`,
        [ids, userId],
      );
      const now = new Date();
      const vanishNow = rows.filter((r) => r.timer_seconds == null);
      const timed = rows.filter((r) => r.timer_seconds != null);

      if (vanishNow.length) {
        // Gone from the server the moment it's seen. The reader's screen keeps it until they leave the chat.
        await q('DELETE FROM messages WHERE id = ANY($1::uuid[])', [vanishNow.map((r) => r.id)]);
        for (const r of vanishNow) {
          // Still on the reader's screen until they leave: remember just enough (in memory) to allow a quick edit.
          if (r.kind === 'text') recentlySeen.set(r.id, { s: r.sender_id, r: r.recipient_id, c: new Date(r.created_at).getTime() });
          emitTo(r.sender_id, 'seen', { id: r.id, at: now, vanishing: true });
          if (r.media_key) deleteMedia(r.media_key);
        }
      }
      for (const r of timed) {
        const { expires_at } = await one(
          `UPDATE messages SET seen_at = now(), expires_at = now() + make_interval(secs => $2)
            WHERE id = $1 RETURNING expires_at`,
          [r.id, r.timer_seconds],
        );
        scheduleSweep(expires_at);
        emitTo(r.sender_id, 'seen', { id: r.id, at: now, expiresAt: expires_at });
        emitTo(r.recipient_id, 'seen', { id: r.id, at: now, expiresAt: expires_at });
      }
      reply({ ok: true });
    }));

    socket.on('unsend', guard(async (p, reply) => {
      const { rows } = await q(
        'DELETE FROM messages WHERE id = $1 AND sender_id = $2 RETURNING id, sender_id, recipient_id, media_key',
        [p.id, userId],
      );
      await vanish(rows);
      reply({ ok: true });
    }));

    socket.on('react', guard(async (p, reply) => {
      const msg = await one('SELECT sender_id, recipient_id FROM messages WHERE id = $1', [p.id]);
      if (!msg || (msg.sender_id !== userId && msg.recipient_id !== userId)) return reply({ error: 'Gone' });
      const emoji = String(p.emoji || '').slice(0, 8);
      if (emoji) {
        await q(
          `INSERT INTO reactions (message_id, user_id, emoji) VALUES ($1,$2,$3)
           ON CONFLICT (message_id, user_id) DO UPDATE SET emoji = EXCLUDED.emoji`,
          [p.id, userId, emoji],
        );
      } else {
        await q('DELETE FROM reactions WHERE message_id = $1 AND user_id = $2', [p.id, userId]);
      }
      const payload = { id: p.id, userId, emoji: emoji || null };
      emitTo(msg.sender_id, 'reaction', payload);
      emitTo(msg.recipient_id, 'reaction', payload);
      reply({ ok: true });
    }));

    socket.on('typing', guard(async (p) => {
      if (await canMessage(userId, p.to)) emitTo(p.to, 'typing', { from: userId, on: Boolean(p.on) });
    }));

    // Live typing preview: relay the encrypted draft to the other person, never stored.
    socket.on('typing_text', guard(async (p) => {
      if (!typingTextLimit(userId)) return;
      if (typeof p.ciphertext !== 'string' || p.ciphertext.length > 2000 || typeof p.nonce !== 'string') return;
      if (await canMessage(userId, p.to)) emitTo(p.to, 'typing_text', { from: userId, ciphertext: p.ciphertext, nonce: p.nonce });
    }));

    // ---- Voice call signaling (WebRTC) ----
    // The server only relays the connection handshake between two contacts; the audio itself is
    // peer-to-peer and end-to-end encrypted (DTLS-SRTP) and never touches the server.
    const callIceLimit = rateLimiter(100, 10_000); // ICE candidates can be chatty during setup
    socket.on('call:offer', guard(async (p, reply) => {
      const to = String(p.to || '');
      if (typeof p.sdp !== 'string' || p.sdp.length > 20000) return reply?.({ error: 'Bad offer' });
      if (!(await canMessage(userId, to))) return reply?.({ error: 'Not a contact' });
      const callId = String(p.callId || '');
      // Caller identity so the callee's notification + in-app screen show a real name/avatar, not "IC".
      const caller = await getUser(userId).catch(() => null);
      const callerName = caller?.display_name || caller?.username || 'Someone';
      const hasAvatar = !!caller?.avatar_at;
      // Buffer the offer + send a push for EVERYONE — online or not. A minimized phone has already
      // dropped its socket (so it reads as "offline"); the push is exactly what wakes it, and the
      // buffered offer lets it catch the call when the callee taps the notification within ~35s.
      clearPendingCall(to);
      pendingCalls.set(to, { from: userId, sdp: p.sdp, callId, name: callerName, timer: setTimeout(() => pendingCalls.delete(to), 35_000) });
      getUser(to).then((u) => { if (u) sendWebPush(u, 'call', { callId, from: userId, name: callerName, hasAvatar }).catch(() => {}); }).catch(() => {});
      // Ring live too if their socket is currently connected.
      if (isOnline(to)) emitTo(to, 'call:offer', { from: userId, sdp: p.sdp, callId, name: callerName });
      // Always "ringing" — the caller rings for ~35s while the push wakes the callee, instead of
      // instantly failing with "unavailable" the moment the callee's background socket is gone.
      reply?.({ ok: true });
    }));
    socket.on('call:answer', guard(async (p) => {
      if (typeof p.sdp !== 'string' || p.sdp.length > 20000) return;
      clearPendingCall(userId); // we answered — stop re-ringing
      if (await canMessage(userId, p.to)) emitTo(p.to, 'call:answer', { from: userId, sdp: p.sdp, callId: String(p.callId || '') });
    }));
    socket.on('call:ice', guard(async (p) => {
      if (!callIceLimit(userId)) return;
      if (typeof p.candidate !== 'string' || p.candidate.length > 2000) return;
      if (await canMessage(userId, p.to)) emitTo(p.to, 'call:ice', { from: userId, candidate: p.candidate, callId: String(p.callId || '') });
    }));
    socket.on('call:hangup', guard(async (p) => {
      clearPendingCall(p.to); clearPendingCall(userId); // stop any buffered re-ring for this call
      if (await canMessage(userId, p.to)) emitTo(p.to, 'call:hangup', { from: userId, callId: String(p.callId || ''), reason: String(p.reason || 'end').slice(0, 20) });
    }));

    // Screenshot / screen-recording attempts become a line in the chat for both people.
    const captureEvent = (kind) => guard(async (p, reply) => {
      const other = String(p.with || '');
      if (!(await canMessage(userId, other))) return reply({ error: 'Not a contact' });
      const row = await one(
        `INSERT INTO messages (sender_id, recipient_id, kind, delivered_at, seen_at, expires_at)
         VALUES ($1, $2, $3, now(), now(), now() + interval '24 hours')
         RETURNING id, sender_id, recipient_id, kind, created_at, delivered_at, seen_at, expires_at`,
        [userId, other, kind],
      );
      if (kind === 'screenshot') bumpStat('screenshots');
      emitTo(userId, 'message', serializeMessage(row, userId));
      emitTo(other, 'message', serializeMessage(row, other));
      reply({ ok: true });
    });
    socket.on('screenshot', captureEvent('screenshot'));
    socket.on('recording', captureEvent('recording'));

    socket.on('disconnect', async () => {
      const set = online.get(userId);
      if (set) {
        set.delete(socket.id);
        if (set.size === 0) {
          online.delete(userId);
          // Wait a moment before marking them offline: reloads and reconnects cost no DB write and no flicker.
          goingOffline.set(userId, setTimeout(async () => {
            goingOffline.delete(userId);
            if (online.has(userId)) return;
            const fresh = await one('UPDATE users SET last_active_at = now() WHERE id = $1 RETURNING *', [userId]).catch(() => null);
            if (fresh) {
              cacheUser(fresh);
              broadcastPresence(fresh, false);
            }
          }, OFFLINE_GRACE_MS).unref());
        }
      }
    });
  });

  startSweeper();
  return io;
}
