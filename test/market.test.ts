import { test } from 'node:test';
import assert from 'node:assert/strict';
import { consensus, endsSeparation, kendallTau, looksCollapsed, percentileMap, WITHHOLD_GAP } from '../src/agent/market.ts';

test('kendallTau: identical, reversed, too short', () => {
  assert.equal(kendallTau([1, 2, 3, 4], [10, 20, 30, 40]), 1);
  assert.equal(kendallTau([1, 2, 3, 4], [4, 3, 2, 1]), -1);
  assert.equal(kendallTau([1, 2], [1, 2]), null);
});

test('percentileMap ranks within the set and averages ties', () => {
  const p = percentileMap(new Map([['a', 0.1], ['b', 0.5], ['c', 0.5], ['d', 0.9]]));
  assert.equal(p.get('a'), 0);
  assert.equal(p.get('d'), 1);
  assert.equal(p.get('b'), p.get('c'));
});

test('consensus averages agreeing readings and withholds disagreeing titles', () => {
  const ids = ['a', 'b', 'c', 'd', 'e'];
  const A = new Map([['a', 0.9], ['b', 0.8], ['c', 0.7], ['d', 0.6], ['e', 0.1]]);
  const B = new Map([['e', 0.99], ['a', 0.95], ['b', 0.85], ['c', 0.75], ['d', 0.1]]);
  const c = consensus(ids, A, B);
  assert.deepEqual(c.withheld, ['e'], 'e jumps from last to first, more than the gap');
  assert.equal(c.pct.get('a'), (1 + 0.75) / 2);
  assert.equal(c.readings, 2);
  assert.ok(WITHHOLD_GAP > 0);
});

test('consensus abstains on thin coverage and on incoherent readings', () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
  const thin = consensus(ids, new Map([['a', 0.5], ['b', 0.4]]));
  assert.match(thin.abstain ?? '', /only 2 of 6/);
  const A = new Map(ids.map((id, i) => [id, i / 10]));
  const B = new Map(ids.map((id, i) => [id, 1 - i / 10]));
  const inc = consensus(ids, A, B);
  assert.match(inc.abstain ?? '', /disagree/);
});

test('single reading is reported as such, with missing titles counted', () => {
  const c = consensus(['a', 'b', 'c'], new Map([['a', 0.2], ['b', 0.3]]));
  assert.equal(c.readings, 1);
  assert.deepEqual(c.missing, ['c']);
  assert.equal(c.tau, null);
});

test('looksCollapsed detects the reported pinned-location collapse', () => {
  assert.equal(looksCollapsed(8, 1), true);
  assert.equal(looksCollapsed(8, 7), false);
  assert.equal(looksCollapsed(2, 1), false);
});

test('endsSeparation compares the two ends on shared titles only', () => {
  const o = new Map([['a', 0], ['b', 0.5], ['c', 1], ['x', 0.3]]);
  const d = new Map([['a', 1], ['b', 0.5], ['c', 0]]);
  assert.equal(endsSeparation(o, d), -1);
});
