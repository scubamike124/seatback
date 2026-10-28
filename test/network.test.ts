import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_NETWORK, cityKey, matchCity, networkFit, splitSeeds, MIN_NETWORK_PAIRED } from '../src/agent/network.ts';
import type { QlooEntity } from '../src/qloo/types.ts';

const dest = (name: string, aff = 0.5): QlooEntity => ({ entity_id: `D-${name}`, name, query: { affinity: aff } });
const order = (names: string[]) => names.map((n, i) => dest(n, 1 - i / 100));
const CITIES = ['Denver', 'Austin', 'Nashville', 'Boston', 'Seattle', 'Chicago', 'Phoenix', 'Tampa'];

test('cityKey and matchCity handle synthetic labels, states and documented geocode names', () => {
  assert.equal(cityKey('Orlando, Florida (synthetic)'), 'orlando');
  assert.equal(matchCity(dest('Denver, Colorado'), DEFAULT_NETWORK)?.code, 'DEN');
  assert.equal(matchCity({ name: 'The Mile High City', properties: { geocode: { name: 'Denver' } } }, DEFAULT_NETWORK)?.code, 'DEN');
  assert.equal(matchCity(dest('Lake Tamsin (synthetic)'), DEFAULT_NETWORK), undefined);
});

test('two agreeing readings rank the network; route ends are excluded', () => {
  const r = networkFit(order(CITIES), order(CITIES), DEFAULT_NETWORK, ['Minneapolis', 'Orlando']);
  assert.equal(r.abstain, null);
  assert.equal(r.paired, CITIES.length);
  assert.equal(r.tau, 1);
  assert.equal(r.rows[0]!.code, 'DEN');
  assert.equal(r.rows.find((x) => x.code === 'MSP')!.status, 'route-end');
  assert.equal(r.rows.find((x) => x.code === 'MCO')!.status, 'route-end');
  assert.equal(r.rows.find((x) => x.code === 'SFO')!.status, 'no-data');
});

test('a city the readings place far apart is withheld, not averaged', () => {
  const a = order(CITIES);
  const b = order(['Austin', 'Nashville', 'Boston', 'Seattle', 'Chicago', 'Phoenix', 'Tampa', 'Denver']);
  const r = networkFit(a, b, DEFAULT_NETWORK, []);
  assert.equal(r.rows.find((x) => x.code === 'DEN')!.status, 'withheld');
  assert.equal(r.rows.find((x) => x.code === 'DEN')!.pct, null);
});

test('disagreeing readings withhold the whole network ranking', () => {
  const r = networkFit(order(CITIES), order([...CITIES].reverse()), DEFAULT_NETWORK, []);
  assert.match(r.abstain ?? '', /disagree/);
  assert.ok(r.rows.every((x) => x.status !== 'ranked'));
});

test('too few network cities in both readings: abstain', () => {
  const few = CITIES.slice(0, MIN_NETWORK_PAIRED - 1);
  const r = networkFit(order(few), order(few), DEFAULT_NETWORK, []);
  assert.match(r.abstain ?? '', /only 4/);
});

test('seeds split into disjoint interleaved halves', () => {
  const [a, b] = splitSeeds([1, 2, 3, 4, 5]);
  assert.deepEqual(a, [1, 3, 5]);
  assert.deepEqual(b, [2, 4]);
});

test('aliases: Qloo names like "New York City" and "Minneapolis-Saint Paul" match, and route ends typed either way are excluded', () => {
  assert.equal(matchCity(dest('New York City'), DEFAULT_NETWORK)?.code, 'JFK');
  assert.equal(matchCity(dest('Washington, D.C.'), DEFAULT_NETWORK)?.code, 'DCA');
  assert.equal(matchCity(dest('Minneapolis–Saint Paul'), DEFAULT_NETWORK)?.code, 'MSP');
  const r = networkFit(order(CITIES), order(CITIES), DEFAULT_NETWORK, ['Minneapolis-Saint Paul', 'New York City']);
  assert.equal(r.rows.find((x) => x.code === 'MSP')!.status, 'route-end');
  assert.equal(r.rows.find((x) => x.code === 'JFK')!.status, 'route-end');
});
