import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

/**
 * Secrets (login token, private encryption key, PIN hash).
 * Phones: Keychain / Android Keystore via SecureStore. Web: localStorage (browsers have nothing stronger).
 */
export async function getSecret(key: string): Promise<string | null> {
  if (Platform.OS === 'web') {
    try {
      return globalThis.localStorage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  }
  return SecureStore.getItemAsync(key);
}

export async function setSecret(key: string, value: string | null): Promise<void> {
  if (Platform.OS === 'web') {
    try {
      if (value == null) globalThis.localStorage?.removeItem(key);
      else globalThis.localStorage?.setItem(key, value);
    } catch {}
    return;
  }
  if (value == null) await SecureStore.deleteItemAsync(key);
  else await SecureStore.setItemAsync(key, value);
}
