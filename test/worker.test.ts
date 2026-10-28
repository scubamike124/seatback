import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { readBody, type Env } from '../src/worker.ts';
import { WindowLimiter, DailyCap, clientKey, safeEqual } from '../src/ratelimit.ts';
import { csvCell } from '../src/ui/csv.ts';
import { PAGE_HTML } from '../src/ui/page.ts';

const call = (path: string, init: RequestInit = {}, env: Env = {}, ip = '1.1.1.1') =>
  worker.fetch(new Request('http://x' + path, { ...init, headers: { 'cf-connecting-ip': ip, ...(init.method === 'POST' ? { 'content-type': 'application/json' } : {}), ...(init.headers as Record<string, string> | undefined) } }), env);

test('serves the app with a strict CSP and no inline script', async () => {
  const r = await call('/');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy')!, /script-src 'self'/);
  const html = await r.text();
  assert.ok(!/<script>[^<]/.test(html), 'no inline script');
  assert.equal((await call('/app.js')).status, 200);
});

test('replayed examples are labelled with their data source and recording time', async () => {
  const js = await (await call('/app.js')).text();
  assert.ok(js.includes('SYNTHETIC sample data, not Qloo results'));
  assert.ok(js.includes('live Qloo data'));
  assert.ok(js.includes('Replayed from a stored run recorded '));
  assert.ok(js.includes('Computed from synthetic fixtures at '));
  assert.ok(!js.includes('Replaying a recorded run'));
});

test('config reports synthetic mode without a key', async () => {
  const j = (await (await call('/api/config')).json()) as { mode: string; examples: unknown[] };
  assert.equal(j.mode, 'synthetic');
  assert.ok(j.examples.length >= 3);
});

test('example endpoint returns a full result (judge mode)', async () => {
  const j = (await (await call('/api/example/msp-mco')).json()) as { result: { domains: unknown[]; trace: unknown[] } };
  assert.ok(j.result.domains.length > 0);
  assert.ok(j.result.trace.length > 0);
  assert.equal((await call('/api/example/nope')).status, 404);
});

test('slate endpoint streams NDJSON ending in a result', async () => {
  const r = await call('/api/slate', { method: 'POST', body: JSON.stringify({ origin: 'Atlanta', destination: 'Seattle', catalogue: 'movie: Paper Comets\nmovie: Glass Orbit\nmovie: Quiet Fury\ntv: Corner Booth' }) });
  assert.equal(r.headers.get('content-type'), 'application/x-ndjson; charset=utf-8');
  const lines = (await r.text()).trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines[0].type, 'start');
  assert.equal(lines.at(-1).type, 'result');
});

test('live mode: the key never reaches the client, and live runs are rate limited per visitor', async () => {
  const KEY = 'live-secret-key-abc';
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (u: string) => {
    const url = new URL(String(u));
    if (url.pathname === '/search') return new Response(JSON.stringify({ results: [{ entity_id: 'E' + url.searchParams.get('query')!.length, name: url.searchParams.get('query') }] }));
    return new Response(JSON.stringify({ results: { entities: [], tags: [], demographics: [], trending: [] } }));
  }) as typeof fetch;
  try {
    const env: Env = { QLOO_API_KEY: KEY, LLM_PROVIDER: 'none', LIVE_ENABLED: '1' };
    const body = JSON.stringify({ origin: 'Atlanta', destination: 'Seattle', catalogue: 'movie: A film\nmovie: B film\nmovie: C film' });
    const r = await call('/api/slate', { method: 'POST', body }, env, '9.9.9.9');
    const text = await r.text();
    assert.ok(!text.includes(KEY));
    assert.ok(text.includes('qloo-live'));
    for (let i = 0; i < 3; i++) await (await call('/api/slate', { method: 'POST', body }, env, '9.9.9.9')).text();
    const limited = await call('/api/slate', { method: 'POST', body }, env, '9.9.9.9');
    assert.equal(limited.status, 429);
    assert.ok(!(await limited.text()).includes(KEY));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('readBody validates and bounds input', async () => {
  const mk = (b: unknown) => new Request('http://x/api/slate', { method: 'POST', body: typeof b === 'string' ? b : JSON.stringify(b) });
  assert.deepEqual(await readBody(mk('not json')), { error: 'Body must be JSON' });
  assert.match(((await readBody(mk({ origin: 'A', destination: '', catalogue: 'x' }))) as { error: string }).error, /both route ends/);
  const ok = (await readBody(mk({ origin: 'A', destination: 'B', catalogue: 'x', slots: { movie: 99 } }))) as { req: { slots: Record<string, number> } };
  assert.equal(ok.req.slots.movie, 12);
  assert.deepEqual(await readBody(mk({ origin: 'A', destination: 'B', catalogue: 'x'.repeat(30000) })), { error: 'Request too large' });
});

test('WindowLimiter and DailyCap', async () => {
  let t = 0;
  const l = new WindowLimiter(2, 1000, () => t);
  assert.equal(l.check('a'), 0);
  assert.equal(l.check('a'), 0);
  assert.ok(l.check('a') > 0);
  t = 1001;
  assert.equal(l.check('a'), 0);
  const store = new Map<string, string>();
  const cap = new DailyCap(2, { get: async (k) => store.get(k) ?? null, put: async (k, v) => void store.set(k, v) });
  assert.equal(await cap.take(), true);
  assert.equal(await cap.take(), true);
  assert.equal(await cap.take(), false);
});

test('HEAD / returns 200 with no body', async () => {
  const r = await worker.fetch(new Request('http://x/', { method: 'HEAD' }), {});
  assert.equal(r.status, 200);
  assert.equal(await r.text(), '');
});

test('x-forwarded-for is never trusted for rate limiting', () => {
  const a = new Request('http://x/', { headers: { 'x-forwarded-for': '1.2.3.4' } });
  const b = new Request('http://x/', { headers: { 'x-forwarded-for': '5.6.7.8' } });
  assert.equal(clientKey(a), clientKey(b));
  assert.equal(clientKey(new Request('http://x/', { headers: { 'cf-connecting-ip': '9.9.9.9' } })), '9.9.9.9');
});

test('admin warm uses a constant-time token check', async () => {
  assert.equal(await safeEqual('Bearer abc', 'Bearer abc'), true);
  assert.equal(await safeEqual('Bearer abd', 'Bearer abc'), false);
  const env: Env = { ADMIN_TOKEN: 'secret-token' };
  assert.equal((await call('/api/admin/warm', { method: 'POST', headers: { authorization: 'Bearer nope' } }, env)).status, 403);
  assert.equal((await call('/api/admin/warm', { method: 'POST', headers: { authorization: 'Bearer secret-token' } }, env, '2.2.2.2')).status, 200);
});

test('live judge mode refuses to compute examples without the KV cache', async () => {
  const r = await call('/api/example/atl-sea', {}, { QLOO_API_KEY: 'k', LLM_PROVIDER: 'none' }, '3.3.3.3');
  assert.equal(r.status, 503);
  assert.match(((await r.json()) as { error: string }).error, /CACHE_KV/);
});

test('CSV export guards against formula injection', () => {
  assert.equal(csvCell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
  assert.equal(csvCell('+1'), "'+1");
  assert.equal(csvCell('-2'), "'-2");
  assert.equal(csvCell('@SUM'), "'@SUM");
  assert.equal(csvCell('Fargo'), 'Fargo');
  assert.equal(csvCell(42), '42');
});

test('page has a visible h1 and proper tabs', () => {
  assert.match(PAGE_HTML, /<h1[^>]*>Seatback<\/h1>/);
  assert.equal((PAGE_HTML.match(/role="tab"/g) ?? []).length, 6);
  assert.equal((PAGE_HTML.match(/role="tabpanel"/g) ?? []).length, 6);
  assert.equal((PAGE_HTML.match(/aria-controls="tab-/g) ?? []).length, 6);
  assert.match(PAGE_HTML, /data-tab="qloo"[^>]*>How Qloo is used</);
});

test('accessibility basics: skip link, status region, busy flag on results', () => {
  assert.match(PAGE_HTML, /<a class="skip" href="#results">/);
  assert.match(PAGE_HTML, /id="results"[^>]*aria-busy="false"/);
  assert.match(PAGE_HTML, /role="status"/);
});

test('landing impact figures are present and sourced in the README', async () => {
  const { readFileSync } = await import('node:fs');
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(PAGE_HTML, /\$315M/);
  assert.match(readme, /sec\.gov\/Archives\/edgar\/data\/1512077/);
  assert.match(readme, /apex\.aero\/\?p=17674/);
});

test('readBody keeps a short theme and drops an empty one', async () => {
  const mk = (b: unknown) => new Request('http://x/api/slate', { method: 'POST', body: JSON.stringify(b) });
  const a = await readBody(mk({ origin: 'A', destination: 'B', catalogue: 'x', theme: '  holiday season and more words beyond forty characters ' }));
  assert.ok('req' in a && a.req.theme && a.req.theme.length <= 40 && a.req.theme.startsWith('holiday'));
  const b = await readBody(mk({ origin: 'A', destination: 'B', catalogue: 'x', theme: '   ' }));
  assert.ok('req' in b && b.req.theme === undefined);
});
