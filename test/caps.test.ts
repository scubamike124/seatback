// Caps and the kill switch exercised with CORRECT requests (JSON content type, same-origin), as documented in docs/DEPLOY-RAILWAY.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { type Env } from '../src/worker.ts';

const KEY = ['FAKE', 'KEY', 'caps', '7777777'].join('-');
const mk = (origin: string, destination: string) => JSON.stringify({ origin, destination, catalogue: 'movie: Paper Comets\nmovie: Glass Orbit\ntv: Harbor Ward', autoConfirm: true });
const body = mk('Atlanta', 'Seattle');
// Responses are cached per query in live mode, so a test that needs a run to be slow uses cities no earlier test asked about.
const slate = (env: Env, ip: string, b = body) => worker.fetch(new Request('http://x/api/slate', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://x', 'cf-connecting-ip': ip }, body: b }), env);
const err = async (r: Response) => ((await r.json()) as { error: string }).error;

function fakeQloo(gate?: Promise<void>): { restore: () => void; calls: () => number } {
  const real = globalThis.fetch; let n = 0;
  globalThis.fetch = (async (u: string) => {
    n++; if (gate) await gate;
    const url = new URL(String(u));
    return url.pathname === '/search' ? new Response(JSON.stringify({ results: [{ entity_id: 'E1', name: url.searchParams.get('query') }] })) : new Response(JSON.stringify({ results: { entities: [], tags: [], demographics: [], trending: [] } }));
  }) as typeof fetch;
  return { restore: () => { globalThis.fetch = real; }, calls: () => n };
}
const live = (extra: Partial<Env> = {}): Env => ({ QLOO_API_KEY: KEY, LLM_PROVIDER: 'none', ...extra });

test('kill switch: LIVE_ENABLED unset or 0 refuses a correct custom request with 503 and spends no Qloo call; "1" lets it run', async () => {
  const q = fakeQloo();
  try {
    for (const env of [live(), live({ LIVE_ENABLED: '0' })]) { const r = await slate(env, '10.0.0.1'); assert.equal(r.status, 503); assert.match(await err(r), /switched off/); }
    assert.equal(q.calls(), 0);
    const ok = await slate(live({ LIVE_ENABLED: '1' }), '10.0.0.2'); await ok.text();
    assert.equal(ok.status, 200); assert.ok(q.calls() > 0);
  } finally { q.restore(); }
});
test('per-visitor call cap: a visitor whose cap is below one run budget is refused with the visitor message; another cap value lets them in', async () => {
  const q = fakeQloo();
  try {
    const small = live({ LIVE_ENABLED: '1', DAILY_CALL_CAP: '1000', PER_VISITOR_CALL_CAP: '50', MAX_QLOO_CALLS_PER_RUN: '70' });
    const r = await slate(small, '10.0.1.1'); assert.equal(r.status, 429); assert.match(await err(r), /today's Qloo call allowance/i); assert.equal(q.calls(), 0);
    const big = live({ LIVE_ENABLED: '1', DAILY_CALL_CAP: '1000', PER_VISITOR_CALL_CAP: '500', MAX_QLOO_CALLS_PER_RUN: '70' });
    const ok = await slate(big, '10.0.1.2'); await ok.text(); assert.equal(ok.status, 200);
  } finally { q.restore(); }
});
test('daily call cap: while one run holds its reservation a second visitor is refused with the global message; after it ends the unused calls are refunded', async () => {
  let release!: () => void; const gate = new Promise<void>((r) => (release = r));
  const q = fakeQloo(gate);
  try {
    const env = live({ LIVE_ENABLED: '1', DAILY_CALL_CAP: '100', PER_VISITOR_CALL_CAP: '100', MAX_QLOO_CALLS_PER_RUN: '70' });
    const first = await slate(env, '10.0.2.1', mk('Boston', 'Denver')); assert.equal(first.status, 200); // reserved 70 of 100, run is waiting on Qloo
    const second = await slate(env, '10.0.2.2', mk('Chicago', 'Phoenix')); assert.equal(second.status, 429); assert.match(await err(second), /budget is used up/i);
    release(); await first.text();
    const third = await slate(env, '10.0.2.3', mk('Chicago', 'Phoenix')); await third.text(); assert.equal(third.status, 200, 'the first run settled and refunded what it did not use');
  } finally { release(); q.restore(); }
});
test('per-IP live limiter: the fifth custom run from one address inside ten minutes is refused', async () => {
  const q = fakeQloo();
  try {
    const env = live({ LIVE_ENABLED: '1', DAILY_CALL_CAP: '100000', PER_VISITOR_CALL_CAP: '100000', MAX_QLOO_CALLS_PER_RUN: '70' });
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) { const r = await slate(env, '10.0.3.9'); codes.push(r.status); await r.text(); }
    assert.deepEqual(codes, [200, 200, 200, 200, 429]);
  } finally { q.restore(); }
});
test('synthetic mode needs no cap on Qloo (nothing is sent) but the request checks still apply: wrong content type is 415', async () => {
  const r = await worker.fetch(new Request('http://x/api/slate', { method: 'POST', headers: { 'content-type': 'text/plain', 'cf-connecting-ip': '10.0.4.1' }, body }), {});
  assert.equal(r.status, 415);
});
