import test from 'node:test';
import assert from 'node:assert/strict';
import { runPipeline } from '../src/agent/pipeline.ts';
import { FixtureQlooClient } from '../src/qloo/fixture-client.ts';
import { EXAMPLE_ROUTES, SYNTHETIC_CATALOGUE } from '../src/examples.ts';
import { countChanged, endToSwap, incomparable, MAX_SWAP_TRIES, swapCandidates, swapText } from '../src/agent/swap.ts';
import { article } from '../src/agent/baseline.ts';
import { tauNote, tauWords } from '../src/agent/market.ts';
import type { DomainSlate, NetworkFit, SlateResult } from '../src/agent/types.ts';
import type { NetworkRow } from '../src/agent/network.ts';

const opts = () => ({ qloo: new FixtureQlooClient(), llm: null, emit: () => {} });
const req = (i: number, extra = {}) => ({ ...EXAMPLE_ROUTES[i]!.request, catalogue: SYNTHETIC_CATALOGUE, ...extra });

const slate = (domain: DomainSlate['domain'], keys: string[], extra: Partial<DomainSlate> = {}): DomainSlate =>
  ({ domain, label: domain, mode: 'anchored', readings: 2, slots: keys.length, scale: 'route', picks: keys.map((key) => ({ key, title: key })) as never, bench: [], cut: [], familyRemoved: [], withheld: [], abstained: null, separationTau: null, notes: [], ...extra });

test('countChanged counts main picks missing from the other slate, per domain', () => {
  const main = [slate('movie', ['a', 'b', 'c']), slate('tv_show', ['t1', 't2']), slate('podcast', [])];
  const other = [slate('movie', ['a', 'x', 'y']), slate('tv_show', ['t1', 't2'])];
  const c = countChanged(main, other);
  assert.equal(c.changed, 2);
  assert.equal(c.total, 5, 'domains with no picks are not counted');
  assert.deepEqual(c.byDomain.map((d) => [d.domain, d.changed, d.total]), [['movie', 2, 3], ['tv_show', 0, 2]]);
  assert.equal(countChanged(main, main).changed, 0, 'the same slate changes nothing');
  assert.equal(countChanged(main, []).changed, 5, 'a completely different slate changes everything');
});

test('incomparable: a thinner or abstained comparison slate is refused rather than counted', () => {
  const main = [slate('movie', ['a', 'b', 'c'])];
  assert.equal(incomparable(main, [slate('movie', ['a', 'x', 'y'])]), null);
  assert.match(incomparable(main, [slate('movie', ['a'])])!, /fewer picks .*1 of 3/);
  assert.match(incomparable(main, [slate('movie', [], { abstained: 'no signal' })])!, /could not be ranked/);
  assert.match(incomparable(main, [])!, /could not be ranked/);
});

const row = (code: string, city: string, pct: number | null, status: NetworkRow['status']): NetworkRow =>
  ({ code, city, lat: 0, lon: 0, pctA: pct, pctB: pct, pct, affinityA: null, status });
const net = (rows: NetworkRow[], abstain: string | null = null): NetworkFit =>
  ({ seeds: { a: [], b: [] }, rows, tau: 0.5, paired: rows.length, abstain, topDestinations: [], evidence: [] });

test('the comparison city is the lowest-ranked agreed network city (a fixed, stated rule), with fallbacks', () => {
  const n = net([row('AAA', 'Alpha', 0.9, 'ranked'), row('BBB', 'Beta', 0.5, 'ranked'), row('CCC', 'Gamma', 0.1, 'ranked'), row('DDD', 'Delta', 0.3, 'ranked'), row('EEE', 'Eps', 0.7, 'ranked'), row('FFF', 'Zeta', null, 'withheld'), row('GGG', 'Eta', null, 'route-end')]);
  const c = swapCandidates(n);
  assert.deepEqual(c.map((x) => x.city), ['Gamma', 'Delta', 'Beta']);
  assert.equal(c.length, MAX_SWAP_TRIES);
  assert.equal(c[0]!.rankedCount, 5);
  assert.deepEqual(swapCandidates(net(n.rows, 'readings disagree')), [], 'a withheld network gives no principled comparison route');
  assert.deepEqual(swapCandidates(null), []);
  assert.deepEqual(swapCandidates(net([row('AAA', 'Alpha', 0.9, 'ranked'), row('BBB', 'Beta', 0.5, 'ranked')])), [], 'too few ranked cities');
});

test('the end carrying at least half the mix is the one replaced', () => {
  assert.equal(endToSwap(0.7), 'origin');
  assert.equal(endToSwap(0.5), 'destination');
  assert.equal(endToSwap(0.2), 'destination');
});

test('swapText is the one-line form shown on the Answer card', () => {
  assert.equal(swapText({ changed: 5, total: 12, against: 'Miami (synthetic) to Denver (synthetic)' }), 'Swap test: changes 5 of 12 picks versus Miami (synthetic) to Denver (synthetic).');
});

test('the run produces a swap test from its own slates, labelled synthetic', async () => {
  for (let i = 0; i < EXAMPLE_ROUTES.length; i++) {
    const r = (await runPipeline(req(i), opts()))!;
    const s = r.swap!;
    assert.ok(s.ran, `example ${i}: ${s.reason}`);
    const picks = r.domains.reduce((n, d) => n + d.picks.length, 0);
    assert.equal(s.total, picks, 'M is the number of picks on the Answer card');
    assert.ok(s.changed! >= 0 && s.changed! <= s.total!);
    assert.equal(s.byDomain!.reduce((n, d) => n + d.changed, 0), s.changed);
    assert.equal(s.text, `Swap test: changes ${s.changed} of ${s.total} picks versus ${s.against}.`);
    assert.match(s.against!, /\(synthetic\)/, 'fixture cities stay labelled synthetic');
    assert.equal(s.synthetic, true);
    assert.ok(s.qlooCalls! > 0);
    assert.match(s.basis!, /same catalogue, same passenger mix/i);
  }
});

test('N is verifiable: re-running the comparison route directly gives the same count', async () => {
  const r = (await runPipeline(req(1), opts()))!;
  const s = r.swap!;
  const swapEnd = endToSwap(r.route.originShare);
  const city = s.replaced === r.route.origin.label ? 'origin' : 'destination';
  assert.equal(city, swapEnd);
  const target = s.against!.replace(/ \(synthetic\)/g, '').split(' to ');
  const other = (await runPipeline({ ...req(1), origin: target[0]!, destination: target[1]!, swap: false, compare: false, autoConfirm: true }, opts()))!;
  const direct = countChanged(r.domains, other.domains);
  assert.equal(direct.changed, s.changed);
  assert.equal(direct.total, s.total);
});

test('the swap changes with the route: a different mix or route gives a recomputed number, not a constant', async () => {
  const a = (await runPipeline(req(1), opts()))!.swap!;
  const b = (await runPipeline(req(2), opts()))!.swap!;
  assert.notEqual(a.against, b.against);
  const c = (await runPipeline(req(1, { originShare: 0.9 }), opts()))!.swap!;
  assert.ok(c.ran);
  assert.notEqual(c.replaced, a.replaced, 'the end carrying more of the mix is the one replaced');
});

test('route-blind baselines change 0 picks between routes by construction', async () => {
  const { routeBlindPicks } = await import('../src/agent/baseline.ts');
  const items = (await runPipeline(req(1), opts()))!;
  assert.ok(items.comparison!.baselines.every((b) => b.routeBlind || b.id === 'llm'));
  const slots = { movie: 6, tv_show: 3, podcast: 3, artist: 2 };
  const resolved = items.domains.flatMap((d) => [...d.picks, ...d.bench]).map((p, i) => ({ domain: p.domain, title: p.title, line: i, year: 2020 + (i % 4) })) as never;
  assert.deepEqual(routeBlindPicks(resolved, slots), routeBlindPicks(resolved, slots));
});

test('swap: false skips it; the field is null, not a made-up number', async () => {
  const r = (await runPipeline(req(1, { swap: false }), opts()))!;
  assert.equal(r.swap, null);
});

test('the swap run is slate-only: it adds no evidence to the main ledger and no LLM calls', async () => {
  const withSwap = (await runPipeline(req(1), opts()))!;
  const without = (await runPipeline(req(1, { swap: false }), opts()))!;
  assert.equal(withSwap.evidence.length, without.evidence.length);
  assert.equal(withSwap.metrics.qlooCalls, without.metrics.qlooCalls, 'the main run\'s call count is unchanged; the swap reports its own');
  assert.deepEqual(withSwap.domains.map((d) => d.picks.map((p) => p.key)), without.domains.map((d) => d.picks.map((p) => p.key)), 'the swap never changes the main slate');
});

test('a swap that cannot be built is reported as not run, with the reason', async () => {
  const { FixtureQlooClient: F } = await import('../src/qloo/fixture-client.ts');
  class Failing extends F {
    n = 0;
    override async searchLocality(q: string) {
      if (++this.n > 2) throw new Error('boom');
      return super.searchLocality(q);
    }
  }
  const r = (await runPipeline(req(1), { qloo: new Failing(), llm: null, emit: () => {} }))!;
  assert.equal(r.swap!.ran, false);
  assert.match(r.swap!.reason!, /no comparison route gave a comparable slate/);
  assert.equal(r.swap!.changed, undefined, 'no number is shown');
});

test('grammar: "an origin favourite", "a destination favourite", "an Orlando favourite"', async () => {
  assert.equal(article('origin'), 'an');
  assert.equal(article('destination'), 'a');
  assert.equal(article('Orlando (synthetic)'), 'an');
  assert.equal(article('Seattle'), 'a');
  for (let i = 0; i < EXAMPLE_ROUTES.length; i++) {
    const r = (await runPipeline(req(i), opts()))!;
    const text = JSON.stringify(r.comparison);
    assert.ok(!/\ba origin\b/.test(text), 'no "a origin"');
    assert.ok(!/\ba [AEIOU]\w+ \(synthetic\) favourite/.test(text), 'no "a Orlando"-style slip');
  }
  const any = (await Promise.all(EXAMPLE_ROUTES.map((_, i) => runPipeline(req(i), opts())))).map((r) => JSON.stringify(r!.comparison)).join(' ');
  assert.match(any, /an origin favourite|a destination favourite/, 'the sentence is still produced');
});

test('tau is always glossed in the agent\'s own text', async () => {
  assert.equal(tauWords(-0.42), 'largely opposite order');
  assert.equal(tauWords(0.1), 'unrelated orders');
  assert.equal(tauWords(0.3), 'only loosely the same order');
  assert.equal(tauWords(0.6), 'mostly the same order');
  assert.equal(tauWords(0.9), 'almost the same order');
  assert.equal(tauNote(0.62), 'tau 0.62, i.e. ranked in mostly the same order');
  let seen = 0;
  for (let i = 0; i < EXAMPLE_ROUTES.length; i++) {
    const r = (await runPipeline(req(i), opts())) as SlateResult;
    const texts = [...r.trace.map((e) => ('detail' in e ? e.detail : 'text' in e ? e.text : '') ?? ''), ...r.domains.flatMap((d) => [d.abstained ?? '', ...d.notes]), ...r.claims.map((c) => c.text), r.network?.abstain ?? ''];
    for (const t of texts) for (const m of t.matchAll(/tau (-?\d\.\d\d)(.{0,40})/g)) { seen++; assert.match(m[2]!, /^, i\.e\. ranked in /, `bare tau in: ${t.slice(0, 120)}`); }
  }
  assert.ok(seen >= 3, 'the check saw tau values (not vacuous)');
});

test('network: the raw destination list carries each name\'s network code so the UI can explain omissions', async () => {
  const r = (await runPipeline(req(1), opts()))!;
  assert.ok(r.network!.topDestinations.length > 0);
  for (const d of r.network!.topDestinations) assert.ok(d.code === null || /^[A-Z]{3}$/.test(d.code!), String(d.code));
});
