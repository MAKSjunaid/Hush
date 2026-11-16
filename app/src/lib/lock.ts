import { Platform } from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import * as Crypto from 'expo-crypto';
import { getSecret, setSecret } from './secure';

const PIN_KEY = 'hush.pinHash';
const BIO_KEY = 'hush.lockBiometric';
const DELAY_KEY = 'hush.lockDelay';

async function hashPin(pin: string) {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, `hush:${pin}`);
}

export async function isLockEnabled() {
  return Boolean(await getSecret(PIN_KEY));
}

export async function setPin(pin: string | null) {
  await setSecret(PIN_KEY, pin ? await hashPin(pin) : null);
}

export async function checkPin(pin: string) {
  const stored = await getSecret(PIN_KEY);
  return stored != null && stored === (await hashPin(pin));
}

export async function biometricAvailable() {
  if (Platform.OS === 'web') return false;
  return (await LocalAuthentication.hasHardwareAsync()) && (await LocalAuthentication.isEnrolledAsync());
}

export async function getBiometricPref() {
  return (await getSecret(BIO_KEY)) === '1';
}

export async function setBiometricPref(on: boolean) {
  await setSecret(BIO_KEY, on ? '1' : null);
}

/** Seconds in the background before Hush locks again (0 = immediately). */
export async function getLockDelay() {
  return Number((await getSecret(DELAY_KEY)) ?? '0');
}

export async function setLockDelay(s: number) {
  await setSecret(DELAY_KEY, String(s));
}

export async function unlockWithBiometrics() {
  const r = await LocalAuthentication.authenticateAsync({
    promptMessage: 'Unlock Hush',
    cancelLabel: 'Use PIN',
    disableDeviceFallback: true,
  });
  return r.success;
}
