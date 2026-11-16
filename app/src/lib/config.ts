import Constants from 'expo-constants';
import { Platform } from 'react-native';

/**
 * Where the Hush server lives.
 * - Web: the same address the page was opened from (the server hosts the web app), unless overridden.
 * - Phone: EXPO_PUBLIC_API_URL (from app/.env) or "extra.apiUrl" in app.json.
 */
function resolveApiUrl(): string {
  const fromEnv = process.env.EXPO_PUBLIC_API_URL;
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    const { origin, port } = window.location;
    // While developing with `expo start --web` (port 8081) talk to the configured/local server instead.
    if (port === '8081' || port === '19006') return (fromEnv || 'http://localhost:4000').replace(/\/$/, '');
    return origin; // the server hosts the web app, so it's the same address
  }
  if (fromEnv) return fromEnv.replace(/\/$/, '');
  const extra = (Constants.expoConfig?.extra ?? {}) as { apiUrl?: string };
  return (extra.apiUrl || 'http://localhost:4000').replace(/\/$/, '');
}

export const API_URL = resolveApiUrl();
export const APP_VERSION = Constants.expoConfig?.version ?? '1.0.0';
export const isWeb = Platform.OS === 'web';
