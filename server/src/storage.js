import crypto from 'node:crypto';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config, r2Enabled } from './config.js';
import { q, one } from './db.js';

let client = null;
function s3() {
  if (!r2Enabled()) return null;
  if (!client) {
    client = new S3Client({
      region: 'auto',
      endpoint: `https://${config.r2.accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: config.r2.accessKeyId, secretAccessKey: config.r2.secretAccessKey },
    });
  }
  return client;
}

/** Photos always work: Cloudflare R2 when its keys are set, otherwise a small table in Postgres. */
export const mediaEnabled = () => true;

// ---- database storage (no card / no R2 needed) ----
// Photos are encrypted on the phone, kept only until seen (or the message expires), then deleted.
export const DB_MAX_BYTES = 2 * 1024 * 1024; // phones shrink photos to ~150–300 KB before sending
const DB_TABLE_CAP = 250 * 1024 * 1024; // safety cap so photos can never fill the free database
let tableBytes = 0;
let tableBytesAt = 0;
async function dbHasRoom(size) {
  if (Date.now() - tableBytesAt > 10 * 60_000) {
    const r = await one("SELECT pg_total_relation_size('media')::bigint AS b").catch(() => null);
    tableBytes = Number(r?.b || 0);
    tableBytesAt = Date.now();
  }
  return tableBytes + size < DB_TABLE_CAP;
}

const sign = (verb, key, exp) =>
  crypto.createHmac('sha256', config.jwtSecret).update(`${verb}:${key}:${exp}`).digest('base64url');

/** Short-lived signed link, so the photo bytes never need the login token and can't be guessed. */
function signedPath(verb, key, ttlSec) {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  return `/api/media/blob/${encodeURIComponent(key)}?e=${exp}&s=${sign(verb, key, exp)}`;
}

export function checkSigned(verb, key, exp, sig) {
  const e = Number(exp);
  if (!Number.isFinite(e) || e < Date.now() / 1000 || typeof sig !== 'string') return false;
  const want = Buffer.from(sign(verb, key, e));
  const got = Buffer.from(sig);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

export async function dbPut(key, buf) {
  if (!buf?.length || buf.length > DB_MAX_BYTES) throw new Error('Photo too large');
  if (!(await dbHasRoom(buf.length))) throw new Error('Photo storage is full right now. Try again later.');
  await q('INSERT INTO media (key, data, size) VALUES ($1, $2, $3) ON CONFLICT (key) DO NOTHING', [key, buf, buf.length]);
  tableBytes += buf.length;
}

export async function dbGet(key) {
  const r = await one('SELECT data FROM media WHERE key = $1', [key]);
  return r?.data ?? null;
}

/** Uploaded but never sent (app closed mid-send): clean up after a day. Runs every 6 hours, one query. */
export function startMediaJanitor() {
  setInterval(() => {
    q(`DELETE FROM media m WHERE m.created_at < now() - interval '1 day'
         AND NOT EXISTS (SELECT 1 FROM messages WHERE media_key = m.key)`).catch(() => {});
  }, 6 * 3600_000).unref();
}

const MAX_BYTES = 15 * 1024 * 1024;

/** Media is encrypted on the phone first, so R2 only ever stores unreadable bytes. */
export async function presignUpload(userId, size) {
  const c = s3();
  const key = `m/${userId}/${crypto.randomBytes(18).toString('hex')}`;
  if (!c) {
    if (!Number.isFinite(size) || size <= 0 || size > DB_MAX_BYTES) throw new Error('Photo too large (max 2 MB)');
    return { key, uploadUrl: signedPath('put', key, 300) };
  }
  if (!Number.isFinite(size) || size <= 0 || size > MAX_BYTES) throw new Error('File too large (max 15 MB)');
  const url = await getSignedUrl(
    c,
    new PutObjectCommand({ Bucket: config.r2.bucket, Key: key, ContentType: 'application/octet-stream' }),
    { expiresIn: 300 },
  );
  return { key, uploadUrl: url };
}

export async function presignDownload(key) {
  const c = s3();
  if (!c) return signedPath('get', key, 120);
  return getSignedUrl(c, new GetObjectCommand({ Bucket: config.r2.bucket, Key: key }), { expiresIn: 120 });
}

export async function deleteMedia(key) {
  if (!key) return;
  const c = s3();
  if (!c) {
    await q('DELETE FROM media WHERE key = $1', [key]).catch(() => {});
    return;
  }
  try {
    await c.send(new DeleteObjectCommand({ Bucket: config.r2.bucket, Key: key }));
  } catch (e) {
    console.warn('[r2] delete failed', key, e.message);
  }
}
