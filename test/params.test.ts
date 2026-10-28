import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LOCATED_INSIGHTS_PARAMS, TASTE_ANALYSIS_PARAMS, assertAllowed, clampTake, isIsoDate, isSafeId, MAX_TAKE } from '../src/qloo/params.ts';

test('content_rating and release_year are only allowed for movie and tv_show (Entity Type Parameter Guide)', () => {
  assert.ok(LOCATED_INSIGHTS_PARAMS.movie.has('filter.content_rating'));
  assert.ok(LOCATED_INSIGHTS_PARAMS.tv_show.has('filter.release_year.min'));
  assert.ok(!LOCATED_INSIGHTS_PARAMS.podcast.has('filter.content_rating'));
  assert.ok(!LOCATED_INSIGHTS_PARAMS.artist.has('filter.release_year.min'));
});

test('every domain allows the parameters the three read modes need', () => {
  for (const d of ['movie', 'tv_show', 'podcast', 'artist'] as const) {
    for (const p of ['filter.type', 'signal.location.query', 'signal.location', 'signal.interests.entities', 'filter.results.entities', 'take']) {
      assert.ok(LOCATED_INSIGHTS_PARAMS[d].has(p), `${d} missing ${p}`);
    }
  }
  assert.ok(TASTE_ANALYSIS_PARAMS.has('signal.location.query'));
});

test('assertAllowed rejects undocumented parameters loudly', () => {
  assert.throws(() => assertAllowed('/v2/insights', { 'filter.type': 'x', 'filter.location.query': 'NYC' }, LOCATED_INSIGHTS_PARAMS.movie), /not documented/);
  assert.doesNotThrow(() => assertAllowed('/v2/insights', { 'filter.type': 'x', take: '5' }, LOCATED_INSIGHTS_PARAMS.movie));
});

test('take is clamped to the documented maximum of 50', () => {
  assert.equal(clampTake(500, 20), String(MAX_TAKE));
  assert.equal(clampTake(0, 20), '1');
  assert.equal(clampTake(undefined, 20), '20');
});

test('ids and dates are validated', () => {
  assert.ok(isSafeId('SYN-00000000-0000-4000-8000-000000000001'));
  assert.ok(!isSafeId('abc&take=50'));
  assert.ok(!isSafeId(''));
  assert.ok(isIsoDate('2026-10-24'));
  assert.ok(!isIsoDate('10/24/2026'));
});
