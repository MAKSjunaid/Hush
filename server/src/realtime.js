import { Server } from 'socket.io';
import { q, one, bumpStat, getSetting } from './db.js';
import { userFromToken } from './auth.js';
import { pushNewMessage } from './push.js';
import { deleteMedia } from './storage.js';
import { config } from './config.js';

let io = null;
/** userId -> Set<socketId> */
const online = new Map();

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
  };
}

export async function canMessage(a, b) {
  const row = await one(
    `SELECT
       EXISTS (SELECT 1 FROM connections
               WHERE status = 'accepted'
                 AND ((requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1))) AS connected,
       EXISTS (SELECT 1 FROM blocks
               WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)) AS blocked`,
    [a, b],
  );
  return row.connected && !row.blocked;
}

async function contactsOf(userId) {
  const { rows } = await q(
    `SELECT CASE WHEN requester_id = $1 THEN addressee_id ELSE requester_id END AS id
       FROM connections WHERE status = 'accepted' AND (requester_id = $1 OR addressee_id = $1)`,
    [userId],
  );
  return rows.map((r) => r.id);
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

/** Deletes expired messages every few seconds and tells both phones. */
function startSweeper() {
  setInterval(async () => {
    try {
      const { rows } = await q(
        'DELETE FROM messages WHERE expires_at <= now() RETURNING id, sender_id, recipient_id, media_key',
      );
      if (rows.length) await vanish(rows);
    } catch (e) {
      console.warn('[sweeper]', e.message);
    }
  }, 4000);
}

function rateLimiter(limit, windowMs) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
    arr.push(now);
    hits.set(key, arr);
    return arr.length <= limit;
  };
}
const sendLimit = rateLimiter(30, 10_000);
const eventLimit = rateLimiter(60, 10_000);

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
    const first = !online.has(userId);
    if (first) online.set(userId, new Set());
    online.get(userId).add(socket.id);

    const me = await one('SELECT * FROM users WHERE id = $1', [userId]);
    await q('UPDATE users SET last_active_at = now() WHERE id = $1', [userId]);
    await q('INSERT INTO user_activity (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [userId]);
    if (first) broadcastPresence(me, true);

    // Everything waiting for this user is now delivered.
    const { rows: delivered } = await q(
      `UPDATE messages SET delivered_at = now()
        WHERE recipient_id = $1 AND delivered_at IS NULL RETURNING id, sender_id, delivered_at`,
      [userId],
    );
    for (const d of delivered) emitTo(d.sender_id, 'delivered', { id: d.id, at: d.delivered_at });

    const announcement = await getSetting('announcement', null);
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

      const sender = await one('SELECT public_key FROM users WHERE id = $1', [userId]);
      const recipient = await one('SELECT * FROM users WHERE id = $1', [to]);
      const deliveredNow = isOnline(to);

      const row = await one(
        `INSERT INTO messages (client_id, sender_id, recipient_id, kind, ciphertext, nonce, self_ciphertext, self_nonce,
                               sender_public_key, media_key, reply_to, view_once, timer_seconds, delivered_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, CASE WHEN $14 THEN now() END)
         ON CONFLICT (sender_id, client_id) DO NOTHING
         RETURNING *`,
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
      if (!deliveredNow) pushNewMessage(recipient, kind);
    }));

    socket.on('seen', guard(async (p, reply) => {
      const ids = Array.isArray(p.ids) ? p.ids.slice(0, 200) : [];
      if (!ids.length) return reply({ ok: true });
      const { rows } = await q(
        `SELECT id, sender_id, recipient_id, timer_seconds, media_key, view_once
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

    // Screenshot / screen-recording attempts become a line in the chat for both people.
    const captureEvent = (kind) => guard(async (p, reply) => {
      const other = String(p.with || '');
      if (!(await canMessage(userId, other))) return reply({ error: 'Not a contact' });
      const row = await one(
        `INSERT INTO messages (sender_id, recipient_id, kind, delivered_at, seen_at, expires_at)
         VALUES ($1, $2, $3, now(), now(), now() + interval '24 hours') RETURNING *`,
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
          await q('UPDATE users SET last_active_at = now() WHERE id = $1', [userId]).catch(() => {});
          const fresh = await one('SELECT * FROM users WHERE id = $1', [userId]).catch(() => null);
          if (fresh) broadcastPresence(fresh, false);
        }
      }
    });
  });

  startSweeper();
  return io;
}
