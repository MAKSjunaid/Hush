/**
 * Small in-memory caches so most requests never touch the database.
 * Every cache is size-capped and pruned, so memory can't grow without limit.
 */
export class TTLCache {
  constructor({ ttlMs, max = 5000 }) {
    this.ttlMs = ttlMs;
    this.max = max;
    this.map = new Map();
  }
  get(key) {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.exp < Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    return hit.value;
  }
  set(key, value, ttlMs = this.ttlMs) {
    if (this.map.size >= this.max) {
      // drop the oldest ~10% (Map keeps insertion order)
      let n = Math.ceil(this.max / 10);
      for (const k of this.map.keys()) {
        this.map.delete(k);
        if (--n <= 0) break;
      }
    }
    this.map.set(key, { value, exp: Date.now() + ttlMs });
    return value;
  }
  delete(key) {
    this.map.delete(key);
  }
  prune() {
    const now = Date.now();
    for (const [k, v] of this.map) if (v.exp < now) this.map.delete(k);
  }
  get size() {
    return this.map.size;
  }
}

/** Runs `fn` once per key at a time; concurrent callers share the same promise. */
export function singleFlight() {
  const inflight = new Map();
  return (key, fn) => {
    if (inflight.has(key)) return inflight.get(key);
    const p = Promise.resolve()
      .then(fn)
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  };
}

const all = [];
export function registerCache(c) {
  all.push(c);
  return c;
}
setInterval(() => all.forEach((c) => c.prune()), 60_000).unref();
