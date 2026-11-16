import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { config } from './config.js';
import { getUser } from './db.js';

export const USERNAME_RE = /^[a-z0-9](?:[a-z0-9._]{1,22})[a-z0-9]$/; // 3–24 chars
export const RESERVED = new Set([
  'admin', 'administrator', 'hush', 'support', 'help', 'root', 'system', 'official',
  'moderator', 'mod', 'security', 'staff', 'team', 'null', 'undefined', 'me', 'you',
]);

export function normalizeUsername(u) {
  return String(u || '').trim().replace(/^@/, '').toLowerCase();
}

export function validateUsername(u) {
  if (!USERNAME_RE.test(u)) return '3–24 characters: letters, numbers, dot or underscore';
  if (/[._]{2}/.test(u)) return 'No two dots or underscores in a row';
  if (RESERVED.has(u)) return 'This username is reserved';
  return null;
}

export function validatePassword(p) {
  if (typeof p !== 'string' || p.length < 8) return 'Password must be at least 8 characters';
  if (p.length > 128) return 'Password is too long';
  return null;
}

export const hash = (s) => bcrypt.hash(s, 12);
export const compare = (s, h) => bcrypt.compare(s, h);

export function newRecoveryKey() {
  return generateMnemonic(wordlist, 128); // 12 words
}

export function normalizeRecoveryKey(k) {
  return String(k || '').trim().toLowerCase().split(/\s+/).join(' ');
}

export function signToken(user) {
  return jwt.sign({ sub: user.id, tv: user.token_version }, config.jwtSecret, { expiresIn: '90d' });
}

/** Verifies a JWT and that it belongs to the user's current (only) active device. */
export async function userFromToken(token) {
  if (!token) return null;
  let payload;
  try {
    payload = jwt.verify(token, config.jwtSecret);
  } catch {
    return null;
  }
  const user = await getUser(payload.sub);
  if (!user || user.token_version !== payload.tv) return null;
  if (user.status !== 'active') return { ...user, blockedStatus: user.status };
  return user;
}

export async function requireUser(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const user = await userFromToken(token);
  if (!user) return res.status(401).json({ error: 'Please log in again' });
  if (user.blockedStatus) return res.status(403).json({ error: `Your account is ${user.blockedStatus}` });
  req.user = user;
  next();
}

export function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    publicKey: u.public_key,
  };
}

export function selfUser(u) {
  return {
    ...publicUser(u),
    settings: u.settings || {},
    createdAt: u.created_at,
    usernameChangedAt: u.username_changed_at,
  };
}
