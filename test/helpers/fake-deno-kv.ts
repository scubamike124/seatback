// In-memory FAKE of the documented Deno KV API (get/set/delete/atomic check+set+commit with versionstamps).
// It yields to the event loop on every read so concurrent callers interleave like real clients. Not real Deno.
import type { DenoKvAtomic, DenoKvEntry, DenoKvLike } from '../../src/storage/deno-kv.ts';

/** Limits VERIFIED from https://docs.deno.com/deploy/kv/manual/transactions/ (read 2026-10-25): value 64 KiB, 100 checks,
 *  1000 mutations, 800 KiB total per atomic op (encoding overhead counts), 90 KiB total key size per op. */
export const LIMITS = { value: 65_536, checks: 100, mutations: 1000, atomicBytes: 800 * 1024, keyBytes: 90 * 1024 };
const keyBytes = (key: unknown[]) => new TextEncoder().encode(JSON.stringify(key)).length;
const sizeOf = (v: unknown): number => (typeof v === 'string' ? new TextEncoder().encode(v).length : v instanceof Uint8Array ? v.length : new TextEncoder().encode(JSON.stringify(v)).length);
function checkEntry(key: unknown[], value: unknown) {
  if (keyBytes(key) > LIMITS.keyBytes) throw new TypeError('key too large');
  if (sizeOf(value) > LIMITS.value) throw new TypeError(`value too large (${sizeOf(value)} > ${LIMITS.value} bytes)`);
}

export class FakeDenoKv implements DenoKvLike {
  readonly raw = (key: unknown[]) => this.#m.get(FakeDenoKv.#k(key));
  keys(): string[] { return [...this.#m.keys()]; }
  readonly #m = new Map<string, { v: unknown; ver: number }>();
  #ver = 0;
  commits = 0; conflicts = 0;
  static #k(key: unknown[]) { return JSON.stringify(key); }
  readonly gets: { key: string; consistency?: string }[] = [];
  async get<T>(key: unknown[], opts?: { consistency?: 'strong' | 'eventual' }): Promise<DenoKvEntry<T>> {
    this.gets.push({ key: FakeDenoKv.#k(key), consistency: opts?.consistency });
    const e = this.#m.get(FakeDenoKv.#k(key));
    await new Promise((r) => setTimeout(r, 0)); // snapshot first, then yield: concurrent readers see the same version
    return { key, value: (e?.v as T) ?? null, versionstamp: e ? String(e.ver) : null };
  }
  async set(key: unknown[], value: unknown): Promise<{ ok: boolean }> { checkEntry(key, value); this.#m.set(FakeDenoKv.#k(key), { v: value, ver: ++this.#ver }); return { ok: true }; }
  async delete(key: unknown[]): Promise<void> { this.#m.delete(FakeDenoKv.#k(key)); }
  atomic(): DenoKvAtomic {
    const checks: { key: unknown[]; versionstamp: string | null }[] = [];
    const sets: [unknown[], unknown][] = [];
    const dels: unknown[][] = [];
    const self = this;
    const a: DenoKvAtomic = {
      check(...c) { checks.push(...c); return a; },
      set(key, value) { checkEntry(key, value); sets.push([key, value]); return a; },
      delete(key) { dels.push(key); return a; },
      async commit() {
        await new Promise((r) => setTimeout(r, 0)); // network latency: other clients can commit between our read and our commit
        if (checks.length > LIMITS.checks) throw new TypeError('too many checks');
        if (sets.length + dels.length > LIMITS.mutations) throw new TypeError('too many mutations');
        const keys = [...sets.map(([k]) => k), ...dels, ...checks.map((c) => c.key)];
        if (keys.reduce((n, k) => n + keyBytes(k), 0) > LIMITS.keyBytes) throw new TypeError('total key size too large');
        if (sets.reduce((n, [k, v]) => n + sizeOf(v) + keyBytes(k) + 16, 0) > LIMITS.atomicBytes) throw new TypeError('atomic payload too large');
        for (const c of checks) {
          const e = self.#m.get(FakeDenoKv.#k(c.key));
          if ((e ? String(e.ver) : null) !== c.versionstamp) { self.conflicts++; return { ok: false }; }
        }
        for (const k of dels) self.#m.delete(FakeDenoKv.#k(k));
        for (const [k, v] of sets) self.#m.set(FakeDenoKv.#k(k), { v, ver: ++self.#ver });
        self.commits++;
        return { ok: true };
      },
    };
    return a;
  }
}
