import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';

const url = config.databaseUrl;
const useSsl = /sslmode=require/.test(url) || /neon\.tech/.test(url);

export const pool = new pg.Pool({
  connectionString: url,
  ssl: useSsl ? { rejectUnauthorized: true } : undefined,
  enableChannelBinding: /channel_binding=require/.test(url),
  max: 10,
  idleTimeoutMillis: 30_000,
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
  console.log('[db] schema ready');
}

export async function bumpStat(field, by = 1) {
  if (!['messages', 'screenshots', 'signups'].includes(field)) return;
  await pool.query(
    `INSERT INTO daily_stats (day, ${field}) VALUES (current_date, $1)
     ON CONFLICT (day) DO UPDATE SET ${field} = daily_stats.${field} + $1`,
    [by],
  );
}

export async function getSetting(key, fallback) {
  const row = await one('SELECT value FROM app_settings WHERE key = $1', [key]);
  return row ? row.value : fallback;
}

export async function setSetting(key, value) {
  await pool.query(
    `INSERT INTO app_settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, JSON.stringify(value)],
  );
}
