// Plain-Node host: access gate, private file store, single-instance counters, HTTP adapter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import worker, { type Env } from '../src/worker.ts';
import { COOKIE } from '../src/access.ts';
import { FileCounter, FileStore, MAX_FILES, MAX_VALUE_BYTES } from '../src/storage/file-store.ts';
import { clientAddress, createNodeServer, envFromProcess, installGracefulShutdown } from '../src/server/node-adapter.ts';
import { CallBudgetLedger } from '../src/ratelimit.ts';
import { tmpdir } from './helpers/tmp.ts';

const TOKEN = ['demo', 'token', 'for', 'tests', '0123456789'].join('-');
const get = (env: Env, path: string, headers: Record<string, string> = {}) => worker.fetch(new Request('http://x' + path, { headers: { 'cf-connecting-ip': '9.9.9.9', ...headers } }), env);

// ---------- access gate ----------
test('gate OFF in contest mode: nothing needs a token and the page has no preview banner', async () => {
  const r = await get({}, '/'); assert.equal(r.status, 200); assert.ok(!(await r.text()).includes('PRIVATE PREVIEW'));
});
test('gate ON: /healthz is open and reveals nothing; everything else is 401 without the token', async () => {
  const env: Env = { DEMO_ACCESS_TOKEN: TOKEN };
  const h = await get(env, '/healthz'); assert.equal(h.status, 200); assert.equal(await h.text(), 'ok');
  for (const p of ['/', '/app.js', '/api/config', '/api/health', '/api/example/atl-sea', '/api/admin/warm', '/anything']) { const r = await get(env, p); assert.equal(r.status, 401, p); assert.ok(!(await r.text()).includes(TOKEN)); }
  assert.equal((await get(env, '/?access=wrong-token')).status, 401);
  assert.equal((await get(env, '/?access=')).status, 401);
});
test('gate ON: the right ?access= answers a redirect to the clean URL with an HttpOnly Secure SameSite=Lax cookie that holds no token; the cookie then opens the page with a PRIVATE PREVIEW banner', async () => {
  const env: Env = { DEMO_ACCESS_TOKEN: TOKEN };
  const r = await get(env, '/?access=' + TOKEN + '&x=1');
  assert.equal(r.status, 302); assert.equal(r.headers.get('location'), '/?x=1'); assert.ok(!(r.headers.get('location') ?? '').includes(TOKEN));
  const c = r.headers.get('set-cookie')!;
  assert.match(c, /HttpOnly/); assert.match(c, /Secure/); assert.match(c, /SameSite=Lax/); assert.match(c, /Path=\//); assert.ok(!c.includes(TOKEN));
  const cookie = c.split(';')[0]!;
  const page = await get(env, '/', { cookie });
  assert.equal(page.status, 200); const html = await page.text();
  assert.match(html, /PRIVATE PREVIEW/); assert.ok(!html.includes(TOKEN)); assert.match(page.headers.get('cache-control') ?? '', /no-store/);
  assert.equal((await get(env, '/api/config', { cookie })).status, 200);
  assert.equal((await get(env, '/api/config', { cookie: `${COOKIE}=${'0'.repeat(64)}` })).status, 401, 'a forged cookie value is refused');
  assert.equal((await get(env, '/api/config', { cookie: `${COOKIE}=` })).status, 401, 'an empty cookie is refused');
});
test('gate ON: a POST cannot authenticate with the query token (cookie only), and the token is not accepted from another header', async () => {
  const env: Env = { DEMO_ACCESS_TOKEN: TOKEN };
  const r = await worker.fetch(new Request('http://x/api/slate?access=' + TOKEN, { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '9.9.9.8' }, body: '{}' }), env);
  assert.equal(r.status, 401);
  assert.equal((await get(env, '/', { authorization: 'Bearer ' + TOKEN, 'x-access': TOKEN })).status, 401);
});

// ---------- file store ----------
const tmp = () => mkdtempSync(join(tmpdir(), 'fs-'));
test('file store: round trip, json read, expiry, delete, no temp files left behind', async () => {
  const d = tmp(); let t = 1000;
  try {
    const s = new FileStore(d, () => t);
    await s.put('example:live:x', '{"a":1}'); await s.put('ttl', 'v', { expirationTtl: 10 });
    assert.equal(await s.get('example:live:x'), '{"a":1}'); assert.deepEqual(await s.get('example:live:x', 'json'), { a: 1 }); assert.equal(await s.get('missing'), null);
    assert.equal(await s.get('ttl'), 'v'); t += 11_000; assert.equal(await s.get('ttl'), null, 'expired');
    await s.delete('example:live:x'); assert.equal(await s.get('example:live:x'), null);
    assert.ok(readdirSync(d).every((n) => !n.startsWith('.tmp-')));
  } finally { rmSync(d, { recursive: true, force: true }); }
});
test('file store: size caps refuse an oversize value and a full store', async () => {
  const d = tmp();
  try {
    const s = new FileStore(d);
    await assert.rejects(() => s.put('big', 'x'.repeat(MAX_VALUE_BYTES + 1)), /too large/);
    await s.put('exact', 'x'.repeat(MAX_VALUE_BYTES)); assert.equal((await s.get('exact'))!.length, MAX_VALUE_BYTES);
    for (let i = 0; i < MAX_FILES - 1; i++) writeFileSync(join(d, `${String(i).padStart(64, '0')}.json`), '{}');
    await assert.rejects(() => s.put('one-too-many', 'v'), /full/);
    await s.put('exact', 'overwrite is allowed when full');
  } finally { rmSync(d, { recursive: true, force: true }); }
});
test('file store: a corrupt, truncated or foreign file is refused (an error, never partial data)', async () => {
  const d = tmp();
  try {
    const s = new FileStore(d);
    await s.put('k', 'value');
    const f = join(d, readdirSync(d).find((n) => n.endsWith('.json'))!);
    const good = readFileSync(f, 'utf8');
    writeFileSync(f, good.slice(0, good.length - 5)); await assert.rejects(() => s.get('k'), /corrupt/);
    writeFileSync(f, JSON.stringify({ v: 1, key: 'other-key', value: 'x', exp: null })); await assert.rejects(() => s.get('k'), /corrupt/);
    writeFileSync(f, JSON.stringify({ v: 2, key: 'k', value: 'x', exp: null })); await assert.rejects(() => s.get('k'), /corrupt/);
    writeFileSync(f, '[]'); await assert.rejects(() => s.get('k'), /corrupt/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
test('file store: concurrent writes to one key always leave one complete, valid value; reads during writes never see a partial file', async () => {
  const d = tmp();
  try {
    const s = new FileStore(d);
    const vals = Array.from({ length: 40 }, (_, i) => `v${i}-` + 'z'.repeat(50_000 + i));
    const reads: unknown[] = [];
    await Promise.all([...vals.map((v) => s.put('k', v)), ...Array.from({ length: 40 }, async () => { reads.push(await s.get('k').catch((e: Error) => e)); })]);
    for (const r of reads) assert.ok(r === null || vals.includes(r as string), 'a read is null or one whole value');
    assert.ok(vals.includes((await s.get('k')) as string));
    assert.equal(readdirSync(d).filter((n) => n.endsWith('.json')).length, 1);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
test('file store plugs into the worker: a stored example replays as "stored-recording"; a corrupt one is a labelled 503', async () => {
  const d = tmp();
  try {
    const kv = new FileStore(d);
    await kv.put('example:live:atl-sea', JSON.stringify({ generatedAt: '2026-10-26T10:00:00Z', source: 'qloo-live' }));
    const env: Env = { QLOO_API_KEY: ['FAKE', 'KEY', 'fs', '1234567'].join('-'), LLM_PROVIDER: 'none', CACHE_KV: kv as never };
    const ok = await get(env, '/api/example/atl-sea'); assert.equal(((await ok.json()) as { provenance: string }).provenance, 'stored-recording');
    const f = join(d, readdirSync(d).find((n) => n.endsWith('.json'))!); writeFileSync(f, '{"v":1');
    const bad = await get(env, '/api/example/atl-sea'); assert.equal(bad.status, 503); assert.match(await bad.text(), /Replay unavailable/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ---------- counters ----------
test('file counter: atomic under concurrency, honours the cap through the ledger, expires, and survives a restart', async () => {
  const d = tmp(); let t = 5000;
  try {
    const c = new FileCounter(d, () => t);
    const L = new CallBudgetLedger(c, 100, 1000);
    const res = await Promise.all(Array.from({ length: 10 }, (_, i) => L.reserve('v' + i, 30)));
    assert.equal(res.filter((r) => r.ok).length, 3);
    const again = new FileCounter(d, () => t); // restart: state comes back from counters.json
    assert.equal(await again.add('calls:x', 0, 60), 0);
    assert.equal(await new CallBudgetLedger(again, 100, 1000).reserve('late', 30).then((r) => r.ok), false, 'caps survive a restart');
    t += 3 * 24 * 3600 * 1000; assert.equal(await again.add('calls', 5, 60), 5, 'old keys expire'); 
    writeFileSync(join(d, 'counters.json'), 'garbage'); assert.equal(await new FileCounter(d, () => t).add('k', 2, 60), 2, 'a corrupt counter file starts empty');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ---------- adapter ----------
test('client address: socket by default; platform header only when trusted; XFF uses the last hop; junk falls back', () => {
  const h = { 'x-real-ip': '203.0.113.7', 'x-forwarded-for': '1.2.3.4, 198.51.100.9' } as never;
  assert.equal(clientAddress('10.0.0.5', h, undefined), '10.0.0.5');
  assert.equal(clientAddress('10.0.0.5', h, 'x-real-ip'), '203.0.113.7');
  assert.equal(clientAddress('10.0.0.5', h, 'x-forwarded-for'), '198.51.100.9');
  assert.equal(clientAddress('10.0.0.5', { 'x-real-ip': 'not an ip; drop table' } as never, 'x-real-ip'), '10.0.0.5');
  assert.equal(clientAddress('10.0.0.5', {} as never, 'x-real-ip'), '10.0.0.5');
});
async function serve(env: Env, opts: Parameters<typeof createNodeServer>[1] = {}) {
  const server = createNodeServer(env, opts);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}
test('adapter: /healthz, the page, a streamed NDJSON run in synthetic mode, and the 413 body cap', async () => {
  const { server, base } = await serve({}, { maxBody: 2000 });
  try {
    assert.equal(await (await fetch(base + '/healthz')).text(), 'ok');
    assert.match(await (await fetch(base + '/')).text(), /Seatback/);
    const r = await fetch(base + '/api/slate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ origin: 'Atlanta', destination: 'Seattle', catalogue: 'movie: Paper Comets\nmovie: Glass Orbit', autoConfirm: true }) });
    const types = (await r.text()).trim().split('\n').map((l) => (JSON.parse(l) as { type: string }).type);
    assert.equal(types[0], 'start'); assert.equal(types.at(-1), 'result'); assert.ok(types.length > 5);
    const big = await fetch(base + '/api/slate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ catalogue: 'x'.repeat(5000) }) });
    assert.equal(big.status, 413);
  } finally { server.closeAllConnections(); server.close(); }
});
test('adapter: a chunked body with no Content-Length is cut off at the cap (413) too', async () => {
  const { server, base } = await serve({}, { maxBody: 1000 });
  try {
    const { request } = await import('node:http');
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(base + '/api/slate', { method: 'POST', headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on('error', reject);
      for (let i = 0; i < 5; i++) req.write('x'.repeat(400));
      req.end();
    });
    assert.equal(status, 413);
  } finally { server.closeAllConnections(); server.close(); }
});
test('adapter: a declared Content-Length over the cap is refused at once, without waiting for the body', async () => {
  const { server, base } = await serve({}, { maxBody: 1000 });
  try {
    const { request } = await import('node:http');
    const status = await new Promise<number>((resolve) => {
      const timer = setTimeout(() => resolve(-1), 1500);
      const req = request(base + '/api/slate', { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': '5000' } }, (res) => { clearTimeout(timer); res.resume(); resolve(res.statusCode ?? 0); });
      req.on('error', () => { clearTimeout(timer); resolve(-2); });
      req.write('x'.repeat(10)); // never finishes the declared 5000 bytes
    });
    assert.equal(status, 413);
  } finally { server.closeAllConnections(); server.close(); }
});
test('adapter: the access gate works over real HTTP and the cookie carries the session; spoofed cf-connecting-ip is discarded', async () => {
  const { server, base } = await serve({ DEMO_ACCESS_TOKEN: TOKEN });
  try {
    assert.equal((await fetch(base + '/')).status, 401);
    const r = await fetch(base + '/?access=' + TOKEN, { redirect: 'manual' });
    assert.equal(r.status, 302); const cookie = r.headers.get('set-cookie')!.split(';')[0]!;
    assert.match(await (await fetch(base + '/', { headers: { cookie } })).text(), /PRIVATE PREVIEW/);
    // 70 requests from "different" spoofed addresses still share the one real socket address and hit the per-IP limiter
    const codes = new Set<number>();
    for (let i = 0; i < 70; i++) codes.add((await fetch(base + '/api/config', { headers: { cookie, 'cf-connecting-ip': `7.7.7.${i}` } })).status);
    assert.ok(codes.has(429), 'spoofing the header did not escape the limiter');
  } finally { server.closeAllConnections(); server.close(); }
});
test('graceful shutdown stops accepting, lets the process exit, and is idempotent; envFromProcess takes names only and enables files when DATA_DIR is set', async () => {
  const server = createNodeServer({}); await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const exits: number[] = []; const stop = installGracefulShutdown(server, 5000, (c) => exits.push(c));
  await stop('SIGTERM'); await stop('SIGTERM'); await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(exits, [0]); assert.equal(server.listening, false);
  const d = tmp();
  try {
    const e = envFromProcess({ QLOO_API_KEY: 'k'.repeat(20), DATA_DIR: d, LIVE_ENABLED: '0', RANDOM_OTHER: 'x' });
    assert.equal(e.LIVE_ENABLED, '0'); assert.ok(e.CACHE_KV && e.COUNTER); assert.ok(!('RANDOM_OTHER' in e));
    assert.ok(!envFromProcess({}).CACHE_KV, 'no DATA_DIR means memory only');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ---------- review 9 fixes ----------
import { readFileSync as rf } from 'node:fs';
import { iconSource } from '../scripts/make-icon.ts';
import { ICON_PNG_BASE64 } from '../src/ui/icon.ts';
import { checkAccessToken } from '../src/server/node-adapter.ts';
import { safeLocalPath } from '../src/access.ts';

test('F3: the apple-touch-icon is a real 180x180 PNG made by the committed script, and the manifest points at it; both pass the gate, nothing else does', async () => {
  const png = Buffer.from(ICON_PNG_BASE64, 'base64');
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.readUInt32BE(16), 180); assert.equal(png.readUInt32BE(20), 180);
  assert.equal(rf(join(import.meta.dirname, '../src/ui/icon.ts'), 'utf8'), iconSource(), 'icon.ts is reproducible from scripts/make-icon.ts');
  const env: Env = { DEMO_ACCESS_TOKEN: TOKEN };
  const i = await get(env, '/apple-touch-icon.png'); assert.equal(i.status, 200); assert.equal(i.headers.get('content-type'), 'image/png'); assert.deepEqual(Buffer.from(await i.arrayBuffer()), png);
  const m = await get(env, '/manifest.webmanifest'); assert.equal(m.status, 200);
  const j = (await m.json()) as { display: string; icons: { src: string }[] }; assert.equal(j.display, 'standalone'); assert.equal(j.icons[0]!.src, '/apple-touch-icon.png');
  assert.equal((await get(env, '/apple-touch-icon.png/x')).status, 401); assert.equal((await get(env, '/app.css')).status, 401);
  assert.equal((await worker.fetch(new Request('http://x/manifest.webmanifest', { method: 'POST' }), env)).status, 401);
  assert.match(await (await get({}, '/')).text(), /rel="apple-touch-icon" href="\/apple-touch-icon\.png"[\s\S]*rel="manifest" href="\/manifest\.webmanifest"/);
});
test('F4: the redirect after a valid token is never protocol-relative or off-site', async () => {
  const env: Env = { DEMO_ACCESS_TOKEN: TOKEN };
  assert.equal(safeLocalPath('//evil.example/x'), '/evil.example/x'); assert.equal(safeLocalPath('/\\evil.example'), '/evil.example'); assert.equal(safeLocalPath('///'), '/');
  for (const p of ['//evil.example/x', '///evil.example', '/%5Cevil.example']) {
    const r = await get(env, `${p}?access=${TOKEN}&a=1`);
    assert.equal(r.status, 302); const loc = r.headers.get('location')!;
    assert.ok(loc.startsWith('/') && !loc.startsWith('//') && !loc.includes('\\'), loc); assert.ok(!loc.includes(TOKEN));
  }
});
test('F5: a short token warns below 24 characters and refuses to start in production below 16', () => {
  assert.deepEqual(checkAccessToken(undefined, true), { ok: true });
  assert.deepEqual(checkAccessToken('x'.repeat(24), true), { ok: true });
  const w = checkAccessToken('x'.repeat(20), true); assert.equal(w.ok, true); assert.match(w.warning!, /shorter than 24/);
  const bad = checkAccessToken('x'.repeat(10), true); assert.equal(bad.ok, false); assert.match(bad.warning!, /refusing to start in production/);
  assert.equal(checkAccessToken('x'.repeat(10), false).ok, true, 'a short token only warns outside production');
  const src = rf(join(import.meta.dirname, '../deploy/node.ts'), 'utf8'); assert.match(src, /checkAccessToken\(/); assert.match(src, /process\.exit\(1\)/);
});
test('F6: the server cuts off slow clients: request 30 s, headers 15 s, keep-alive 5 s', () => {
  const s = createNodeServer({}); assert.equal(s.requestTimeout, 30_000); assert.equal(s.headersTimeout, 15_000); assert.equal(s.keepAliveTimeout, 5_000); s.close();
});
test('F8: expired files are purged at startup and on write, so dead entries cannot fill the 500-file cap; /api/config says liveEnabled false in synthetic mode', async () => {
  const d = tmp(); let t = 1000;
  try {
    const s = new FileStore(d, () => t);
    for (let i = 0; i < 10; i++) await s.put('old' + i, 'v', { expirationTtl: 5 });
    await s.put('keep', 'v');
    t += 10_000;
    assert.equal(readdirSync(d).filter((n) => n.endsWith('.json')).length, 11, 'still on disk');
    await s.put('new', 'v'); // write purges the expired ones
    assert.equal(readdirSync(d).filter((n) => n.endsWith('.json')).length, 2);
    t += 10_000; new FileStore(d, () => t); // startup purge of anything else expired (none here), kept entries stay
    assert.equal(await new FileStore(d, () => t).get('keep'), 'v');
    const e = new FileStore(d, () => t); await e.put('x', 'v', { expirationTtl: 1 }); t += 5000;
    assert.equal(new FileStore(d, () => t).purgeExpired(), 0, 'already purged by the constructor');
  } finally { rmSync(d, { recursive: true, force: true }); }
  const cfg = async (env: Env) => ((await (await get(env, '/api/config')).json()) as { liveEnabled: boolean }).liveEnabled;
  assert.equal(await cfg({}), false); assert.equal(await cfg({ LIVE_ENABLED: '1' }), false, 'no key: nothing is live');
  assert.equal(await cfg({ QLOO_API_KEY: ['FAKE', 'KEY', 'x', '1234567'].join('-') }), false);
  assert.equal(await cfg({ QLOO_API_KEY: ['FAKE', 'KEY', 'x', '1234567'].join('-'), LIVE_ENABLED: '1' }), true);
});
