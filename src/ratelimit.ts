/**
 * Abuse control for a public, login-free demo (rules require free, unrestricted judge access).
 *
 * Layers:
 * 1. Cloudflare Workers Rate Limiting binding (`RATE_LIMITER`) when configured: per-IP, enforced
 *    at Cloudflare's edge across isolates.
 * 2. An in-memory fixed-window limiter per isolate (always on; also used in local dev and tests).
 * 3. A daily cap on live (Qloo-spending) runs, counted in KV when available.
 * Cached examples bypass the live limits so judges can always see a full result.
 */
export interface RateLimitBinding {
  limit(opts: { key: string }): Promise<{ success: boolean }>;
}

export class WindowLimiter {
  readonly #hits = new Map<string, { start: number; n: number }>();
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  constructor(limit: number, windowMs: number, now: () => number = Date.now) {
    this.#limit = limit;
    this.#windowMs = windowMs;
    this.#now = now;
  }
  /** Returns seconds to wait, or 0 if allowed. */
  check(key: string): number {
    const t = this.#now();
    const h = this.#hits.get(key);
    if (!h || t - h.start >= this.#windowMs) {
      this.#hits.set(key, { start: t, n: 1 });
      if (this.#hits.size > 5000) this.#gc(t);
      return 0;
    }
    if (h.n >= this.#limit) return Math.ceil((h.start + this.#windowMs - t) / 1000);
    h.n++;
    return 0;
  }
  #gc(t: number) {
    for (const [k, v] of this.#hits) if (t - v.start >= this.#windowMs) this.#hits.delete(k);
  }
}

export interface DailyCounterStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
}

/** Soft daily cap (legacy; the Qloo/LLM call ledgers below are the live caps). KV is eventually consistent, so this can overshoot slightly; that is acceptable. */
export class DailyCap {
  readonly #cap: number;
  readonly #store?: DailyCounterStore;
  #local = { day: '', n: 0 };
  constructor(cap: number, store?: DailyCounterStore) {
    this.#cap = cap;
    this.#store = store;
  }
  async take(now = new Date()): Promise<boolean> {
    const day = now.toISOString().slice(0, 10);
    if (this.#local.day !== day) this.#local = { day, n: 0 };
    let n = this.#local.n;
    if (this.#store) n = Math.max(n, Number((await this.#store.get(`cap:${day}`)) ?? 0) || 0);
    if (n >= this.#cap) return false;
    this.#local.n = n + 1;
    await this.#store?.put(`cap:${day}`, String(n + 1), { expirationTtl: 60 * 60 * 48 });
    return true;
  }
}

/**
 * Only Cloudflare's `cf-connecting-ip` is trusted (Cloudflare sets it and clients cannot spoof it
 * through the edge). `x-forwarded-for` is client-controlled and is never used. Other hosts (the
 * Node dev server, the Deno entry) overwrite `cf-connecting-ip` with the socket's address before
 * calling the handler. Without it, all such requests share one bucket.
 */
export function clientKey(req: Request): string {
  return req.headers.get('cf-connecting-ip')?.trim() || 'unknown';
}

/** Constant-time string comparison (compares SHA-256 digests byte by byte without early exit). */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  const ax = new Uint8Array(x);
  const by = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < ax.length; i++) diff |= ax[i]! ^ by[i]!;
  return diff === 0;
}

// ---------- cap in Qloo CALLS, not runs ----------

/**
 * Counter abstraction. `add` returns the NEW total. Cloudflare KV has no atomic increment, so KvCounter
 * is best-effort (see the reserve/settle design below, which bounds overshoot by in-flight reservations).
 * Best-effort on Workers KV: keep LIVE_ENABLED=0 there. `DenoKvCounter` (src/storage/deno-kv.ts) is a real atomic counter (check/set loop); a Durable Object could be another.
 */
export interface AtomicCounter {
  add(key: string, n: number, ttlSeconds: number): Promise<number>;
}

export class MemoryCounter implements AtomicCounter {
  readonly #m = new Map<string, number>();
  async add(key: string, n: number): Promise<number> {
    const v = (this.#m.get(key) ?? 0) + n;
    this.#m.set(key, v);
    return v;
  }
}

export class KvCounter implements AtomicCounter {
  readonly #kv: DailyCounterStore;
  constructor(kv: DailyCounterStore) { this.#kv = kv; }
  async add(key: string, n: number, ttlSeconds: number): Promise<number> {
    const v = Math.max(0, (Number((await this.#kv.get(key)) ?? 0) || 0) + n);
    await this.#kv.put(key, String(v), { expirationTtl: Math.max(60, ttlSeconds) });
    return v;
  }
}

export const DEFAULT_DAILY_CALL_CAP = 600; // global Qloo calls per UTC day (a conservative fraction of an UNKNOWN quota)
export const DEFAULT_VISITOR_CALL_CAP = 120; // Qloo calls per visitor per UTC day

/**
 * Reserve-then-settle accounting in Qloo calls. A run reserves its full per-run budget up front (so
 * concurrent runs cannot all slip under the cap) and refunds what it did not use when it ends.
 */
export class CallBudgetLedger {
  readonly #c: AtomicCounter;
  readonly #daily: number;
  readonly #visitor: number;
  readonly #now: () => Date;
  readonly #prefix: string;
  constructor(counter: AtomicCounter, dailyCap: number, visitorCap: number, now: () => Date = () => new Date(), prefix = 'calls') {
    this.#c = counter; this.#daily = dailyCap; this.#visitor = visitorCap; this.#now = now; this.#prefix = prefix;
  }
  #keys(visitor: string) {
    const day = this.#now().toISOString().slice(0, 10);
    return { g: `${this.#prefix}:${day}:all`, v: `${this.#prefix}:${day}:v:${visitor}` };
  }
  /** `skipVisitor` is for the owner's authenticated warm-up only: the global cap still applies. */
  async reserve(visitor: string, n: number, skipVisitor = false): Promise<{ ok: true } | { ok: false; reason: 'global' | 'visitor' }> {
    const k = this.#keys(visitor);
    const ttl = 60 * 60 * 48;
    if ((await this.#c.add(k.g, n, ttl)) > this.#daily) { await this.#c.add(k.g, -n, ttl); return { ok: false, reason: 'global' }; }
    if (skipVisitor) return { ok: true };
    if ((await this.#c.add(k.v, n, ttl)) > this.#visitor) { await this.#c.add(k.v, -n, ttl); await this.#c.add(k.g, -n, ttl); return { ok: false, reason: 'visitor' }; }
    return { ok: true };
  }
  async settle(visitor: string, reserved: number, used: number, skipVisitor = false): Promise<void> {
    const refund = Math.max(0, reserved - used);
    if (!refund) return;
    const k = this.#keys(visitor);
    await this.#c.add(k.g, -refund, 60 * 60 * 48);
    if (!skipVisitor) await this.#c.add(k.v, -refund, 60 * 60 * 48);
  }
}
