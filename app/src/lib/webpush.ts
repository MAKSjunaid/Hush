import { api } from './api';
import { isWeb } from './config';

// Web Push for the installed PWA (Android & iOS home-screen). No-op on native (that uses Expo push).

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function webPushSupported(): boolean {
  return (
    isWeb &&
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

/**
 * Ask for notification permission (must be called from a user tap, especially on iOS) and subscribe.
 * Returns true if we end up with an active subscription. Safe to call repeatedly.
 */
export async function enableWebPush(vapidPublicKey?: string | null): Promise<boolean> {
  if (!webPushSupported() || !vapidPublicKey) return false;
  try {
    const reg = await navigator.serviceWorker.ready;
    if (Notification.permission === 'default') {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') return false;
    }
    if (Notification.permission !== 'granted') return false;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) as BufferSource,
      });
    }
    await api('/me/web-push', { body: { subscription: sub.toJSON() } });
    return true;
  } catch {
    return false;
  }
}

/** Remove this device's subscription (used when the user turns notifications off). */
export async function disableWebPush(): Promise<void> {
  if (!webPushSupported()) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await api('/me/web-push', { method: 'DELETE', body: { endpoint: sub.endpoint } }).catch(() => {});
      await sub.unsubscribe().catch(() => {});
    }
  } catch {}
}

/** On app start (web): if the user already granted permission, make sure the server has a fresh sub. */
export async function refreshWebPush(vapidPublicKey?: string | null): Promise<void> {
  if (!webPushSupported() || !vapidPublicKey) return;
  if (Notification.permission === 'granted') await enableWebPush(vapidPublicKey);
}
