import { Expo } from 'expo-server-sdk';
import { createRequire } from 'module';
import { config, webPushEnabled } from './config.js';
import { q } from './db.js';

const webpush = createRequire(import.meta.url)('web-push'); // CommonJS module in an ESM server

const expo = new Expo({ accessToken: config.expoAccessToken });

if (webPushEnabled()) {
  webpush.setVapidDetails(config.vapid.subject, config.vapid.publicKey, config.vapid.privateKey);
}

/**
 * Content-free Web Push to the installed PWA (Android & iOS home-screen). Like native push, it only
 * ever says "New message" — the server can't read the text anyway.
 */
export async function sendWebPush(recipient, kind = 'text', meta = null) {
  if (!webPushEnabled()) return;
  // Calls ring even if ordinary message notifications are muted — they're time-sensitive.
  if (kind !== 'call' && recipient.settings?.notifications === false) return;
  const { rows } = await q('SELECT endpoint, sub FROM web_push_subs WHERE user_id = $1', [recipient.id]);
  if (!rows.length) return;
  let title = 'HushChat';
  let body = kind === 'request' ? 'Someone wants to chat with you' : 'New message';
  let data = { type: kind };
  if (kind === 'call') {
    // Caller name is shown (less sensitive than message text) so the callee knows who's calling.
    title = meta?.name || 'Incoming call';
    body = 'Incoming voice call';
    data = { type: 'call', callId: meta?.callId || '', from: meta?.from || '', name: meta?.name || 'Someone' };
    if (meta?.from && meta?.hasAvatar) data.icon = `/api/avatar/${meta.from}`;
  }
  const payload = JSON.stringify({ title, body, type: kind, data });
  await Promise.all(rows.map(async (r) => {
    try {
      await webpush.sendNotification(r.sub, payload, { TTL: 300, urgency: 'high', topic: 'hush-new' });
    } catch (e) {
      // 404/410 mean the subscription is dead — drop it.
      if (e.statusCode === 404 || e.statusCode === 410) {
        await q('DELETE FROM web_push_subs WHERE endpoint = $1', [r.endpoint]).catch(() => {});
      }
    }
  }));
}

/**
 * Sends a content-free notification. Message text never leaves the server
 * (the server can't read it anyway), so the push only says "New message".
 */
export async function pushNewMessage(recipient, kind = 'text') {
  sendWebPush(recipient, kind).catch(() => {}); // PWA (Android & iOS home-screen)
  const token = recipient.push_token;
  if (!token || !Expo.isExpoPushToken(token)) return;
  const muted = recipient.settings?.notifications === false;
  if (muted) return;
  const body = kind === 'request' ? 'Someone wants to chat with you' : 'New message';
  try {
    const tickets = await expo.sendPushNotificationsAsync([
      {
        to: token,
        title: 'Hush',
        body,
        sound: 'default',
        data: { type: kind },
        collapseId: 'hush-new',
        threadId: 'hush',
      },
    ]);
    for (const t of tickets) {
      if (t.status === 'error' && t.details?.error === 'DeviceNotRegistered') {
        await q('UPDATE users SET push_token = NULL WHERE id = $1', [recipient.id]);
      }
    }
  } catch (e) {
    console.warn('[push] failed', e.message);
  }
}
