import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSlate, isFamilySafe, percentiles, routeFit, sideOf, slateOverlap, type ScoredTitle } from '../src/agent/scoring.ts';

const t = (key: string, fit: number, side: ScoredTitle['side'], tags: string[] = [], extra: Partial<ScoredTitle> = {}): ScoredTitle => ({
  key, title: key, domain: 'movie', entityId: key, tags: tags.map((id) => ({ id, name: id })),
  affOrigin: null, affDest: null, pctOrigin: null, pctDest: null, fit, side, evidence: ['E1'], ...extra,
});

test('percentiles and routeFit blend the two ends by passenger mix', () => {
  assert.deepEqual(percentiles([0.1, null, 0.9]), [0, null, 1]);
  assert.equal(routeFit(1, 0, 0.7), 0.7);
  assert.equal(routeFit(null, 0.4, 0.7), 0.4);
  assert.equal(routeFit(null, null, 0.5), 0);
});

test('sideOf labels one-sided favourites and missing signal', () => {
  assert.equal(sideOf(0.9, 0.2), 'origin');
  assert.equal(sideOf(0.2, 0.9), 'destination');
  assert.equal(sideOf(0.6, 0.5), 'both');
  assert.equal(sideOf(null, null), 'no-signal');
  assert.equal(sideOf(0.9, null), 'single-end', 'one readable end says nothing about the other');
});

test('withheld titles are reported separately and never picked; weak titles leave slots empty', () => {
  const pool = [t('a', 0.9, 'both'), t('w', 0.95, 'withheld'), t('low', 0.1, 'both')];
  const s = buildSlate(pool, { size: 3, familySafeOnly: false });
  assert.deepEqual(s.picked.map((p) => p.key), ['a']);
  assert.ok(s.notes.some((n) => /withheld/.test(n)));
  assert.ok(s.notes.some((n) => /1 of 3 slots filled/.test(n)));
});

test('family-safe uses documented US ratings and is unknown for podcasts and music', () => {
  assert.equal(isFamilySafe({ domain: 'movie', contentRating: 'PG-13' }), true);
  assert.equal(isFamilySafe({ domain: 'movie', contentRating: 'R' }), false);
  assert.equal(isFamilySafe({ domain: 'tv_show', contentRating: 'TV-MA' }), false);
  assert.equal(isFamilySafe({ domain: 'podcast' }), null);
});

test('buildSlate prefers variety over near-duplicates and drops unrated-unsafe titles', () => {
  const pool = [
    t('a', 0.95, 'both', ['comedy']),
    t('b', 0.94, 'both', ['comedy']),
    t('c', 0.85, 'both', ['docs']),
    t('r', 0.99, 'both', ['thriller'], { contentRating: 'R' }),
    t('n', 0.9, 'no-signal'),
  ];
  const s = buildSlate(pool, { size: 2, familySafeOnly: true, diversity: 0.4 });
  assert.deepEqual(s.picked.map((p) => p.key).sort(), ['a', 'c']);
  assert.ok(s.notes.some((n) => /family-safe/.test(n)));
  assert.ok(s.notes.some((n) => /no Qloo score/.test(n)));
});

test('buildSlate swaps in a clear favourite for an unrepresented end when it is still a good fit', () => {
  const pool = [t('a', 0.9, 'both'), t('b', 0.85, 'both'), t('c', 0.8, 'origin'), t('d', 0.6, 'destination')];
  const s = buildSlate(pool, { size: 3, familySafeOnly: false, diversity: 0 });
  assert.ok(s.picked.some((p) => p.side === 'destination'));
  const weak = [t('a', 0.9, 'both'), t('b', 0.85, 'both'), t('c', 0.8, 'origin'), t('d', 0.2, 'destination')];
  assert.ok(!buildSlate(weak, { size: 3, familySafeOnly: false, diversity: 0 }).picked.some((p) => p.key === 'd'));
});

test('slateOverlap', () => {
  assert.equal(slateOverlap(['a', 'b'], ['b', 'c']), 0.5);
  assert.equal(slateOverlap([], ['a']), 0);
});
