/** Private file store for the plain-Node host. Same surface as DenoKvStore / Workers KV (get / put / delete) plus a
 *  write-through counter (AtomicCounter) for a SINGLE instance. Files live under DATA_DIR only (never in the repo):
 *  one JSON envelope per key, named by SHA-256 of the key, written to a temp file and renamed (atomic), with value and
 *  total-size caps, expiry, and strict validation on read (a corrupt or foreign file is refused, never served). */
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { AtomicCounter } from '../ratelimit.ts';

export const MAX_VALUE_BYTES = 2 * 1024 * 1024;
export const MAX_FILES = 500;
export const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
interface Envelope { v: 1; key: string; value: string; exp: number | null }

const nameOf = (key: string) => createHash('sha256').update(key).digest('hex') + '.json';

export class FileStore {
  readonly #dir: string;
  readonly #now: () => number;
  constructor(dir: string, now: () => number = Date.now) { this.#dir = dir; this.#now = now; mkdirSync(dir, { recursive: true, mode: 0o700 }); this.purgeExpired(); }

  /** Deletes expired and unreadable files so the file-count cap cannot fill up with dead entries. Runs at startup and on every write. */
  purgeExpired(): number {
    let n = 0;
    for (const f of readdirSync(this.#dir)) {
      if (!f.endsWith('.json') || f === 'counters.json') continue;
      try { const e = JSON.parse(readFileSync(join(this.#dir, f), 'utf8')) as Envelope; if (e.exp !== null && typeof e.exp === 'number' && e.exp <= this.#now()) { rmSync(join(this.#dir, f), { force: true }); n++; } } catch { /* unreadable: left for get() to refuse; not deleted here */ }
    }
    return n;
  }

  async get(key: string, type?: 'json'): Promise<any> {
    let raw: string;
    try { raw = readFileSync(join(this.#dir, nameOf(key)), 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new Error('stored value could not be read'); }
    let env: Envelope;
    try { env = JSON.parse(raw) as Envelope; } catch { throw new Error('stored value is corrupt; refusing to serve it'); }
    if (!env || env.v !== 1 || env.key !== key || typeof env.value !== 'string') throw new Error('stored value is corrupt; refusing to serve it');
    if (env.exp !== null && env.exp <= this.#now()) return null;
    return type === 'json' ? JSON.parse(env.value) : env.value;
  }

  async put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> {
    const bytes = Buffer.byteLength(value);
    if (bytes > MAX_VALUE_BYTES) throw new Error(`value too large to store (${bytes} bytes)`);
    this.purgeExpired();
    const files = readdirSync(this.#dir).filter((n) => n.endsWith('.json'));
    const name = nameOf(key);
    if (!files.includes(name)) {
      if (files.length >= MAX_FILES) throw new Error('store is full (file count cap)');
      const total = files.reduce((n, f) => n + statSync(join(this.#dir, f)).size, 0);
      if (total + bytes > MAX_TOTAL_BYTES) throw new Error('store is full (size cap)');
    }
    const env: Envelope = { v: 1, key, value, exp: opts?.expirationTtl ? this.#now() + opts.expirationTtl * 1000 : null };
    const tmp = join(this.#dir, `.tmp-${randomBytes(8).toString('hex')}`);
    writeFileSync(tmp, JSON.stringify(env), { mode: 0o600 });
    renameSync(tmp, join(this.#dir, name)); // atomic replace: a reader sees the old file or the new one, never a mix
  }

  async delete(key: string): Promise<void> { rmSync(join(this.#dir, nameOf(key)), { force: true }); }
}

/** Single-instance counter: JS runs `add` without yielding between read and write, so it is atomic in this process.
 *  State is written through to <dir>/counters.json so a restart does not reset the daily caps. NOT safe for two instances. */
export class FileCounter implements AtomicCounter {
  readonly #file: string | null;
  readonly #m = new Map<string, { v: number; exp: number }>();
  readonly #now: () => number;
  constructor(dir: string | null, now: () => number = Date.now) {
    this.#now = now;
    this.#file = dir ? join(dir, 'counters.json') : null;
    if (this.#file) { try { for (const [k, e] of Object.entries(JSON.parse(readFileSync(this.#file, 'utf8')) as Record<string, { v: number; exp: number }>)) if (typeof e?.v === 'number' && typeof e?.exp === 'number') this.#m.set(k, e); } catch { /* absent or corrupt: start empty */ } }
  }
  async add(key: string, n: number, ttlSeconds: number): Promise<number> {
    const t = this.#now();
    for (const [k, e] of this.#m) if (e.exp <= t) this.#m.delete(k);
    const cur = this.#m.get(key);
    const v = Math.max(0, (cur?.v ?? 0) + n);
    this.#m.set(key, { v, exp: cur?.exp ?? t + Math.max(60, ttlSeconds) * 1000 });
    this.#persist();
    return v;
  }
  #persist(): void {
    if (!this.#file) return;
    const tmp = `${this.#file}.tmp-${randomBytes(6).toString('hex')}`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.#m)), { mode: 0o600 });
    renameSync(tmp, this.#file);
  }
}
