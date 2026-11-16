import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { TTLCache, registerCache, singleFlight } from './cache.js';

const url = config.databaseUrl;
const useSsl = /sslmode=require/.test(url) || /neon\.tech/.test(url);

// Small pool + short idle timeout: Neon can scale to zero when nobody is chatting.
export const pool = new pg.Pool({
  connectionString: url,
  ssl: useSsl ? { rejectUnauthorized: true } : undefined,
  enableChannelBinding: /channel_binding=require/.test(url),
  max: 5,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 15_000,
  allowExitOnIdle: false,
});

pool.on('error', (err) => console.error('[db] idle client error', err.message));

export const q = (text, params) => pool.query(text, params);

export async function one(text, params) {
  const { rows } = await pool.query(text, params);
  return rows[0] ?? null;
}

export async function migrate() {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const sql = fs.readFileSync(path.join(dir, 'schema.sql'), 'utf8');
  await pool.query(sql);
  await loadSettings();
  console.log('[db] schema ready');
}

// ---------- users (cached) ----------
const users = registerCache(new TTLCache({ ttlMs: 5 * 60_000, max: 10_000 }));
const flight = singleFlight();

/** User row by id, served from memory when possible. */
export function getUser(id) {
  if (!id) return Promise.resolve(null);
  const hit = users.get(id);
  if (hit !== undefined) return Promise.resolve(hit);
  return flight(`u:${id}`, async () => {
    const row = await one('SELECT * FROM users WHERE id = $1', [id]).catch(() => null);
    if (row) users.set(id, row);
    return row;
  });
}

/** Put a fresh row (from an UPDATE ... RETURNING *) into the cache. */
export function cacheUser(row) {
  if (row) users.set(row.id, row);
  return row;
}
export const forgetUser = (id) => users.delete(id);

// ---------- daily stats (batched: one write per minute instead of one per message) ----------
const pending = { messages: 0, screenshots: 0, signups: 0 };
export function bumpStat(field, by = 1) {
  if (field in pending) pending[field] += by;
}
export async function flushStats() {
  const { messages, screenshots, signups } = pending;
  if (!messages && !screenshots && !signups) return;
  pending.messages = pending.screenshots = pending.signups = 0;
  await pool
    .query(
      `INSERT INTO daily_stats (day, messages, screenshots, signups) VALUES (current_date, $1, $2, $3)
       ON CONFLICT (day) DO UPDATE SET messages = daily_stats.messages + $1,
         screenshots = daily_stats.screenshots + $2, signups = daily_stats.signups + $3`,
      [messages, screenshots, signups],
    )
    .catch((e) => console.warn('[stats]', e.message));
}
setInterval(flushStats, 60_000).unref();

// ---------- app settings (kept in memory; DB only on change) ----------
const settings = new Map();
async function loadSettings() {
  const { rows } = await pool.query('SELECT key, value FROM app_settings');
  settings.clear();
  rows.forEach((r) => settings.set(r.key, r.value));
}

export async function getSetting(key, fallback) {
  return settings.has(key) ? settings.get(key) : fallback;
}
export function getSettingSync(key, fallback) {
  return settings.has(key) ? settings.get(key) : fallback;
}

export async function setSetting(key, value) {
  await pool.query(
    `INSERT INTO app_settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, JSON.stringify(value)],
  );
  settings.set(key, value);
}

export async function shutdown() {
  await flushStats();
  await pool.end().catch(() => {});
}
