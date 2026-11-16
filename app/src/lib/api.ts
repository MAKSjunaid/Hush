import { API_URL } from './config';

let authToken: string | null = null;
export const setApiToken = (t: string | null) => {
  authToken = t;
};

export class ApiError extends Error {
  status: number;
  data: any;
  constructor(message: string, status: number, data: any) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}/api${path}`, {
      method: opts.method ?? (opts.body ? 'POST' : 'GET'),
      headers: {
        'content-type': 'application/json',
        ...(authToken ? { authorization: `Bearer ${authToken}` } : {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    throw new ApiError("Can't reach Hush. Check your internet connection.", 0, null);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error || 'Something went wrong', res.status, data);
  return data as T;
}

// ---------- tiny response cache ----------
// Repeated lookups (username checks, searches, config) reuse the earlier answer instead of
// calling the server again, and identical requests in flight are shared.
const cache = new Map<string, { at: number; data: unknown }>();
const inflight = new Map<string, Promise<unknown>>();

export async function apiCached<T = any>(path: string, ttlMs = 30_000): Promise<T> {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.at < ttlMs) return hit.data as T;
  const running = inflight.get(path);
  if (running) return running as Promise<T>;
  const p = api<T>(path)
    .then((data) => {
      if (cache.size > 200) cache.delete(cache.keys().next().value as string);
      cache.set(path, { at: Date.now(), data });
      return data;
    })
    .finally(() => inflight.delete(path));
  inflight.set(path, p);
  return p;
}

export function clearApiCache(prefix = '') {
  for (const k of [...cache.keys()]) if (k.startsWith(prefix)) cache.delete(k);
}
