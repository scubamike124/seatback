/**
 * Private, server-side response cache.
 *
 * Allowed by the developer guide: "Private server-side caching is fine and there is no time
 * limit". Never persisted into the repository.
 */
export interface ResponseCache {
  get(key: string): Promise<unknown | undefined>;
  put(key: string, value: unknown): Promise<void>;
}

/** Small LRU used in tests, the local dev server, and as a per-isolate layer on Workers. */
export class MemoryCache implements ResponseCache {
  readonly #map = new Map<string, unknown>();
  readonly #max: number;
  constructor(max = 500) {
    this.#max = max;
  }
  async get(key: string): Promise<unknown | undefined> {
    if (!this.#map.has(key)) return undefined;
    const v = this.#map.get(key);
    this.#map.delete(key);
    this.#map.set(key, v);
    return v;
  }
  async put(key: string, value: unknown): Promise<void> {
    this.#map.set(key, value);
    if (this.#map.size > this.#max) {
      const oldest = this.#map.keys().next().value;
      if (oldest !== undefined) this.#map.delete(oldest);
    }
  }
}

/** Minimal shape of a Workers KV namespace, so no Cloudflare type package is needed. */
export interface KVLike {
  get(key: string, type: 'json'): Promise<unknown | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
}

/**
 * KV-backed cache keyed by a SHA-256 of the request URL (the URL never contains the key, but
 * hashing keeps KV keys short and opaque). Layered over a MemoryCache.
 */
export class KvCache implements ResponseCache {
  readonly #kv: KVLike;
  readonly #mem = new MemoryCache(200);
  readonly #ttl: number;
  constructor(kv: KVLike, ttlSeconds = 60 * 60 * 24 * 14) {
    this.#kv = kv;
    this.#ttl = ttlSeconds;
  }
  async get(key: string): Promise<unknown | undefined> {
    const m = await this.#mem.get(key);
    if (m !== undefined) return m;
    const v = await this.#kv.get(`qloo:${await sha256(key)}`, 'json');
    if (v === null || v === undefined) return undefined;
    await this.#mem.put(key, v);
    return v;
  }
  async put(key: string, value: unknown): Promise<void> {
    await this.#mem.put(key, value);
    await this.#kv.put(`qloo:${await sha256(key)}`, JSON.stringify(value), { expirationTtl: this.#ttl });
  }
}

export async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
