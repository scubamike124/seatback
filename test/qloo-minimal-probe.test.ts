// Offline tests for scripts/qloo-minimal-probe.ts. A stub fetch plays Qloo; the key is a FAKE string. No network, no real key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { assertClean, callCap, runProbe, MAX_CALLS } from '../scripts/qloo-minimal-probe.ts';
import { HttpQlooClient } from '../src/qloo/http-client.ts';

const FAKE_KEY = ['FAKEQLOOKEY', 'a1B2c3D4e5F6g7H8'].join('-');
const root = new URL('..', import.meta.url).pathname;
const ent = (i: number, name: string) => ({ entity_id: `E${i}-0000-4000-8000-00000000000${i}`, name, query: { affinity: 0.5 + i / 20 }, tags: [] });
const search = { success: true, results: [ent(1, 'Fairbanks, Alaska'), ent(2, 'Fairbanks North Star')] };
const insights = { success: true, results: { entities: [ent(3, 'Real Film A'), ent(4, 'Real Film B'), ent(5, 'Real Film C')] } };

interface Stub { calls: { url: string; key: string | null }[]; fetch: typeof fetch; clock: { t: number } }
function stub(opts: { dateFrozen?: boolean; status?: (n: number, url: string) => number; echoKey?: boolean; synthetic?: boolean } = {}): Stub {
  const clock = { t: Date.UTC(2026, 9, 27, 12, 0, 0) };
  const calls: Stub['calls'] = [];
  const f = (async (url: string, init: RequestInit) => {
    const key = new Headers(init.headers as HeadersInit).get('x-api-key');
    calls.push({ url: String(url), key });
    const n = calls.length;
    const st = opts.status?.(n, String(url)) ?? (n === 4 ? 403 : 200); // call 4 is the deliberate bad request
    const h: Record<string, string> = { 'content-type': 'application/json', date: new Date(opts.dateFrozen ? Date.UTC(2026, 9, 27, 12, 0, 0) : clock.t).toUTCString(), 'x-request-id': `req-${n}` };
    if (opts.echoKey) { h['x-echo-key'] = String(key); h['x-debug'] = `X-Api-Key: ${key}`; }
    let body: unknown;
    if (st !== 200) body = { error: opts.echoKey ? `bad key ${key} (header X-Api-Key: ${key})` : 'nope' };
    else if (String(url).includes('/search')) body = opts.synthetic ? { results: [{ entity_id: 'SYN-1', name: 'Place (synthetic)' }] } : search;
    else body = insights;
    return new Response(JSON.stringify(body), { status: st, headers: h });
  }) as unknown as typeof fetch;
  return { calls, fetch: f, clock };
}
const run = async (s: Stub, extra: Partial<Parameters<typeof runProbe>[0]> = {}) => {
  const lines: string[] = [];
  const rep = await runProbe({ key: FAKE_KEY, fetchImpl: s.fetch, repoRoot: root, now: () => s.clock.t, sleep: async (ms) => { s.clock.t += ms; }, log: (l) => lines.push(l), ...extra });
  return { rep, lines };
};
const scan = (text: string) => { assert.ok(!text.includes(FAKE_KEY), 'the key string must not appear'); assert.ok(!/FAKEQLOOKEY|x-api-key\s*[:=]\s*\S{8,}/i.test(text), 'no key shape'); };

test('happy path: live-shaped answers pass every genuineness check, calls are capped, the key travels only in the X-Api-Key header', async () => {
  const s = stub(); const { rep, lines } = await run(s);
  assert.equal(rep.verdict, 'PASS', JSON.stringify(rep.checks.filter((c) => !c.ok)));
  assert.ok(s.calls.length <= MAX_CALLS && s.calls.length >= 3);
  assert.ok(s.calls.every((c) => c.key === FAKE_KEY && !c.url.includes(FAKE_KEY) && c.url.startsWith('https://hackathon.api.qloo.com/')), 'header only, hackathon host only');
  for (const id of ['live_mode', 'status_200', 'server_date_headers', 'second_call_new_date', 'differs_from_fixture', 'no_synthetic_marks', 'schema_valid', 'fresh_query_not_in_repo']) assert.ok(rep.checks.find((c) => c.id === id)?.ok, id);
  scan(lines.join('\n') + JSON.stringify(rep));
});

test('a replay (identical Date on the repeat, as a cache or stored example would give) fails the cache-bypass proof', async () => {
  const { rep } = await run(stub({ dateFrozen: true }));
  assert.equal(rep.verdict, 'FAIL'); assert.equal(rep.checks.find((c) => c.id === 'second_call_new_date')?.ok, false);
});

test('fixture-looking answers (SYN- ids, "(synthetic)") fail the genuine-live checks', async () => {
  const { rep } = await run(stub({ synthetic: true }));
  assert.equal(rep.verdict, 'FAIL'); assert.equal(rep.checks.find((c) => c.id === 'no_synthetic_marks')?.ok, false);
});

test('401, 429 and 5xx abort at once with a single call and no retry; the message never carries the key', async () => {
  for (const code of [401, 429, 500, 503]) {
    const s = stub({ status: () => code, echoKey: true }); const { rep, lines } = await run(s);
    assert.equal(rep.verdict, 'ABORTED', String(code)); assert.equal(s.calls.length, 1, `no retry after ${code}`);
    scan(lines.join('\n') + JSON.stringify(rep));
  }
});

test('a hostile server that echoes the key in headers and error bodies leaks nothing into stdout, the report or the written summary', async () => {
  const s = stub({ echoKey: true, status: (n) => (n === 4 ? 403 : 200) }); const { rep, lines } = await run(s);
  const text = lines.join('\n') + JSON.stringify(rep);
  scan(text); assert.ok(rep.calls.every((c) => !('x-echo-key' in c.headers) && !('x-debug' in c.headers)), 'non-allowlisted headers are recorded by name only');
  assert.ok(rep.calls.some((c) => c.headerNames.includes('x-echo-key')), 'but the name is shown so the owner can see it exists');
  assert.doesNotThrow(() => assertClean(text, FAKE_KEY));
  assert.throws(() => assertClean(text + FAKE_KEY, FAKE_KEY), /secret-shaped/);
});

test('the call cap is the literal 5 and the 6th call is refused by the probe\'s own counter (fails if the cap is raised or the check is removed)', async () => {
  assert.equal(MAX_CALLS, 5);
  assert.match(readFileSync(new URL('../scripts/qloo-minimal-probe.ts', import.meta.url), 'utf8'), /export const MAX_CALLS = 5;/);
  const cap = callCap(); let fetched = 0;
  const f = (async () => { fetched++; return new Response(JSON.stringify({ success: true, results: [] }), { status: 200 }); }) as unknown as typeof fetch;
  const c = new HttpQlooClient({ apiKey: FAKE_KEY, fetchImpl: f, maxRetries: 0, maxConcurrent: 1, onNetworkCall: cap.hook });
  for (let i = 0; i < 5; i++) await c.searchLocality('Q' + i);
  await assert.rejects(() => c.searchLocality('Q9'), (e: Error) => /call cap/.test(e.message));
  assert.equal(fetched, 5, 'fetch ran exactly 5 times; the 6th never left');
  assert.equal(cap.used(), 6);
});

test('retries are off: one attempt per failing call (a 500 is attempted once)', async () => {
  const s = stub({ status: () => 500 }); const { rep } = await run(s);
  assert.equal(s.calls.length, 1); assert.equal(rep.verdict, 'ABORTED');
});

// Host override env vars must never change the host: checked in a CHILD process so module-load-time overrides would show too.
test('host-override environment variables are ignored: every URL still starts with https://hackathon.api.qloo.com/', () => {
  const code = `import { HttpQlooClient } from ${JSON.stringify(new URL('../src/qloo/http-client.ts', import.meta.url).href)};
const urls = []; const f = async (u) => { urls.push(String(u)); return new Response(String(u).includes('/search') ? '{"success":true,"results":[]}' : '{"success":true,"results":{"entities":[]}}', { status: 200 }); };
const c = new HttpQlooClient({ apiKey: 'FAKEQLOOKEY-zzzzzzzzzzzzzzzz', fetchImpl: f, maxRetries: 0 });
await c.searchLocality('X'); await c.insights({ domain: 'movie', location: { query: 'X' }, take: 1 });
console.log(JSON.stringify(urls));`;
  const evil = 'https://evil.example';
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, QLOO_BASE_URL: evil, QLOO_BASE: evil, QLOO_API_BASE: evil, QLOO_API_URL: evil, QLOO_HOST: evil, QLOO_ENDPOINT: evil, HACKATHON_BASE_URL: evil, BASE_URL: evil, API_BASE_URL: evil, HTTPS_PROXY: 'http://evil.example:8080', HTTP_PROXY: 'http://evil.example:8080' } as NodeJS.ProcessEnv;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: root, env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const urls = JSON.parse(r.stdout.trim()) as string[];
  assert.equal(urls.length, 2); assert.ok(urls.every((u) => u.startsWith('https://hackathon.api.qloo.com/')), urls.join(' '));
});

test('redirects are never followed: the request asks for redirect "manual", and a 3xx aborts with no Location and no key in the message', async () => {
  let init: RequestInit | undefined;
  const f = (async (_u: string, i: RequestInit) => { init = i; return new Response('', { status: 302, headers: { location: 'https://evil.example/steal' } }); }) as unknown as typeof fetch;
  const c = new HttpQlooClient({ apiKey: FAKE_KEY, fetchImpl: f, maxRetries: 0 });
  await assert.rejects(() => c.searchLocality('X'), (e: Error) => /redirect/.test(e.message) && !/evil|steal|Location/i.test(e.message) && !e.message.includes(FAKE_KEY));
  assert.equal(init?.redirect, 'manual');
  const s = stub({ status: () => 301 }); const { rep, lines } = await run(s);
  assert.equal(rep.verdict, 'ABORTED'); assert.equal(s.calls.length, 1); scan(lines.join('\n') + JSON.stringify(rep));
});

test('the Gemini client and smoke script also never follow redirects (same one-line pattern, same risk)', () => {
  for (const f of ['../src/llm/provider.ts', '../scripts/gemini-smoke.ts']) {
    const t = readFileSync(new URL(f, import.meta.url), 'utf8');
    const inits = (t.match(/signal: AbortSignal\.timeout\(/g) ?? []).length, manual = (t.match(/redirect: 'manual', signal: AbortSignal\.timeout\(/g) ?? []).length;
    assert.ok(inits > 0 && inits === manual, `${f}: ${manual} of ${inits} fetch inits set redirect manual`);
  }
});

const STUB = new URL('./helpers/stub-fetch.mjs', import.meta.url).href;
test('script: no --yes refuses (exit 2), --dry-run prints a plan, calls nothing and never prints the key', () => {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, QLOO_API_KEY: FAKE_KEY } as NodeJS.ProcessEnv;
  // Neither spawn passes --yes, and both preload the fetch stub, so no network call is possible even if a key were found.
  const a = spawnSync(process.execPath, ['--import', STUB, 'scripts/qloo-minimal-probe.ts'], { cwd: root, env, encoding: 'utf8' });
  assert.equal(a.status, 2); scan(a.stdout + a.stderr); assert.ok(!/STUB-FETCH/.test(a.stderr), 'refusal makes no fetch attempt');
  const b = spawnSync(process.execPath, ['--import', STUB, 'scripts/qloo-minimal-probe.ts', '--dry-run'], { cwd: root, env, encoding: 'utf8' });
  assert.equal(b.status, 0); scan(b.stdout + b.stderr); assert.match(b.stdout, /C1 \/search/); assert.ok(!/STUB-FETCH/.test(b.stderr), 'dry run makes no fetch attempt');
});

// SAFETY (review C1): this is the ONLY test that passes --yes. It is skipped when a .dev.vars exists (the script would read a real key from
// it), it preloads the fetch stub (so even a found key could not reach the network: any attempt is reported as STUB-FETCH and fails the test),
// and the environment carries no key. It proves that without a key the script refuses before building a client.
test('script --yes with no key refuses (exit 2) before any client or fetch exists', { skip: existsSync(new URL('../.dev.vars', import.meta.url)) && 'a real .dev.vars exists: not run, so the test can never use a real key' }, () => {
  const c = spawnSync(process.execPath, ['--import', STUB, 'scripts/qloo-minimal-probe.ts', '--yes'], { cwd: root, env: { PATH: process.env.PATH, HOME: process.env.HOME } as NodeJS.ProcessEnv, encoding: 'utf8' });
  assert.equal(c.status, 2, 'no key: refuses before any client exists'); assert.ok(!/STUB-FETCH/.test(c.stderr), 'no fetch was even attempted');
});
