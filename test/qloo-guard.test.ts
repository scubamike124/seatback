import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createQlooClient, resolveMode, MODE_LABEL, GuardedQlooClient, CallCounter } from '../src/qloo/client.ts';
import { resetQlooCooldown } from '../src/qloo/http-client.ts';
import { FixtureQlooClient } from '../src/qloo/fixture-client.ts';
import { QlooError } from '../src/qloo/types.ts';
import { OUTBOUND_PARAM_ALLOWLIST, personalDataIn, sanitizeOutbound } from '../src/qloo/outbound.ts';
import * as P from '../src/qloo/params.ts';
import { decide, rankCandidates, resolveLocality, resolveTitle } from '../src/qloo/resolve.ts';
import { buildRequestToResult } from '../src/qloo/report.ts';
import { checkHealth, checkLivePaths, checkLiveText } from '../scripts/presubmit-live.ts';
import { replayFetch } from './helpers/contract-suite.ts';

const KEY = ['FAKE', 'KEY', 'guard', '5555555555'].join('-');
beforeEach(() => resetQlooCooldown());

test('mode: MOCK by default, LIVE only with a key, FORCE_SYNTHETIC wins', () => {
  assert.equal(resolveMode({}), 'MOCK');
  assert.equal(resolveMode({ QLOO_API_KEY: '' }), 'MOCK');
  assert.equal(resolveMode({ QLOO_API_KEY: KEY }), 'LIVE');
  assert.equal(resolveMode({ QLOO_API_KEY: KEY, FORCE_SYNTHETIC: '1' }), 'MOCK');
});

test('every MOCK result is labelled MOCK in mode, label and trace', async () => {
  const h = createQlooClient({});
  const r = await h.client.searchLocality('Orlando');
  assert.equal(r.mode, 'MOCK'); assert.match(r.label!, /MOCK/); assert.equal(r.source, 'synthetic-fixture');
  assert.ok(h.client.trace.every((t) => t.mode === 'MOCK'));
  assert.match(h.counter.line(h.mode), /\[MOCK\]/);
});

test('LIVE result is labelled LIVE and the handle never exposes the key', async () => {
  const h = createQlooClient({ QLOO_API_KEY: KEY }, { fetchImpl: replayFetch(), sleep: async () => {} });
  const r = await h.client.searchLocality('Orlando');
  assert.equal(r.mode, 'LIVE'); assert.equal(r.source, 'qloo-live');
  assert.ok(!JSON.stringify({ r, trace: h.client.trace, line: h.counter.line(h.mode), label: h.label }).includes(KEY));
  assert.ok(!Object.values(h).some((v) => typeof v === 'string' && v.includes(KEY)));
});

test('missing endpoint degrades: typed unavailable result, no throw, later calls skip the network', async () => {
  const calls: string[] = [];
  const h = createQlooClient({ QLOO_API_KEY: KEY }, { fetchImpl: replayFetch(['/v2/trending', 'demographics'], calls), sleep: async () => {} });
  const t = await h.client.trending({ domain: 'movie', entityId: 'E1', startDate: '2026-09-01', endDate: '2026-10-01' });
  assert.deepEqual(t.data, []);
  assert.deepEqual(t.unavailable, { reason: 'endpoint-not-available-on-host', endpoint: 'trending', fallback: 'none' });
  assert.match(t.label!, /not available on this host/);
  await h.client.trending({ domain: 'movie', entityId: 'E1', startDate: '2026-09-01', endDate: '2026-10-01' });
  assert.equal(calls.filter((c) => c === '/v2/trending').length, 1);
  const d = await h.client.demographics(['E1']);
  assert.equal(d.unavailable?.endpoint, 'demographics');
  assert.equal(h.client.endpointStatus.trending, 'unavailable');
  // the rest of the run still works
  assert.ok((await h.client.insights({ domain: 'movie', location: { query: 'Orlando' } })).data.length > 0);
});

test('there is no mock fallback: an unavailable endpoint in a LIVE run never yields mock data', async () => {
  const h = createQlooClient({ QLOO_API_KEY: KEY }, { fetchImpl: replayFetch(['/v2/trending']), sleep: async () => {} });
  const t = await h.client.trending({ domain: 'movie', entityId: 'E1', startDate: '2026-09-01', endDate: '2026-10-01' });
  assert.deepEqual(t.data, []); assert.equal(t.mode, 'LIVE'); assert.equal(t.source, 'qloo-live'); assert.equal(t.unavailable?.fallback, 'none');
  assert.ok(!/MOCK/.test(t.label!));
});

test('other errors on optional endpoints (429, 5xx, 401) are NOT swallowed', async () => {
  const f = (async () => new Response('', { status: 401 })) as typeof fetch;
  const h = createQlooClient({ QLOO_API_KEY: KEY }, { fetchImpl: f, sleep: async () => {} });
  await assert.rejects(() => h.client.trending({ domain: 'movie', entityId: 'E1', startDate: '2026-09-01', endDate: '2026-10-01' }), (e: QlooError) => e.kind === 'auth');
});

test('call budget: visible counter, hard stop, cache hits are free', async () => {
  const calls: string[] = [];
  const h = createQlooClient({ QLOO_API_KEY: KEY }, { budget: 2, fetchImpl: replayFetch([], calls), sleep: async () => {} });
  await h.client.searchLocality('A'); await h.client.searchLocality('B');
  assert.equal(h.counter.line('LIVE'), 'Qloo calls: 2/2 (0 served from cache) [LIVE]');
  await assert.rejects(() => h.client.searchLocality('C'), (e: QlooError) => e.kind === 'budget');
  assert.equal(calls.length, 2);
  assert.equal(new CallCounter(70).budget, 70);
});

test('cache: the second identical request is served from cache and costs no budget', async () => {
  const { MemoryCache } = await import('../src/qloo/cache.ts');
  const calls: string[] = [];
  const h = createQlooClient({ QLOO_API_KEY: KEY }, { cache: new MemoryCache(10), fetchImpl: replayFetch([], calls), sleep: async () => {} });
  await h.client.searchLocality('Orlando'); const r = await h.client.searchLocality('Orlando');
  assert.equal(r.cached, true); assert.equal(calls.length, 1); assert.equal(h.counter.used, 1); assert.equal(h.counter.cacheHits, 1);
});

test('dry run: builds and validates the real requests, sends nothing, returns no data, says DRY-RUN', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (() => { throw new Error('network used in dry run'); }) as typeof fetch;
  try {
    const h = createQlooClient({ QLOO_API_KEY: KEY }, { dryRun: true });
    const r = await h.client.insights({ domain: 'movie', location: { query: 'Orlando' }, take: 3 });
    assert.deepEqual(r.data, []); assert.equal(r.mode, 'DRY-RUN'); assert.match(r.label!, /DRY RUN/);
    assert.equal(h.plan.length, 1); assert.equal(h.plan[0]!.params['filter.type'], 'urn:entity:movie');
    assert.ok(!JSON.stringify(h.plan).includes(KEY));
    await assert.rejects(() => h.client.insights({ domain: 'movie', onlyEntityIds: ['bad&id'] }));
  } finally { globalThis.fetch = real; }
});

test('outbound sanitiser: personal data and unknown parameters never leave', async () => {
  for (const bad of ['jane.doe@example.com', 'call +1 (555) 123-4567', 'https://x.test/me', '28.5383, -81.3792', ['3F2504E0', '4F89', '41D3', '9A0C', '0305E82C3301'].join('-'), '@janedoe']) {
    assert.throws(() => sanitizeOutbound('/search', { query: bad }), (e: QlooError) => e.kind === 'invalid_request', bad);
  }
  assert.throws(() => sanitizeOutbound('/x', { 'signal.user.email': 'a' }), /allow-list/);
  assert.throws(() => sanitizeOutbound('/x', { 'signal.interests.entities': 'a,b&take=9' }), /malformed/);
  for (const ok of ['Orlando', 'Minneapolis-Saint Paul', "Hell's Kitchen", 'holiday']) assert.doesNotThrow(() => sanitizeOutbound('/search', { query: ok }));
  assert.deepEqual(personalDataIn('Orlando'), []);
  const h = createQlooClient({ QLOO_API_KEY: KEY }, { fetchImpl: replayFetch(), sleep: async () => {} });
  await assert.rejects(() => h.client.searchLocality('mail me jane@example.com'), (e: QlooError) => e.kind === 'invalid_request');
  assert.equal(h.counter.used, 0, 'blocked before any network call');
});

test('outbound allow-list covers every parameter the endpoint allow-lists in params.ts allow', () => {
  const all = new Set<string>();
  for (const v of Object.values(P)) {
    if (v instanceof Set) v.forEach((x) => all.add(String(x)));
    else if (v && typeof v === 'object') for (const s of Object.values(v)) if (s instanceof Set) s.forEach((x) => all.add(String(x)));
  }
  const used = [...all].filter((p) => !OUTBOUND_PARAM_ALLOWLIST.has(p));
  // Parameters Seatback's client never builds are allowed to be missing from the outbound list.
  const neverBuilt = used.filter((p) => !readFileSync(new URL('../src/qloo/http-client.ts', import.meta.url), 'utf8').includes(`'${p}'`));
  assert.deepEqual(used.filter((p) => !neverBuilt.includes(p)), []);
});

test('ambiguity: close candidates are returned, not forced', () => {
  const amb = decide('Springfield', rankCandidates('Springfield', [
    { id: 'L1', name: 'Springfield', disambiguation: 'Illinois', popularity: 0.5 },
    { id: 'L2', name: 'Springfield', disambiguation: 'Missouri', popularity: 0.5 },
  ]));
  assert.equal(amb.status, 'ambiguous'); assert.equal(amb.chosen, undefined); assert.equal(amb.candidates.length, 2);
  const uni = decide('Orlando', rankCandidates('Orlando', [{ id: 'L1', name: 'Orlando', popularity: 1 }, { id: 'L2', name: 'Orlando Park', popularity: 0.1 }]));
  assert.equal(uni.status, 'unique'); assert.equal(uni.chosen?.id, 'L1');
  assert.equal(decide('zzz', []).status, 'none');
  const fuzzy = decide('Star', rankCandidates('Star', [{ id: 'A', name: 'Star Wars' }, { id: 'B', name: 'Star Trek' }, { id: 'C', name: 'A Star Is Born' }]));
  assert.equal(fuzzy.status, 'ambiguous'); assert.ok(fuzzy.candidates.every((c) => c.confidence < 0.85));
});

test('resolve helpers go through the client and report ambiguity with confidences', async () => {
  const client = {
    searchLocality: async () => ({ data: [{ entity_id: 'L1', name: 'Portland' }, { entity_id: 'L2', name: 'Portland' }] }),
    searchTitle: async () => ({ data: [{ entity_id: 'M1', name: 'Heat' }] }),
  } as unknown as FixtureQlooClient;
  const a = await resolveLocality(client, 'Portland'); assert.equal(a.status, 'ambiguous');
  assert.ok(a.candidates.every((c) => typeof c.confidence === 'number'));
  assert.equal((await resolveTitle(client, 'Heat', 'movie')).status, 'unique');
});

test('REQUEST-TO-RESULT: states the mode, lists requests, choices, limitations, setup; carries no secret', async () => {
  const h = createQlooClient({ QLOO_API_KEY: KEY }, { fetchImpl: replayFetch(['/v2/trending']), sleep: async () => {} });
  const loc = await resolveLocality(h.client, 'Orlando');
  await h.client.trending({ domain: 'movie', entityId: 'E1', startDate: '2026-09-01', endDate: '2026-10-01' });
  const md = buildRequestToResult(h, { choices: [loc], secrets: [KEY] });
  assert.match(md, /Data mode: LIVE/); assert.match(md, /endpoint-not-available-on-host/); assert.match(md, /## 4\. Limitations/); assert.match(md, /## 5\. Clean-environment setup/);
  assert.ok(!md.includes(KEY));
  const mock = buildRequestToResult(createQlooClient({}), {});
  assert.match(mock, /Data mode: MOCK/); assert.match(mock, /template/);
  assert.equal(checkLivePaths([new URL('../docs/REQUEST-TO-RESULT.MOCK-SAMPLE.md', import.meta.url).pathname]).length > 0, true);
});

test('presubmit:live refuses mock, dry-run, synthetic, secrets, missing and empty input', () => {
  assert.ok(checkLiveText('Data mode: MOCK', 'f').length);
  assert.ok(checkLiveText('[QLOO:DRY-RUN] x', 'f').length);
  assert.ok(checkLiveText('{"source":"synthetic-fixture"}', 'f').length);
  assert.ok(checkLiveText('id SYN-M-1', 'f').length);
  assert.ok(checkLiveText('X-Api-Key: abcdefghijklmnop12345', 'f').length);
  assert.deepEqual(checkLiveText('Data mode: LIVE. Qloo calls 12/70', 'f'), []);
  assert.ok(checkLivePaths([]).length); assert.ok(checkLivePaths(['/nonexistent-zzz']).length);
  assert.ok(checkHealth('{"mode":"synthetic"}').length); assert.deepEqual(checkHealth('{"ok":true,"mode":"live"}'), []);
});

test('MCP example is documented as not run, imports nothing at load, holds no key', async () => {
  const src = readFileSync(new URL('../scripts/qloo-mcp-example.ts', import.meta.url), 'utf8');
  assert.match(src, /NOT RUN/); assert.ok(!/^import .*modelcontextprotocol/m.test(src));
  const m = await import('../scripts/qloo-mcp-example.ts');
  assert.equal(m.MCP_EXAMPLE_STATUS, 'not-run');
  assert.ok(new GuardedQlooClient(new FixtureQlooClient({}), 'MOCK', new CallCounter(1)).source);
  assert.ok(MODE_LABEL.LIVE);
});
