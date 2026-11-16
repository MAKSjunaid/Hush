import crypto from 'node:crypto';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config, r2Enabled } from './config.js';

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

export const mediaEnabled = () => r2Enabled();

const MAX_BYTES = 15 * 1024 * 1024;

/** Media is encrypted on the phone first, so R2 only ever stores unreadable bytes. */
export async function presignUpload(userId, size) {
  const c = s3();
  if (!c) throw new Error('Photo sharing is not set up yet (Cloudflare R2 keys missing on server)');
  if (!Number.isFinite(size) || size <= 0 || size > MAX_BYTES) throw new Error('File too large (max 15 MB)');
  const key = `m/${userId}/${crypto.randomBytes(18).toString('hex')}`;
  const url = await getSignedUrl(
    c,
    new PutObjectCommand({ Bucket: config.r2.bucket, Key: key, ContentType: 'application/octet-stream' }),
    { expiresIn: 300 },
  );
  return { key, uploadUrl: url };
}

export async function presignDownload(key) {
  const c = s3();
  if (!c) throw new Error('Media not configured');
  return getSignedUrl(c, new GetObjectCommand({ Bucket: config.r2.bucket, Key: key }), { expiresIn: 120 });
}

export async function deleteMedia(key) {
  const c = s3();
  if (!c || !key) return;
  try {
    await c.send(new DeleteObjectCommand({ Bucket: config.r2.bucket, Key: key }));
  } catch (e) {
    console.warn('[r2] delete failed', key, e.message);
  }
}
