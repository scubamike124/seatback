import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FixtureQlooClient } from '../src/qloo/fixture-client.ts';
import type { Domain, InsightsRequest, QlooClient } from '../src/qloo/types.ts';
import { HOMETOWN, binomialP, clusterPermutationP, directionCheck, directionPasses } from '../src/agent/validity.ts';
import { anchorSetsFor, rankedAnchors, ANCHOR_PLAN } from '../src/agent/anchors.ts';

const ROUTES: [string, string][] = [['Minneapolis', 'Orlando'], ['Atlanta', 'Seattle'], ['Miami', 'Denver']];
const FILLER: Partial<Record<Domain, string[]>> = { movie: ['Paper Comets', 'Glass Orbit', 'Quiet Fury'], tv_show: ['Corner Booth', 'Field Notes', 'Second Shift'], artist: ['Night Ferry', 'Mara Vale', 'Copper Lanes'] };

/** Wraps the synthetic fixture and PLANTS a hometown effect, to prove the check can detect one. */
function planted(): QlooClient {
  const inner = new FixtureQlooClient();
  const entityCity = new Map<string, string>();
  const homeOf = new Map<string, string>();
  return {
    source: inner.source,
    searchLocality: (q) => inner.searchLocality(q),
    destinations: (x) => inner.destinations(x),
    searchTags: (x) => inner.searchTags(x),
    async searchTitle(q, d) {
      const r = await inner.searchTitle(q, d);
      const h = HOMETOWN.find((x) => x.title === q && x.domain === d);
      if (h && r.data[0]?.entity_id) homeOf.set(r.data[0].entity_id, h.city);
      return r;
    },
    async insights(req: InsightsRequest) {
      const r = await inner.insights(req);
      if (req.location && 'query' in req.location && !req.onlyEntityIds) for (const e of r.data) entityCity.set(e.entity_id!, req.location.query);
      if (req.anchorEntityIds?.length) {
        const city = entityCity.get(req.anchorEntityIds[0]!);
        for (const e of r.data) if (city && homeOf.get(e.entity_id!) === city) e.query = { affinity: Math.min(0.99, (e.query?.affinity ?? 0) + 0.6) };
      }
      return r;
    },
    tasteAnalysis: (x) => inner.tasteAnalysis(x),
    demographics: (x) => inner.demographics(x),
    trending: (x) => inner.trending(x),
  };
}

test('binomialP is the exact one-sided tail', () => {
  assert.equal(binomialP(0, 4), 1);
  assert.equal(binomialP(4, 4), 1 / 16);
  assert.ok(Math.abs(binomialP(9, 10) - 11 / 1024) < 1e-12);
});

test('directionPasses needs enough comparisons, a strong rate, significance and a quiet null', () => {
  assert.equal(directionPasses({ k: 5, n: 5, p: 0.03, nullK: 2, nullN: 5 }), false, 'n < 6');
  assert.equal(directionPasses({ k: 9, n: 10, p: 0.011, nullK: 5, nullN: 10 }), true);
  assert.equal(directionPasses({ k: 9, n: 10, p: 0.011, nullK: 9, nullN: 10 }), false, 'null too high: anchors are not city-specific');
  assert.equal(directionPasses({ k: 9, n: 10, p: 0.06, nullK: 5, nullN: 10 }), false, 'permutation p must be < 0.05');
});

test('the check detects a planted hometown effect', async () => {
  const r = await directionCheck(planted(), ROUTES, { recencyYear: 2023, filler: FILLER });
  assert.ok(r.n >= 6, `n=${r.n}`);
  assert.equal(r.clusters, 6);
  assert.ok(r.nullN >= r.n, 'the null is averaged over every other city');
  assert.ok(directionPasses(r), `k=${r.k}/${r.n} null=${r.nullK}/${r.nullN} p=${r.p}`);
});

test('the check does not pass on plain synthetic fixtures (no real hometowns)', async () => {
  const r = await directionCheck(new FixtureQlooClient(), ROUTES, { recencyYear: 2023, filler: FILLER });
  assert.equal(directionPasses(r), false);
});

test('anchor plan never scores a domain with its own domain', () => {
  for (const [target, [a, b, f]] of Object.entries(ANCHOR_PLAN)) for (const d of [a, b, f]) assert.notEqual(d, target);
});

test('rankedAnchors prefers entities not in the other city top list; anchorSetsFor uses spares on retry', () => {
  const e = (id: string) => ({ entity_id: id, name: id, query: { affinity: 0.5 } });
  const r = rankedAnchors([e('g1'), e('a'), e('b'), e('c'), e('d'), e('f')], [e('g1')]);
  assert.deepEqual(r.map((x) => x.entity_id).slice(0, 3), ['a', 'b', 'c']);
  const ranked = { artist: r, tv_show: [e('t1'), e('t2')], movie: [e('m1'), e('m2'), e('m3'), e('m4')] };
  const first = anchorSetsFor('tv_show', 0, ranked);
  assert.deepEqual(first.map((s) => s.domain), ['artist', 'movie']);
  const retry = anchorSetsFor('tv_show', 1, ranked);
  assert.deepEqual(retry.map((s) => s.entities.map((x) => x.entity_id)), [['d', 'f', 'g1'], ['m4']]);
});

test('a retry with only one spare anchor set returns nothing (two readings or abstain)', () => {
  const e = (id: string) => ({ entity_id: id, name: id, query: { affinity: 0.5 } });
  const ranked = { artist: [e('a1'), e('a2'), e('a3'), e('a4')], tv_show: [e('t1'), e('t2'), e('t3')], movie: [] };
  assert.equal(anchorSetsFor('movie', 0, ranked).length, 2);
  assert.deepEqual(anchorSetsFor('movie', 1, ranked), [], 'movie has no fallback domain and TV has no spares');
  assert.deepEqual(anchorSetsFor('tv_show', 0, { ...ranked, movie: [] }), [], 'a missing second domain means no first attempt either');
});

test('cluster permutation p is exact and more conservative than the per-title binomial', () => {
  const six = Array.from({ length: 6 }, () => ({ k: 3, n: 3 }));
  assert.equal(clusterPermutationP(six), 1 / 64);
  assert.ok(binomialP(18, 18) < clusterPermutationP(six), 'binomial ignores shared anchors');
  assert.equal(clusterPermutationP([{ k: 1, n: 2 }]), 1, 'a tie cluster gives no evidence');
});
