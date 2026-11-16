export function initials(name: string) {
  const parts = name.replace(/[._]/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts.length > 1 ? parts[0][0] + parts[1][0] : parts[0].slice(0, 2)).toUpperCase();
}

const AVATAR_COLORS: [string, string][] = [
  ['#3B2F6B', '#D6D0FF'],
  ['#1F3B36', '#A6EED6'],
  ['#3D2A1E', '#F3C9A8'],
  ['#1E2C44', '#A9C7F5'],
  ['#3A2036', '#F0B8E4'],
  ['#2E3320', '#D4E6A5'],
];
const AVATAR_COLORS_LIGHT: [string, string][] = [
  ['#E7E3FF', '#4434B0'],
  ['#D9F3EA', '#155E4A'],
  ['#FBE6D6', '#7A3E12'],
  ['#DDE8FB', '#1D4A8C'],
  ['#F8DDF2', '#7B1E66'],
  ['#E9F1D5', '#45561A'],
];

export function avatarColors(seed: string, dark: boolean) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const list = dark ? AVATAR_COLORS : AVATAR_COLORS_LIGHT;
  return list[h % list.length];
}

export function clock(iso?: string | null) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function shortWhen(iso?: string | null) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return clock(iso);
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  if (now.getTime() - d.getTime() < 6 * 864e5) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

export function lastSeenText(online?: boolean, lastSeen?: string | null) {
  if (online) return 'online';
  if (!lastSeen) return '';
  const mins = Math.round((Date.now() - new Date(lastSeen).getTime()) / 60000);
  if (mins < 1) return 'last seen just now';
  if (mins < 60) return `last seen ${mins} min ago`;
  return `last seen ${shortWhen(lastSeen).toLowerCase()}`;
}

export const TIMER_OPTIONS: { value: number | null; label: string; short: string }[] = [
  { value: null, label: 'As soon as seen', short: 'On seen' },
  { value: 5, label: '5 seconds after seen', short: '5s' },
  { value: 30, label: '30 seconds after seen', short: '30s' },
  { value: 60, label: '1 minute after seen', short: '1m' },
  { value: 3600, label: '1 hour after seen', short: '1h' },
  { value: 86400, label: '24 hours after seen', short: '24h' },
  { value: 604800, label: '7 days after seen', short: '7d' },
];

export const timerShort = (t: number | null) => TIMER_OPTIONS.find((o) => o.value === t)?.short ?? 'On seen';

export function countdown(expiresAt?: string | null) {
  if (!expiresAt) return '';
  const s = Math.max(0, Math.round((new Date(expiresAt).getTime() - Date.now()) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

export function compareVersions(a: string, b: string) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}
