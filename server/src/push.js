import { Expo } from 'expo-server-sdk';
import { config } from './config.js';
import { q } from './db.js';

const expo = new Expo({ accessToken: config.expoAccessToken });

/**
 * Sends a content-free notification. Message text never leaves the server
 * (the server can't read it anyway), so the push only says "New message".
 */
export async function pushNewMessage(recipient, kind = 'text') {
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
