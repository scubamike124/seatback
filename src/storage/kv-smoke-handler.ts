/** Request handler for the owner's Deno KV smoke app (deploy/kv-smoke.ts). Kept free of Deno globals so it can be tested.
 *  Abuse limits (the URL is public while deployed): an unguessable owner-chosen path token, /sleep clamped to 120 s,
 *  at most 2 long requests at once, /kv at most once per 10 s. All limits are PER INSTANCE (each Deno Deploy isolate counts for itself), so several instances can together exceed them. The token is NOT a secret worth protecting beyond the hour the app lives. */
import { DenoKvStore, type DenoKvLike } from './deno-kv.ts';

export const TOKEN_PLACEHOLDER = 'CHANGE-ME';
export const MAX_SLEEP_S = 120;
export const MAX_LONG_REQUESTS = 2;
export const KV_MIN_INTERVAL_MS = 10_000;
const NS = 'seatback';

export interface SmokeDeps { token: string; openKv: () => Promise<DenoKvLike & { list?: (o: { prefix: unknown[] }) => AsyncIterable<unknown> }>; sleep?: (ms: number) => Promise<void>; now?: () => number; streamTicks?: number }

export function makeSmokeHandler(d: SmokeDeps): (req: Request) => Promise<Response> {
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = d.now ?? Date.now;
  let longRunning = 0, lastKv = -Infinity;
  const hdr = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o, null, 2), { status, headers: hdr });
  const tokenOk = (t: string) => { // constant-time-ish compare; the token is short-lived but cheap to do right
    if (t.length !== d.token.length) return false;
    let x = 0; for (let i = 0; i < t.length; i++) x |= t.charCodeAt(i) ^ d.token.charCodeAt(i);
    return x === 0;
  };
  async function countChunks(kv: any, key: string): Promise<number> { let n = 0; for await (const _ of kv.list({ prefix: [NS, 'kvc', key] })) n++; return n; }

  async function kvSmoke(): Promise<unknown> {
    const out: Record<string, unknown> = {};
    let kv: any;
    try { kv = await d.openKv(); out.kvAvailable = true; } catch (e) { void e; return { kvAvailable: false, error: 'Deno KV could not be opened (details withheld from this public URL; see the deployment logs).', STOP: 'KV unavailable on this plan/app: stop and report.' }; }
    const store = new DenoKvStore(kv);
    const key = 'smoke:value';
    const big = JSON.stringify({ filler: 'x'.repeat(117_000), note: 'é€' });
    out.bigBytes = new TextEncoder().encode(big).length;
    const t0 = now(); await store.put(key, big); out.writeMs = Math.round(now() - t0);
    const t1 = now(); const back = await store.get(key); out.readMs = Math.round(now() - t1);
    out.roundTripEqual = back === big;
    out.chunksAfterBigWrite = await countChunks(kv, key);
    const lat: number[] = [];
    for (let i = 0; i < 12; i++) { const t = now(); await store.get(key); lat.push(Math.round(now() - t)); }
    out.sequentialFullReadMs = lat;
    let stale = 0;
    for (let i = 0; i < 10; i++) { const v = JSON.stringify({ i, pad: 'y'.repeat(70_000 + i) }); await store.put(key, v); if ((await store.get(key)) !== v) stale++; }
    out.staleReadsAfterOverwrite = stale;
    const small = JSON.stringify({ small: true });
    await store.put(key, small);
    out.chunksAfterSmallOverwrite = await countChunks(kv, key);
    out.smallRoundTrip = (await store.get(key)) === small;
    await store.delete(key);
    out.chunksAfterDelete = await countChunks(kv, key);
    out.afterDeleteIsNull = (await store.get(key)) === null;
    out.PASS = out.roundTripEqual === true && out.chunksAfterBigWrite === 2 && out.staleReadsAfterOverwrite === 0 && out.chunksAfterSmallOverwrite === 0 && out.smallRoundTrip === true && out.chunksAfterDelete === 0 && out.afterDeleteIsNull === true;
    return out;
  }

  return async (req: Request) => {
    if (d.token.length < 16 || d.token === TOKEN_PLACEHOLDER || d.token.startsWith(TOKEN_PLACEHOLDER)) return json({ error: 'Edit TOKEN in deploy/kv-smoke.ts to a random string of at least 16 characters, then redeploy. Nothing is served until you do.' }, 503);
    const parts = new URL(req.url).pathname.split('/').filter(Boolean);
    if (parts.length !== 2 || !tokenOk(parts[0]!)) return new Response('Not found', { status: 404 });
    const route = parts[1]!;
    if (route === 'kv') {
      if (now() - lastKv < KV_MIN_INTERVAL_MS) return json({ error: 'Too soon: /kv runs at most once every 10 seconds.' }, 429);
      lastKv = now();
      return json(await kvSmoke());
    }
    if (route === 'sleep' || route === 'stream') {
      if (longRunning >= MAX_LONG_REQUESTS) return json({ error: 'Too many long requests at once.' }, 429);
      if (route === 'sleep') {
        const s = Math.min(Math.max(Number(new URL(req.url).searchParams.get('s')) || 1, 1), MAX_SLEEP_S);
        longRunning++;
        try { await sleep(s * 1000); } finally { longRunning--; }
        return json({ waitedSeconds: s, answered: true });
      }
      const enc = new TextEncoder(); const ticks = d.streamTicks ?? 100; let n = 0;
      longRunning++;
      const body = new ReadableStream({
        async pull(c) { if (n >= ticks) { longRunning--; c.close(); return; } await sleep(1000); n++; c.enqueue(enc.encode(JSON.stringify({ tick: n }) + '\n')); },
        cancel() { longRunning--; },
      });
      return new Response(body, { headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' } });
    }
    return new Response('Not found', { status: 404 });
  };
}
