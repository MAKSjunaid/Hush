import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64, encodeUTF8, decodeUTF8 } from 'tweetnacl-util';
import * as Crypto from 'expo-crypto';
import { getSecret, setSecret } from './secure';

// Use the platform's secure random generator.
nacl.setPRNG((x: Uint8Array, n: number) => {
  const bytes = Crypto.getRandomBytes(n);
  for (let i = 0; i < n; i++) x[i] = bytes[i];
});

// Legacy single-key slot (pre-per-account). Kept for migration so existing users don't lose identity.
const LEGACY_SECRET_KEY = 'hush.secretKey';
// Each account keeps its own stable keypair on the device, so logging out and back in — or switching
// accounts — never rotates a key and orphans history. Keyed by username (lowercased).
const slotFor = (account?: string | null) =>
  account ? `hush.secretKey.${String(account).trim().toLowerCase()}` : LEGACY_SECRET_KEY;

export type KeyPair = { publicKey: string; secretKey: string };

/** A fresh key pair for this device. The private half never leaves the phone. */
export function newKeyPair(): KeyPair {
  const kp = nacl.box.keyPair();
  return { publicKey: encodeBase64(kp.publicKey), secretKey: encodeBase64(kp.secretKey) };
}

export async function saveKeyPair(kp: KeyPair, account?: string | null) {
  await setSecret(slotFor(account), JSON.stringify(kp));
}

/**
 * Load this account's keypair. Falls back to the legacy single-key slot (one-time migration) so an
 * existing device keeps its identity and can still read its message history after this upgrade.
 */
export async function loadKeyPair(account?: string | null): Promise<KeyPair | null> {
  let raw = await getSecret(slotFor(account));
  if (!raw && account) raw = await getSecret(LEGACY_SECRET_KEY); // migrate the old device-wide key
  if (!raw) return null;
  try {
    return JSON.parse(raw) as KeyPair;
  } catch {
    return null;
  }
}

export async function clearKeyPair(account?: string | null) {
  await setSecret(slotFor(account), null);
  if (account) await setSecret(LEGACY_SECRET_KEY, null); // also drop the legacy slot for this device
}

/** Message plaintext is a small JSON payload. */
export type Payload =
  | { t: 'text'; body: string; replyText?: string }
  | { t: 'photo'; key: string; nonce: string; w?: number; h?: number };

export function seal(payload: Payload, theirPublicKey: string, mine: KeyPair) {
  const msg = decodeUTF8(JSON.stringify(payload));
  const secret = decodeBase64(mine.secretKey);
  const n1 = nacl.randomBytes(nacl.box.nonceLength);
  const n2 = nacl.randomBytes(nacl.box.nonceLength);
  return {
    ciphertext: encodeBase64(nacl.box(msg, n1, decodeBase64(theirPublicKey), secret)),
    nonce: encodeBase64(n1),
    // A copy only I can read, so my sent messages survive an app restart.
    selfCiphertext: encodeBase64(nacl.box(msg, n2, decodeBase64(mine.publicKey), secret)),
    selfNonce: encodeBase64(n2),
  };
}

export function open(
  ciphertext: string | null,
  nonce: string | null,
  otherPublicKey: string | null,
  mine: KeyPair,
): Payload | null {
  if (!ciphertext || !nonce || !otherPublicKey) return null;
  try {
    const out = nacl.box.open(
      decodeBase64(ciphertext),
      decodeBase64(nonce),
      decodeBase64(otherPublicKey),
      decodeBase64(mine.secretKey),
    );
    return out ? (JSON.parse(encodeUTF8(out)) as Payload) : null;
  } catch {
    return null;
  }
}

/** Photos: encrypted with a one-time key that travels inside the encrypted message. */
export function sealBytes(bytes: Uint8Array) {
  const key = nacl.randomBytes(nacl.secretbox.keyLength);
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  return { data: nacl.secretbox(bytes, nonce, key), key: encodeBase64(key), nonce: encodeBase64(nonce) };
}

export function openBytes(data: Uint8Array, key: string, nonce: string): Uint8Array | null {
  return nacl.secretbox.open(data, decodeBase64(nonce), decodeBase64(key));
}

/** Short safety code both people can compare to confirm nobody is in the middle. */
export function safetyCode(a: string, b: string): string {
  const [x, y] = [a, b].sort();
  const hash = nacl.hash(decodeUTF8(x + y));
  let out = '';
  for (let i = 0; i < 12; i++) out += (hash[i] % 100).toString().padStart(2, '0') + (i % 3 === 2 && i < 11 ? ' ' : '');
  return out;
}

export { encodeBase64, decodeBase64 };
