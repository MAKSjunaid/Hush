import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64, encodeUTF8, decodeUTF8 } from 'tweetnacl-util';
import * as Crypto from 'expo-crypto';
import { getSecret, setSecret } from './secure';

// Use the platform's secure random generator.
nacl.setPRNG((x: Uint8Array, n: number) => {
  const bytes = Crypto.getRandomBytes(n);
  for (let i = 0; i < n; i++) x[i] = bytes[i];
});

const SECRET_KEY = 'hush.secretKey';

export type KeyPair = { publicKey: string; secretKey: string };

/** A fresh key pair for this device. The private half never leaves the phone. */
export function newKeyPair(): KeyPair {
  const kp = nacl.box.keyPair();
  return { publicKey: encodeBase64(kp.publicKey), secretKey: encodeBase64(kp.secretKey) };
}

export async function saveKeyPair(kp: KeyPair) {
  await setSecret(SECRET_KEY, JSON.stringify(kp));
}

export async function loadKeyPair(): Promise<KeyPair | null> {
  const raw = await getSecret(SECRET_KEY);
  return raw ? (JSON.parse(raw) as KeyPair) : null;
}

export async function clearKeyPair() {
  await setSecret(SECRET_KEY, null);
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
