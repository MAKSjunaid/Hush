import crypto from 'node:crypto';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import { verifySync } from 'otplib';
import { config } from './config.js';
import { q, one, pool, getSetting, setSetting, forgetUser, flushStats } from './db.js';
import { kickUser, emitTo, onlineCount } from './realtime.js';
import { mediaEnabled } from './storage.js';

export const admin = Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const loginLimit = rateLimit({ windowMs: 15 * 60_000, limit: 10, message: { error: 'Too many attempts' } });

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

admin.post('/login', loginLimit, wrap(async (req, res) => {
  const { username, password, code } = req.body || {};
  if (!config.admin.password) return res.status(503).json({ error: 'Set ADMIN_PASSWORD in the server settings first' });
  if (!safeEqual(username, config.admin.username) || !safeEqual(password, config.admin.password)) {
    return res.status(401).json({ error: 'Wrong admin username or password' });
  }
  if (config.admin.totpSecret) {
    const ok = code && verifySync({ secret: config.admin.totpSecret, token: String(code) }).valid;
    if (!ok) return res.status(401).json({ error: 'Wrong 6-digit code', needsCode: true });
  }
  await log(username, 'login', null);
  res.json({ token: jwt.sign({ admin: username }, config.jwtSecret + ':admin', { expiresIn: '12h' }), twoStep: Boolean(config.admin.totpSecret) });
}));

admin.use((req, res, next) => {
  const header = req.headers.authorization || '';
  try {
    const p = jwt.verify(header.replace('Bearer ', ''), config.jwtSecret + ':admin');
    req.admin = p.admin;
    next();
  } catch {
    res.status(401).json({ error: 'Admin login required' });
  }
});

async function log(adminName, action, detail) {
  await q('INSERT INTO admin_logs (admin, action, detail) VALUES ($1,$2,$3)', [adminName, action, detail ? JSON.stringify(detail) : null]);
}

// Counts only. Message contents are end-to-end encrypted and never visible here.
admin.get('/stats', wrap(async (_req, res) => {
  await flushStats();
  const s = await one(`
    SELECT
      (SELECT count(*) FROM users)::int AS total_users,
      (SELECT count(*) FROM users WHERE created_at > now() - interval '1 day')::int AS new_today,
      (SELECT count(*) FROM user_activity WHERE day = current_date)::int AS dau,
      (SELECT count(DISTINCT user_id) FROM user_activity WHERE day > current_date - 30)::int AS mau,
      (SELECT count(*) FROM connections WHERE status = 'accepted')::int AS connections,
      (SELECT count(DISTINCT LEAST(sender_id, recipient_id)::text || GREATEST(sender_id, recipient_id)::text)
         FROM messages WHERE created_at > now() - interval '1 day')::int AS active_conversations,
      (SELECT count(*) FROM messages WHERE kind IN ('text','photo'))::int AS pending_messages,
      (SELECT count(*) FROM messages WHERE kind IN ('text','photo') AND delivered_at IS NULL)::int AS undelivered,
      (SELECT count(*) FROM reports WHERE status = 'open')::int AS open_reports,
      (SELECT count(*) FROM users WHERE status <> 'active')::int AS restricted_users
  `);
  const { rows: days } = await q(`
    SELECT d::date AS day, COALESCE(ds.messages,0) AS messages, COALESCE(ds.screenshots,0) AS screenshots,
           COALESCE(ds.signups,0) AS signups,
           (SELECT count(*) FROM user_activity ua WHERE ua.day = d::date)::int AS active
      FROM generate_series(current_date - 13, current_date, interval '1 day') d
      LEFT JOIN daily_stats ds ON ds.day = d::date ORDER BY d`);
  const dbSize = await one('SELECT pg_database_size(current_database())::bigint AS bytes');
  res.json({
    stats: { ...s, online_now: onlineCount() }, days,
    health: {
      uptimeSeconds: Math.round(process.uptime()),
      memoryMb: Math.round(process.memoryUsage().rss / 1048576),
      dbBytes: Number(dbSize.bytes),
      dbPool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount },
      mediaEnabled: mediaEnabled(),
      node: process.version,
    },
  });
}));

admin.get('/reports', wrap(async (req, res) => {
  const status = req.query.status === 'resolved' ? 'resolved' : 'open';
  const { rows } = await q(`
    SELECT r.*, ru.username AS reporter, tu.username AS reported, tu.status AS reported_status,
           (SELECT count(*) FROM reports r2 WHERE r2.reported_id = r.reported_id)::int AS total_reports
      FROM reports r
      LEFT JOIN users ru ON ru.id = r.reporter_id
      LEFT JOIN users tu ON tu.id = r.reported_id
     WHERE r.status = $1 ORDER BY r.created_at DESC LIMIT 200`, [status]);
  res.json({ reports: rows });
}));

admin.post('/reports/:id/resolve', wrap(async (req, res) => {
  await q(`UPDATE reports SET status = 'resolved' WHERE id = $1`, [req.params.id]);
  await log(req.admin, 'resolve_report', { id: req.params.id });
  res.json({ ok: true });
}));

admin.get('/users', wrap(async (req, res) => {
  const term = String(req.query.q || '').toLowerCase().replace(/[%_\\@]/g, '');
  const { rows } = await q(`
    SELECT u.id, u.username, u.display_name, u.status, u.created_at, u.last_active_at,
           (SELECT count(*) FROM reports r WHERE r.reported_id = u.id)::int AS reports
      FROM users u WHERE lower(u.username) LIKE $1
     ORDER BY u.created_at DESC LIMIT 100`, [`%${term}%`]);
  res.json({ users: rows });
}));

admin.post('/users/:id/status', wrap(async (req, res) => {
  const status = ['active', 'suspended', 'banned'].includes(req.body.status) ? req.body.status : null;
  if (!status) return res.status(400).json({ error: 'Bad status' });
  const u = await one('UPDATE users SET status = $2 WHERE id = $1 RETURNING username', [req.params.id, status]);
  forgetUser(req.params.id);
  if (status !== 'active') kickUser(req.params.id, 'account_' + status);
  await log(req.admin, 'set_status', { user: u?.username, status });
  res.json({ ok: true });
}));

admin.get('/settings', wrap(async (_req, res) => {
  res.json({
    maintenance: await getSetting('maintenance', false),
    announcement: await getSetting('announcement', null),
    minAppVersion: await getSetting('minAppVersion', '1.0.0'),
    latestAppVersion: await getSetting('latestAppVersion', '1.0.0'),
    apkUrl: await getSetting('apkUrl', null),
    iosUrl: await getSetting('iosUrl', null),
    editWindowMinutes: await getSetting('editWindowMinutes', 15),
    usernameCooldownDays: Number(await getSetting('usernameCooldownDays', 30)),
  });
}));

admin.post('/settings', wrap(async (req, res) => {
  const b = req.body || {};
  if ('maintenance' in b) await setSetting('maintenance', Boolean(b.maintenance));
  if ('announcement' in b) {
    const text = String(b.announcement || '').trim().slice(0, 300);
    const value = text ? { text, at: new Date().toISOString() } : null;
    await setSetting('announcement', value);
    if (value) {
      const { rows } = await q('SELECT id FROM users');
      rows.forEach((r) => emitTo(r.id, 'announcement', value));
    }
  }
  if ('editWindowMinutes' in b) {
    const n = Math.round(Number(b.editWindowMinutes));
    await setSetting('editWindowMinutes', Number.isFinite(n) ? Math.max(0, Math.min(1440, n)) : 15);
  }
  if ('usernameCooldownDays' in b) {
    const n = Math.round(Number(b.usernameCooldownDays));
    await setSetting('usernameCooldownDays', Number.isFinite(n) ? Math.max(0, Math.min(3650, n)) : 30);
  }
  for (const k of ['minAppVersion', 'latestAppVersion', 'apkUrl', 'iosUrl']) {
    if (k in b) await setSetting(k, b[k] ? String(b[k]).slice(0, 300) : null);
  }
  await log(req.admin, 'settings', b);
  res.json({ ok: true });
}));

admin.get('/logs', wrap(async (_req, res) => {
  const { rows } = await q('SELECT * FROM admin_logs ORDER BY id DESC LIMIT 200');
  res.json({ logs: rows });
}));
