// Public-demo controls: proxy client address, all-visitor caps, concurrent-run cap, exhausted-budget fallback, gate off, no secrets, kill switch.
// No network: every Qloo call goes to a fake fetch, and no key here is real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import worker, { type Env, activeRunCount } from '../src/worker.ts';
import { clientAddress, createNodeServer, proxyHeaderMode, proxyTrustAdvice, resolveClientAddress } from '../src/server/node-adapter.ts';
import { FileStore } from '../src/storage/file-store.ts';
import { BudgetedLlm } from '../src/llm/budget.ts';
import { CallBudgetLedger, MemoryCounter } from '../src/ratelimit.ts';
import { runPipeline } from '../src/agent/pipeline.ts';
import { createQlooClient } from '../src/qloo/client.ts';
import { EXAMPLE_ROUTES, SYNTHETIC_CATALOGUE } from '../src/examples.ts';
import { FakeLlm, act } from './helpers/fake-llm.ts';
import { tmpdir } from './helpers/tmp.ts';

const KEY = ['FAKE', 'KEY', 'pdc', '5151515'].join('-');
const GEM = ['FAKE', 'GEM', 'pdc', '6262626'].join('-');
const ADM = ['FAKE', 'ADMIN', 'pdc', '7373737'].join('-');
const body = JSON.stringify({ origin: 'Atlanta', destination: 'Seattle', catalogue: 'movie: Paper Comets\nmovie: Glass Orbit\ntv: Harbor Ward', autoConfirm: true });
const slate = (env: Env, ip: string, b = body) => worker.fetch(new Request('http://x/api/slate', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://x', 'cf-connecting-ip': ip }, body: b }), env);
const get = (env: Env, path: string, ip = '9.9.9.9') => worker.fetch(new Request('http://x' + path, { headers: { 'cf-connecting-ip': ip } }), env);
const J = async (r: Response) => (await r.json()) as Record<string, any>;

// ---------- (1) client address behind a proxy ----------
test('proxy header: untrusted by default, exactly two values enable it, spoofed leading entries are ignored', () => {
  const h = { 'x-forwarded-for': '1.1.1.1, 2.2.2.2, 203.0.113.9', 'x-real-ip': '198.51.100.4' } as never;
  assert.equal(clientAddress('10.0.0.5', h, undefined), '10.0.0.5');
  assert.equal(clientAddress('10.0.0.5', h, ''), '10.0.0.5');
  assert.equal(clientAddress('10.0.0.5', h, 'cf-connecting-ip'), '10.0.0.5', 'an unknown header name never enables trust');
  assert.equal(clientAddress('10.0.0.5', h, 'x-forwarded-for'), '203.0.113.9', 'only the entry our proxy appended (the last) counts');
  assert.equal(clientAddress('10.0.0.5', h, ' X-Real-IP '), '198.51.100.4', 'case and spaces in the setting are tolerated');
  assert.equal(proxyHeaderMode('X-Forwarded-For'), 'x-forwarded-for'); assert.equal(proxyHeaderMode('forwarded'), null);
});
test('proxy header: trust on but the header missing or malformed falls back to the socket address and says so (degraded)', () => {
  assert.deepEqual(resolveClientAddress('10.0.0.5', {} as never, 'x-real-ip'), { ip: '10.0.0.5', degraded: true });
  assert.deepEqual(resolveClientAddress('10.0.0.5', { 'x-real-ip': 'a; drop table' } as never, 'x-real-ip'), { ip: '10.0.0.5', degraded: true });
  assert.deepEqual(resolveClientAddress('10.0.0.5', { 'x-real-ip': '203.0.113.7' } as never, 'x-real-ip'), { ip: '203.0.113.7', degraded: false });
  assert.deepEqual(resolveClientAddress(undefined, {} as never, undefined), { ip: 'unknown', degraded: false });
});
test('startup advice is loud about the shared bucket and never echoes more than 40 characters of the setting', () => {
  assert.match(proxyTrustAdvice(undefined, true)!, /ONE rate-limit bucket/); assert.equal(proxyTrustAdvice(undefined, false), undefined);
  assert.match(proxyTrustAdvice('bogus-header', false)!, /not x-real-ip or x-forwarded-for.*ONE rate-limit bucket/);
  assert.equal(proxyTrustAdvice('x-real-ip', true), undefined);
  assert.ok(proxyTrustAdvice('z'.repeat(500), true)!.length < 400);
});
async function serve(env: Env, opts: Parameters<typeof createNodeServer>[1] = {}) {
  const server = createNodeServer(env, opts); await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}
test('HTTP: a visitor cannot choose their own bucket. Without trust all share one (fail safe); with trust each real client has its own; a client-sent cf-connecting-ip is never used', async () => {
  const warns: string[] = [];
  const shared = await serve({}, { warn: (m) => warns.push(m) });
  const trusted = await serve({}, { trustProxyHeader: 'x-forwarded-for', warn: (m) => warns.push(m) });
  try {
    // no trust: spoofing x-forwarded-for / cf-connecting-ip cannot escape the single bucket (60 per minute per address on /api/*)
    let last = 0;
    for (let i = 0; i < 70; i++) last = (await fetch(shared.base + '/api/config', { headers: { 'x-forwarded-for': `7.7.${i}.1`, 'cf-connecting-ip': `8.8.${i}.1` } })).status;
    assert.equal(last, 429, 'spoofed headers did not give 70 separate buckets');
    // trust on: client A is limited, client B (different proxy-appended address) is not
    for (let i = 0; i < 70; i++) await fetch(trusted.base + '/api/config', { headers: { 'x-forwarded-for': 'evil, 203.0.113.50' } });
    assert.equal((await fetch(trusted.base + '/api/config', { headers: { 'x-forwarded-for': 'evil, 203.0.113.50' } })).status, 429);
    assert.equal((await fetch(trusted.base + '/api/config', { headers: { 'x-forwarded-for': 'evil, 203.0.113.51' } })).status, 200);
    // trust on but header absent: degraded, loud log, still served
    assert.equal((await fetch(trusted.base + '/healthz')).status, 200);
    assert.ok(warns.some((w) => /TRUST_PROXY_HEADER=x-forwarded-for is set but a request arrived without a usable value/.test(w)));
  } finally { shared.server.close(); trusted.server.close(); }
});

// ---------- (2) all-visitor caps ----------
test('global API cap: the (N+1)th /api request from different addresses in a minute is 429 with Retry-After; stored/memoised example reads are exempt', async () => {
  const env: Env = { GLOBAL_API_PER_MINUTE: '5' };
  await get(env, '/api/example/atl-sea', '1.0.0.1'); // computes the synthetic example once
  const st: number[] = [];
  for (let i = 0; i < 8; i++) st.push((await get(env, '/api/config', `1.0.1.${i}`)).status);
  assert.deepEqual(st, [200, 200, 200, 200, 200, 429, 429, 429]);
  const r = await get(env, '/api/config', '1.0.1.99'); assert.equal(r.status, 429); assert.ok(Number(r.headers.get('retry-after')) >= 1);
  for (let i = 0; i < 5; i++) assert.equal((await get(env, '/api/example/atl-sea', `1.0.2.${i}`)).status, 200, 'examples still open while the cap is hit');
  assert.equal((await get(env, '/healthz', '1.0.3.1')).status, 200, 'health is never counted');
});
test('global run cap: custom runs per minute across all visitors; the refusal is labelled and points to the examples, which keep working', async () => {
  const env: Env = { GLOBAL_RUNS_PER_MINUTE: '2', GLOBAL_API_PER_MINUTE: '1000' };
  for (let i = 0; i < 2; i++) { const r = await slate(env, `2.0.0.${i}`); assert.equal(r.status, 200); await r.text(); }
  const r = await slate(env, '2.0.0.9'); assert.equal(r.status, 429);
  const j = await J(r); assert.match(j.error, /busy computing runs/); assert.equal(j.fallback, 'stored-examples'); assert.deepEqual(j.exampleIds, EXAMPLE_ROUTES.map((x) => x.id));
  assert.ok(Number(r.headers.get('retry-after')) >= 1);
  assert.equal((await get(env, '/api/example/msp-mco', '2.0.1.1')).status, 200);
});
function fakeQloo(gate: Promise<void>): { restore: () => void; calls: () => number } {
  const real = globalThis.fetch; let n = 0;
  globalThis.fetch = (async (u: string) => {
    n++; await gate; const url = new URL(String(u));
    return url.pathname === '/search' ? new Response(JSON.stringify({ results: [{ entity_id: 'E1', name: url.searchParams.get('query') }] })) : new Response(JSON.stringify({ results: { entities: [] } }));
  }) as typeof fetch;
  return { restore: () => { globalThis.fetch = real; }, calls: () => n };
}
test('concurrent-run cap: with MAX_CONCURRENT_RUNS=1 a second run is refused (503, labelled, Retry-After) while one streams; the slot is freed afterwards', async () => {
  let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
  const q = fakeQloo(gate);
  const env: Env = { QLOO_API_KEY: KEY, LLM_PROVIDER: 'none', LIVE_ENABLED: '1', MAX_CONCURRENT_RUNS: '1', DAILY_CALL_CAP: '100000', PER_VISITOR_CALL_CAP: '100000', GLOBAL_RUNS_PER_MINUTE: '100', GLOBAL_API_PER_MINUTE: '1000' };
  const first = await slate(env, '3.0.0.1', JSON.stringify({ origin: 'Duluth', destination: 'Tulsa', catalogue: 'movie: Paper Comets', autoConfirm: true }));
  try {
    assert.equal(first.status, 200); assert.equal(activeRunCount(), 1);
    const second = await slate(env, '3.0.0.2', JSON.stringify({ origin: 'Boise', destination: 'Omaha', catalogue: 'movie: Glass Orbit', autoConfirm: true }));
    assert.equal(second.status, 503); const j = await J(second); assert.match(j.error, /Too many runs are in progress/); assert.equal(j.fallback, 'stored-examples'); assert.equal(second.headers.get('retry-after'), '10');
  } finally { release(); await first.text(); q.restore(); }
  await new Promise((r) => setTimeout(r, 20)); assert.equal(activeRunCount(), 0, 'the slot is freed when the run ends');
});
test('a refused or failed start never leaks a run slot (bad body, kill switch, exhausted budget)', async () => {
  const before = activeRunCount();
  const env: Env = { QLOO_API_KEY: KEY, LLM_PROVIDER: 'none', DAILY_CALL_CAP: '0' };
  assert.equal((await slate(env, '3.1.0.1')).status, 503); // kill switch (LIVE_ENABLED unset)
  assert.equal((await slate({ ...env, LIVE_ENABLED: '1' }, '3.1.0.2')).status, 429); // budget exhausted
  assert.equal((await slate({}, '3.1.0.3', '{not json')).status, 400);
  assert.equal(activeRunCount(), before);
});

// ---------- (3) exhausted budgets ----------
test('Qloo budget exhausted: custom runs get a labelled fallback (same error text, fallback fields); the stored example still opens as a stored recording', async () => {
  const dir = tmpdir(); const kv = new FileStore(dir);
  try {
    await kv.put('example:live:atl-sea', JSON.stringify({ marker: 'stored-run' }), {});
    const env: Env = { QLOO_API_KEY: KEY, LLM_PROVIDER: 'none', LIVE_ENABLED: '1', DAILY_CALL_CAP: '0', CACHE_KV: kv as never };
    const r = await slate(env, '4.0.0.1'); assert.equal(r.status, 429);
    const j = await J(r); assert.match(j.error, /Today's Qloo call budget is used up\. Example routes still work\./); assert.equal(j.fallback, 'stored-examples'); assert.ok(j.exampleIds.includes('atl-sea'));
    const ex = await get(env, '/api/example/atl-sea', '4.0.0.2'); assert.equal(ex.status, 200);
    const e = await J(ex); assert.equal(e.provenance, 'stored-recording'); assert.deepEqual(e.result, { marker: 'stored-run' });
    const v = await slate({ ...env, DAILY_CALL_CAP: '100000', PER_VISITOR_CALL_CAP: '0' }, '4.0.0.3');
    assert.equal(v.status, 429); assert.match((await J(v)).error, /today's Qloo call allowance/);
  } finally { /* tmpdir is cleaned by the helper's process exit */ }
});
test('LLM budget exhausted (per run, and per day via the ledger): the planner stops with llm_budget and the run finishes with the labelled scripted workflow and a full slate', async () => {
  const req = { ...EXAMPLE_ROUTES[0]!.request, catalogue: SYNTHETIC_CATALOGUE, autoConfirm: true, swap: false, compare: false };
  const inner = new FakeLlm(() => act('finish'));
  const perRun = new BudgetedLlm(inner, 0);
  const evs: any[] = [];
  const r1 = (await runPipeline(req, { qloo: createQlooClient({}, { budget: 300 }).client, llm: perRun, planner: { enabled: true }, emit: (e) => evs.push(e) }))!;
  assert.equal(r1.workflow!.kind, 'planner-fallback'); assert.equal(r1.workflow!.label, 'scripted workflow (LLM budget reached)');
  assert.equal(evs.find((e) => e.type === 'step' && e.id === 'llm-model').status, 'warn'); assert.ok(r1.domains.some((d) => d.picks.length > 0));
  const dayLedger = new CallBudgetLedger(new MemoryCounter(), 0, 5, () => new Date(), 'llm');
  const perDay = new BudgetedLlm(inner, 12, { ledger: dayLedger, visitor: 'v1' });
  const r2 = (await runPipeline(req, { qloo: createQlooClient({}, { budget: 300 }).client, llm: perDay, planner: { enabled: true }, emit: () => {} }))!;
  assert.equal(r2.workflow!.kind, 'planner-fallback'); assert.equal(r2.workflow!.label, 'scripted workflow (LLM budget reached)'); assert.equal(inner.prompts.length, 0, 'no model call was made once the budget was gone');
  assert.ok(r2.domains.some((d) => d.picks.length > 0));
});

// ---------- (4) gate off, no secrets, kill switch, hammering ----------
test('DEMO_ACCESS_TOKEN unset: the gate is off for every route and no PRIVATE PREVIEW banner appears', async () => {
  const env: Env = { QLOO_API_KEY: KEY, GEMINI_API_KEY: GEM, ADMIN_TOKEN: ADM, LIVE_ENABLED: '0' };
  for (const p of ['/', '/api/config', '/api/health', '/healthz']) assert.equal((await get(env, p, '5.0.0.' + p.length)).status, 200, p);
  assert.ok(!(await (await get(env, '/', '5.0.1.1')).text()).includes('PRIVATE PREVIEW'));
  const set: Env = { DEMO_ACCESS_TOKEN: 'x'.repeat(24) };
  assert.equal((await get(set, '/api/config', '5.0.2.1')).status, 401, 'control: with a token set the gate is on');
});
test('no secret reaches a client: pages, scripts, config, health, example, and error bodies never contain any configured key', async () => {
  const dir = tmpdir(); const kv = new FileStore(dir);
  const env: Env = { QLOO_API_KEY: KEY, GEMINI_API_KEY: GEM, ADMIN_TOKEN: ADM, LIVE_ENABLED: '0', DAILY_CALL_CAP: '0', CACHE_KV: kv as never };
  const bodies: string[] = [];
  for (const [i, p] of ['/', '/app.js', '/api/config', '/api/health', '/api/example/atl-sea', '/nope'].entries()) { const r = await get(env, p, '5.1.0.' + i); bodies.push(await r.text(), JSON.stringify([...r.headers])); }
  const rs = await slate(env, '5.1.1.1'); bodies.push(await rs.text(), JSON.stringify([...rs.headers]));
  const adm = await worker.fetch(new Request('http://x/api/admin/warm', { method: 'POST', headers: { authorization: 'Bearer wrong', 'cf-connecting-ip': '5.1.2.2' } }), env); bodies.push(await adm.text());
  assert.equal(adm.status, 403);
  for (const b of bodies) for (const s of [KEY, GEM, ADM]) assert.ok(!b.includes(s), 'a secret leaked');
});
test('kill switch: LIVE_ENABLED unset/0 refuses custom live runs with a labelled 503 and spends no Qloo call; the examples still open', async () => {
  let n = 0; const real = globalThis.fetch; globalThis.fetch = (async () => { n++; return new Response('{}'); }) as typeof fetch;
  try {
    const dir = tmpdir(); const kv = new FileStore(dir); await kv.put('example:live:mia-den', JSON.stringify({ ok: 1 }), {});
    for (const [i, LIVE_ENABLED] of [undefined, '0'].entries()) {
      const env: Env = { QLOO_API_KEY: KEY, LLM_PROVIDER: 'none', CACHE_KV: kv as never, ...(LIVE_ENABLED ? { LIVE_ENABLED } : {}) };
      const r = await slate(env, '6.0.0.' + i); assert.equal(r.status, 503); const j = await J(r); assert.match(j.error, /switched off/); assert.equal(j.fallback, 'stored-examples');
      assert.equal((await get(env, '/api/example/mia-den', '6.0.1.' + i)).status, 200);
    }
    assert.equal(n, 0);
  } finally { globalThis.fetch = real; }
});
test('HTTP hammer: 200 concurrent requests to the real server never produce a 5xx or hang; only 200 and 429 appear; the server still answers afterwards', async () => {
  const s = await serve({ GLOBAL_API_PER_MINUTE: '50' }, { trustProxyHeader: 'x-real-ip' });
  try {
    const codes = await Promise.all(Array.from({ length: 200 }, (_, i) => fetch(s.base + (i % 2 ? '/api/config' : '/api/health'), { headers: { 'x-real-ip': `198.51.100.${i % 40}` } }).then((r) => r.status)));
    const set = new Set(codes); assert.ok([...set].every((c) => c === 200 || c === 429), [...set].join()); assert.ok(codes.filter((c) => c === 429).length > 0, 'the cap engaged');
    assert.equal((await fetch(s.base + '/healthz')).status, 200);
    const big = await fetch(s.base + '/api/slate', { method: 'POST', headers: { 'content-type': 'application/json', origin: s.base }, body: 'x'.repeat(70_000) }); assert.equal(big.status, 413);
  } finally { s.server.close(); }
});
