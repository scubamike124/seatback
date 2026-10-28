/** Deno KV adapters (Deno Deploy host). NOT TESTED AGAINST REAL DENO: the unit tests use an in-memory fake of the
 *  documented API (get / set / delete / atomic().check().set().commit()). Only exercised against a fake; not run on real Deno.
 *  The counter uses optimistic concurrency (check the versionstamp, retry), so concurrent reservations cannot all
 *  slip under a cap the way the non-atomic Workers KV counter can. (kv.atomic().sum() is not used: it cannot go down,
 *  and refunds need to.) */
import type { AtomicCounter } from '../ratelimit.ts';

export interface DenoKvEntry<T = unknown> { key: unknown[]; value: T | null; versionstamp: string | null }
export interface DenoKvAtomic {
  check(...checks: { key: unknown[]; versionstamp: string | null }[]): DenoKvAtomic;
  set(key: unknown[], value: unknown, opts?: { expireIn?: number }): DenoKvAtomic;
  delete(key: unknown[]): DenoKvAtomic;
  commit(): Promise<{ ok: boolean }>;
}
export interface DenoKvLike {
  get<T = unknown>(key: unknown[], opts?: { consistency?: 'strong' | 'eventual' }): Promise<DenoKvEntry<T>>;
  set(key: unknown[], value: unknown, opts?: { expireIn?: number }): Promise<{ ok: boolean }>;
  delete(key: unknown[]): Promise<void>;
  atomic(): DenoKvAtomic;
}

const NS = 'seatback';
/** Deno KV reads default to strong consistency, but we pass it explicitly everywhere so a read after our own write can never be stale. */
const STRONG = { consistency: 'strong' } as const;

export class DenoKvCounter implements AtomicCounter {
  readonly #kv: DenoKvLike;
  readonly #retries: number;
  constructor(kv: DenoKvLike, retries = 40) { this.#kv = kv; this.#retries = retries; }
  async add(key: string, n: number, ttlSeconds: number): Promise<number> {
    const k = [NS, 'counter', key];
    for (let i = 0; i < this.#retries; i++) {
      const cur = await this.#kv.get<number>(k, STRONG);
      const next = Math.max(0, (typeof cur.value === 'number' ? cur.value : 0) + n);
      const res = await this.#kv.atomic().check({ key: k, versionstamp: cur.versionstamp }).set(k, next, { expireIn: Math.max(60, ttlSeconds) * 1000 }).commit();
      if (res.ok) return next;
    }
    throw new Error('counter contention: could not commit');
  }
}

/** Limits VERIFIED by the coordinator from https://docs.deno.com/deploy/kv/manual/transactions/ (read 2026-10-25):
 *  value <= 64 KiB; <= 100 checks and <= 1000 mutations per atomic op; atomic op total <= 800 KiB (encoding overhead
 *  counts); total key size per op <= 90 KiB. Recorded examples are ~110-117 KB, so values over 60 KiB are chunked into
 *  <= 60 KiB pieces, all written with their manifest in ONE atomic op; a value whose bytes exceed ~700 KiB is refused. */
export const CHUNK_BYTES = 60 * 1024;
export const MAX_TOTAL_BYTES = 700 * 1024;
interface Manifest { v: 1; gen: string; n: number; len: number; sha: string }

async function sha256Hex(b: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', b as unknown as ArrayBuffer));
  return [...d].map((x) => x.toString(16).padStart(2, '0')).join('');
}
const isManifest = (v: unknown): v is Manifest => !!v && typeof v === 'object' && (v as Manifest).v === 1 && typeof (v as Manifest).gen === 'string';

/** The subset of the Workers KV API the app uses (private replay storage and the Qloo response cache).
 *  Values over CHUNK_BYTES are split into chunks written with their manifest in ONE atomic commit; reads reassemble
 *  and verify length and SHA-256, and refuse (throw) an incomplete or corrupt set rather than serve a partial example. */
export class DenoKvStore {
  readonly #kv: DenoKvLike;
  constructor(kv: DenoKvLike) { this.#kv = kv; }
  async get(key: string, type?: 'json'): Promise<any> {
    const head = (await this.#kv.get<string | Manifest>([NS, 'kv', key], STRONG)).value;
    if (head === null || head === undefined) return null;
    let text: string;
    if (typeof head === 'string') text = head;
    else if (isManifest(head)) {
      const parts: Uint8Array[] = [];
      if (!Number.isInteger(head.n) || head.n < 1 || head.n * CHUNK_BYTES < head.len || (head.n - 1) * CHUNK_BYTES >= head.len) throw new Error(`stored value "${key.slice(0, 40)}" has an inconsistent manifest; refusing to serve it`);
      for (let i = 0; i < head.n; i++) {
        const c = (await this.#kv.get<Uint8Array>([NS, 'kvc', key, head.gen, i], STRONG)).value;
        if (!(c instanceof Uint8Array)) throw new Error(`stored value "${key.slice(0, 40)}" is incomplete (chunk ${i + 1} of ${head.n} missing); refusing to serve it`);
        parts.push(c);
      }
      if ((await this.#kv.get([NS, 'kvc', key, head.gen, head.n], STRONG)).value != null) throw new Error(`stored value "${key.slice(0, 40)}" has an extra chunk; refusing to serve it`);
      const all = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
      let off = 0; for (const p of parts) { all.set(p, off); off += p.length; }
      if (all.length !== head.len || (await sha256Hex(all)) !== head.sha) throw new Error(`stored value "${key.slice(0, 40)}" failed its length/checksum check; refusing to serve it`);
      text = new TextDecoder().decode(all);
    } else return null;
    return type === 'json' ? JSON.parse(text) : text;
  }
  async put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> {
    const o = opts?.expirationTtl ? { expireIn: opts.expirationTtl * 1000 } : undefined;
    const bytes = new TextEncoder().encode(value);
    if (bytes.length > MAX_TOTAL_BYTES) throw new Error(`value for "${key.slice(0, 40)}" is too large to store (${bytes.length} bytes)`);
    const gen = crypto.randomUUID();
    const n = Math.ceil(bytes.length / CHUNK_BYTES);
    const sha = bytes.length > CHUNK_BYTES ? await sha256Hex(bytes) : '';
    for (let attempt = 0; attempt < 20; attempt++) {
      const oldEntry = await this.#kv.get<string | Manifest>([NS, 'kv', key], STRONG);
      const old = oldEntry.value;
      // The versionstamp check makes the swap all-or-nothing: if anyone wrote this key since we read it, nothing is written and we retry,
      // so a reader can see the old set or the new set, never a mix (chunks are generation-tagged and the manifest points at one generation).
      const op = this.#kv.atomic().check({ key: [NS, 'kv', key], versionstamp: oldEntry.versionstamp });
      if (isManifest(old)) for (let i = 0; i < old.n; i++) op.delete([NS, 'kvc', key, old.gen, i]); // overwrite shrinks/removes the old set
      if (bytes.length <= CHUNK_BYTES) op.set([NS, 'kv', key], value, o);
      else {
        for (let i = 0; i < n; i++) op.set([NS, 'kvc', key, gen, i], bytes.slice(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES), o);
        op.set([NS, 'kv', key], { v: 1, gen, n, len: bytes.length, sha } satisfies Manifest, o);
      }
      if ((await op.commit()).ok) return;
    }
    throw new Error('atomic write failed (contention)');
  }
  async delete(key: string): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt++) {
      const entry = await this.#kv.get<string | Manifest>([NS, 'kv', key], STRONG);
      // Manifest and chunks go in one atomic op keyed on the manifest's versionstamp, so a concurrent put cannot leave orphan chunks.
      const op = this.#kv.atomic().check({ key: [NS, 'kv', key], versionstamp: entry.versionstamp });
      if (isManifest(entry.value)) for (let i = 0; i < entry.value.n; i++) op.delete([NS, 'kvc', key, entry.value.gen, i]);
      op.delete([NS, 'kv', key]);
      if ((await op.commit()).ok) return;
    }
    throw new Error('atomic delete failed (contention)');
  }
}
