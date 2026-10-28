import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpQlooClient, HACKATHON_BASE_URL, backoffMs, resetQlooCooldown } from '../src/qloo/http-client.ts';
import { MemoryCache } from '../src/qloo/cache.ts';
import { QlooError } from '../src/qloo/types.ts';

const KEY = 'test-key-1234567890';
type Call = { url: string; init: RequestInit };

function fakeFetch(responses: (Response | Error)[], calls: Call[]): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const r = responses.shift() ?? new Response('{}', { status: 200 });
    if (r instanceof Error) throw r;
    return r;
  }) as typeof fetch;
}
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

test('uses the hackathon base URL, GET, and the X-Api-Key header; never puts the key in the URL', async () => {
  const calls: Call[] = [];
  const c = new HttpQlooClient({ apiKey: KEY, fetchImpl: fakeFetch([ok({ results: { entities: [{ entity_id: 'A', query: { affinity: 0.9 } }] } })], calls) });
  const r = await c.insights({ domain: 'movie', location: { query: 'Minneapolis' }, take: 5 });
  assert.equal(r.data.length, 1);
  const u = new URL(calls[0]!.url);
  assert.equal(u.origin, HACKATHON_BASE_URL);
  assert.equal(u.pathname, '/v2/insights');
  assert.equal(u.searchParams.get('filter.type'), 'urn:entity:movie');
  assert.equal(u.searchParams.get('signal.location.query'), 'Minneapolis');
  assert.equal(calls[0]!.init.method, 'GET');
  assert.equal((calls[0]!.init.headers as Record<string, string>)['X-Api-Key'], KEY);
  assert.ok(!calls[0]!.url.includes(KEY));
  assert.ok(!JSON.stringify(r.request).includes(KEY));
});

test('anchored read sends signal.interests.entities + filter.results.entities', async () => {
  const calls: Call[] = [];
  const c = new HttpQlooClient({ apiKey: KEY, fetchImpl: fakeFetch([ok({ results: { entities: [] } })], calls) });
  await c.insights({ domain: 'podcast', anchorEntityIds: ['A1', 'A2'], onlyEntityIds: ['P1', 'P2'], contentRating: 'G', releaseYearMin: 2020 });
  const u = new URL(calls[0]!.url);
  assert.equal(u.searchParams.get('signal.interests.entities'), 'A1,A2');
  assert.equal(u.searchParams.get('filter.results.entities'), 'P1,P2');
  assert.equal(u.searchParams.get('filter.content_rating'), null, 'content_rating is not documented for podcasts');
  assert.equal(u.searchParams.get('filter.release_year.min'), null);
});

test('rejects unsafe IDs instead of building a malformed query', async () => {
  const c = new HttpQlooClient({ apiKey: KEY, fetchImpl: fakeFetch([], []) });
  await assert.rejects(() => c.insights({ domain: 'movie', onlyEntityIds: ['x&take=999'] }), /no valid entity ids/);
});

test('taste analysis, demographics, trending and search use documented paths and params', async () => {
  const calls: Call[] = [];
  const c = new HttpQlooClient({
    apiKey: KEY,
    fetchImpl: fakeFetch([ok({ results: { tags: [{ tag_id: 't' }] } }), ok({ results: { demographics: [] } }), ok({ results: { trending: [] } }), ok({ results: [] })], calls),
  });
  await c.tasteAnalysis({ location: { query: 'Orlando' }, parentTypes: ['urn:entity:movie', 'urn:entity:tv_show'] });
  await c.demographics(['E1']);
  await c.trending({ domain: 'movie', entityId: 'E1', startDate: '2026-08-01', endDate: '2026-10-24' });
  await c.searchLocality('Orlando');
  const [t, d, tr, s] = calls.map((x) => new URL(x.url));
  assert.equal(t!.searchParams.get('filter.type'), 'urn:tag');
  assert.equal(t!.searchParams.get('filter.parents.types'), 'urn:entity:movie,urn:entity:tv_show');
  assert.equal(d!.searchParams.get('filter.type'), 'urn:demographics');
  assert.equal(tr!.pathname, '/v2/trending');
  assert.equal(tr!.searchParams.get('filter.start_date'), '2026-08-01');
  assert.equal(s!.pathname, '/search');
  assert.equal(s!.searchParams.get('types'), 'urn:entity:locality');
  await assert.rejects(() => c.trending({ domain: 'movie', entityId: 'E1', startDate: 'yesterday', endDate: '2026-10-24' }));
});

test('retries 429 and 5xx a bounded number of times, then succeeds', async () => {
  const calls: Call[] = [];
  const c = new HttpQlooClient({
    apiKey: KEY,
    sleep: async () => {},
    fetchImpl: fakeFetch([new Response('', { status: 429 }), new Response('', { status: 503 }), ok({ results: { entities: [] } })], calls),
  });
  await c.insights({ domain: 'movie', location: { query: 'X' } });
  assert.equal(calls.length, 3);
});

test('does not retry 401 and explains the usual cause without leaking the key', async () => {
  const calls: Call[] = [];
  const c = new HttpQlooClient({ apiKey: KEY, sleep: async () => {}, fetchImpl: fakeFetch([new Response('', { status: 401 })], calls) });
  await assert.rejects(
    () => c.insights({ domain: 'movie', location: { query: 'X' } }),
    (e: unknown) => e instanceof QlooError && e.kind === 'auth' && /hackathon\.api\.qloo\.com/.test(e.message) && !e.message.includes(KEY),
  );
  assert.equal(calls.length, 1);
});

test('gives up after max retries on persistent server errors', async () => {
  const calls: Call[] = [];
  const c = new HttpQlooClient({ apiKey: KEY, maxRetries: 2, sleep: async () => {}, fetchImpl: fakeFetch([500, 500, 500, 500].map((s) => new Response('', { status: s })), calls) });
  await assert.rejects(() => c.insights({ domain: 'movie', location: { query: 'X' } }), (e: unknown) => e instanceof QlooError && e.kind === 'server');
  assert.equal(calls.length, 3);
});

test('serves repeated requests from the private cache and enforces the call budget', async () => {
  const calls: Call[] = [];
  let n = 0;
  const c = new HttpQlooClient({
    apiKey: KEY,
    cache: new MemoryCache(),
    onNetworkCall: () => {
      if (++n > 1) throw new QlooError('budget', 0, 'budget');
    },
    fetchImpl: fakeFetch([ok({ results: { entities: [{ entity_id: 'A' }] } })], calls),
  });
  const a = await c.insights({ domain: 'movie', location: { query: 'X' } });
  const b = await c.insights({ domain: 'movie', location: { query: 'X' } });
  assert.equal(a.cached, false);
  assert.equal(b.cached, true);
  assert.equal(calls.length, 1);
  await assert.rejects(() => c.insights({ domain: 'movie', location: { query: 'Y' } }), /budget/);
});

test('destinations: documented Destination parameters, US country filter, results.entities', async () => {
  const calls: Call[] = [];
  const c = new HttpQlooClient({ apiKey: KEY, fetchImpl: fakeFetch([ok({ results: { entities: [{ entity_id: 'D1', name: 'Denver', properties: { geocode: { name: 'Denver', country_code: 'US' } }, query: { affinity: 0.8 } }] } })], calls) });
  const r = await c.destinations({ seedEntityIds: ['M1', 'M2'], countryCode: 'US' });
  const u = new URL(calls[0]!.url);
  assert.equal(u.pathname, '/v2/insights');
  assert.equal(u.searchParams.get('filter.type'), 'urn:entity:destination');
  assert.equal(u.searchParams.get('signal.interests.entities'), 'M1,M2');
  assert.equal(u.searchParams.get('filter.geocode.country_code'), 'US');
  assert.equal(u.searchParams.get('take'), '50');
  assert.equal(r.data[0]!.properties?.geocode?.name, 'Denver');
  await assert.rejects(() => c.destinations({ seedEntityIds: ['M1'], countryCode: 'usa' }), /two capital letters/);
});

test('tag search goes to /v2/tags with filter.query and parses results.tags', async () => {
  const calls: Call[] = [];
  const c = new HttpQlooClient({ apiKey: KEY, fetchImpl: fakeFetch([ok({ results: { tags: [{ id: 'urn:tag:genre:media:holiday', name: 'Holiday' }] } })], calls) });
  const r = await c.searchTags({ query: ' holiday ', parentTypes: ['urn:entity:movie'] });
  const u = new URL(calls[0]!.url);
  assert.equal(u.pathname, '/v2/tags');
  assert.equal(u.searchParams.get('filter.query'), 'holiday');
  assert.equal(u.searchParams.get('filter.parents.types'), 'urn:entity:movie');
  assert.equal(r.data[0]!.name, 'Holiday');
  await assert.rejects(() => c.searchTags({ query: '   ' }), /needs a query/);
});

test('filter.tags is sent on entity reads; heatmap (probe only) uses documented heatmap parameters', async () => {
  const calls: Call[] = [];
  const c = new HttpQlooClient({ apiKey: KEY, fetchImpl: fakeFetch([ok({ results: { entities: [] } }), ok({ results: { heatmap: [{ location: { geohash: 'dr5' }, query: { affinity: 1 } }] } })], calls) });
  await c.insights({ domain: 'movie', location: { query: 'Orlando' }, tagIds: ['urn:tag:genre:media:family'] });
  assert.equal(new URL(calls[0]!.url).searchParams.get('filter.tags'), 'urn:tag:genre:media:family');
  const h = await c.heatmap({ locationQuery: 'Orlando', seedEntityIds: ['M1'] });
  const u = new URL(calls[1]!.url);
  assert.equal(u.searchParams.get('filter.type'), 'urn:heatmap');
  assert.equal(u.searchParams.get('filter.location.query'), 'Orlando');
  assert.equal(h.data.length, 1);
});

test('identical concurrent requests share one network call (coalescing)', async () => {
  const calls: Call[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    await gate;
    return ok({ results: { entities: [{ entity_id: 'A' }] } });
  }) as typeof fetch;
  const c = new HttpQlooClient({ apiKey: KEY, fetchImpl: f });
  const a = c.insights({ domain: 'movie', location: { query: 'Denver' } });
  const b = c.insights({ domain: 'movie', location: { query: 'Denver' } });
  release();
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(calls.length, 1);
  assert.equal(ra.data.length, 1);
  assert.equal(rb.data.length, 1);
  assert.equal(c.networkCalls, 1);
});

test('concurrency is capped: never more than maxConcurrent calls in flight', async () => {
  let inFlight = 0;
  let peak = 0;
  const f = (async () => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return ok({ results: { entities: [] } });
  }) as typeof fetch;
  const c = new HttpQlooClient({ apiKey: KEY, fetchImpl: f, maxConcurrent: 2 });
  await Promise.all(['A', 'B', 'C', 'D', 'E'].map((q) => c.insights({ domain: 'movie', location: { query: q } })));
  assert.equal(peak, 2);
  assert.equal(c.networkCalls, 5);
});

test('a 429 sets a shared cooldown that a second client also waits out', async () => {
  resetQlooCooldown();
  let now = 1_000_000;
  const slept: number[] = [];
  const sleep = async (ms: number) => {
    slept.push(ms);
    now += ms;
  };
  const first = new HttpQlooClient({ apiKey: KEY, now: () => now, sleep, fetchImpl: fakeFetch([new Response('', { status: 429, headers: { 'retry-after': '2' } }), ok({ results: { entities: [] } })], []) });
  await first.insights({ domain: 'movie', location: { query: 'X' } });
  // Cooldown is now in the past for `now`, so set up a fresh 429 and check the second client waits.
  const third = new HttpQlooClient({ apiKey: KEY, now: () => now, sleep, maxRetries: 0, fetchImpl: fakeFetch([new Response('', { status: 429, headers: { 'retry-after': '3' } })], []) });
  await assert.rejects(() => third.insights({ domain: 'movie', location: { query: 'Y' } }), /rate limit/);
  slept.length = 0;
  const second = new HttpQlooClient({ apiKey: KEY, now: () => now, sleep, fetchImpl: fakeFetch([ok({ results: { entities: [] } })], []) });
  await second.insights({ domain: 'movie', location: { query: 'Z' } });
  assert.deepEqual(slept, [3000], 'the second client waited out the cooldown set by the first');
  resetQlooCooldown();
});

test('backoff honours Retry-After (capped) and jitters otherwise', () => {
  assert.equal(backoffMs(0, '2'), 2000);
  assert.equal(backoffMs(0, '60'), 5000);
  assert.equal(backoffMs(0, null, () => 0), 320);
  assert.equal(backoffMs(0, null, () => 1), 480);
  assert.equal(backoffMs(5, null, () => 0.5), 3000);
});
