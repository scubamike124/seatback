// Contract suite: ONE set of checks run against replayed fixtures (MOCK) and, when a key exists and
// CONTRACT_LIVE=1, against the live host. It checks shapes and invariants only, never exact values.
// Fixtures below are hand-written from the DOCUMENTED response shapes; ids are invented (SYN-).
import assert from 'node:assert/strict';
import { entityProblems, tagProblems } from '../../src/qloo/schema.ts';
import type { QlooClient } from '../../src/qloo/types.ts';

export const FX = {
  search: { results: [{ entity_id: 'SYN-LOC-1', name: 'Orlando (synthetic)', type: 'urn:entity:locality', popularity: 0.9 }] },
  insights: { results: { entities: [{ entity_id: 'SYN-M-1', name: 'Film One (synthetic)', query: { affinity: 0.81 }, tags: [{ id: 'SYN-T-1', name: 'drama' }] }, { entity_id: 'SYN-M-2', name: 'Film Two (synthetic)', query: { affinity: 0.4 } }] } },
  tags: { results: { tags: [{ tag_id: 'SYN-T-1', name: 'holiday (synthetic)' }] } },
  trending: { results: { trending: [{ date: '2026-09-01', population_percentile: 0.5 }] } },
  demographics: { results: { demographics: [{ entity_id: 'SYN-M-1', query: { age: { '25_to_29': 0.2 }, gender: { female: 0.1 } } }] } },
  empty: { results: { entities: [] } },
};

/** A fetch that replays FX by path and filter.type. `missing` paths answer 403 (endpoint absent). */
export function replayFetch(missing: string[] = [], calls: string[] = []): typeof fetch {
  return (async (url: string | URL | Request) => {
    const u = new URL(String(url));
    const type = u.searchParams.get('filter.type') ?? '';
    const key = u.pathname === '/v2/insights' && type === 'urn:demographics' ? 'demographics' : u.pathname;
    calls.push(key);
    if (missing.includes(key)) return new Response('forbidden', { status: 403 });
    const body = u.pathname === '/search' ? FX.search : u.pathname === '/v2/tags' ? FX.tags : u.pathname === '/v2/trending' ? FX.trending : key === 'demographics' ? FX.demographics : FX.insights;
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
}

export const contractCases: { name: string; run: (c: QlooClient) => Promise<void> }[] = [
  { name: 'searchLocality returns entities with id and name', run: async (c) => {
    const r = await c.searchLocality('Orlando');
    assert.ok(Array.isArray(r.data)); for (const e of r.data) assert.deepEqual(entityProblems(e), []);
  } },
  { name: 'searchTitle returns entities', run: async (c) => {
    const r = await c.searchTitle('Film', 'movie'); for (const e of r.data) assert.deepEqual(entityProblems(e), []);
  } },
  { name: 'insights (open location read) returns scored entities', run: async (c) => {
    const r = await c.insights({ domain: 'movie', location: { query: 'Orlando' }, take: 5 });
    assert.ok(Array.isArray(r.data)); for (const e of r.data) assert.deepEqual(entityProblems(e), []);
    assert.ok(r.request.path.length > 0);
  } },
  { name: 'searchTags returns tags with ids', run: async (c) => {
    const r = await c.searchTags({ query: 'holiday', take: 3 }); for (const t of r.data) assert.deepEqual(tagProblems(t), []);
  } },
  { name: 'every result carries provenance and never the key', run: async (c) => {
    const r = await c.searchLocality('Orlando');
    assert.ok(r.source === 'qloo-live' || r.source === 'synthetic-fixture');
    assert.equal(typeof r.cached, 'boolean'); assert.equal(typeof r.ms, 'number');
    assert.ok(!/api[-_]?key/i.test(JSON.stringify(r.request)));
  } },
];
