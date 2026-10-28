import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FixtureQlooClient } from '../src/qloo/fixture-client.ts';
import { runPipeline } from '../src/agent/pipeline.ts';
import { SYNTHETIC_CATALOGUE } from '../src/examples.ts';
import type { TraceEvent } from '../src/agent/types.ts';
import type { LlmProvider } from '../src/llm/provider.ts';
import { QlooError } from '../src/qloo/types.ts';

const base = { origin: 'Minneapolis', destination: 'Orlando', originShare: 0.6, catalogue: SYNTHETIC_CATALOGUE, autoConfirm: true };

test('end to end on synthetic fixtures: slate, evidence, 100% grounding, synthetic labels', async () => {
  const events: TraceEvent[] = [];
  const r = await runPipeline(base, { qloo: new FixtureQlooClient(), llm: null, emit: (e) => events.push(e) });
  assert.ok(r);
  assert.equal(r.source, 'synthetic-fixture');
  assert.ok(r.domains.length >= 3);
  assert.ok(r.domains.some((d) => d.picks.length > 0));
  assert.equal(r.grounding.rate, 1);
  assert.ok(r.evidence.every((e) => e.source === 'synthetic-fixture'));
  assert.match(r.limits[0]!, /SYNTHETIC/);
  assert.ok(r.route.origin.anchors.artist.every((a) => a.name.endsWith('(synthetic)')), 'synthetic names keep their label');
  for (const d of r.domains) for (const p of d.picks) for (const c of p.why) assert.ok(c.evidence.every((id) => r.evidence.some((e) => e.id === id)));
  assert.ok(events.some((e) => e.type === 'result'));
  assert.ok(r.trace.length > 5 && !r.trace.some((e) => e.type === 'result'));
  assert.ok(r.comparison && r.comparison.kind === 'naive');
});

test('picks respect slots and family-safe rules', async () => {
  const r = await runPipeline({ ...base, familySafeOnly: true, slots: { movie: 3, tv_show: 1, podcast: 0, artist: 1 } }, { qloo: new FixtureQlooClient(), llm: null, emit: () => {} });
  const films = r!.domains.find((d) => d.domain === 'movie')!;
  assert.ok(films.picks.length <= 3);
  assert.ok(films.picks.every((p) => !p.contentRating || ['G', 'PG', 'PG-13'].includes(p.contentRating)));
  assert.equal(r!.domains.find((d) => d.domain === 'podcast')!.picks.length, 0);
});

test('asks for confirmation when a route end is ambiguous, then continues with the choice', async () => {
  const events: TraceEvent[] = [];
  const req = { ...base, origin: 'Portland', autoConfirm: false };
  const first = await runPipeline(req, { qloo: new FixtureQlooClient(), llm: null, emit: (e) => events.push(e) });
  assert.equal(first, null);
  const ask = events.find((e) => e.type === 'needs_confirmation');
  assert.ok(ask && ask.type === 'needs_confirmation' && ask.items[0]!.candidates.length === 2);
  const second = await runPipeline({ ...req, confirmations: { Portland: 'Portland, Maine (synthetic)' } }, { qloo: new FixtureQlooClient(), llm: null, emit: () => {} });
  assert.ok(second);
  assert.match(second.route.origin.label, /Portland/);
});

test('pinned mode detects the location-as-filter collapse and falls back to anchored scoring', async () => {
  const events: TraceEvent[] = [];
  const r = await runPipeline(base, { qloo: new FixtureQlooClient(), llm: null, emit: (e) => events.push(e), scoringMode: 'pinned' });
  assert.ok(events.some((e) => e.type === 'decision' && /Falling back to anchored/.test(e.text)));
  assert.ok(r!.domains.every((d) => d.mode === 'anchored'));
});

test('a budget error stops the run with a clear message', async () => {
  let n = 0;
  const qloo = new FixtureQlooClient({ onNetworkCall: () => { if (++n > 5) throw new QlooError('budget hit', 0, 'budget'); } });
  await assert.rejects(() => runPipeline(base, { qloo, llm: null, emit: () => {} }), /budget/);
});

test('unmatched titles are reported, not invented', async () => {
  const r = await runPipeline({ ...base, catalogue: 'movie: Paper Comets\nmovie: This title is not found\nmovie: Glass Orbit\nmovie: Quiet Fury' }, { qloo: new FixtureQlooClient(), llm: null, emit: () => {} });
  assert.ok(r!.unresolved.some((u) => /not found/.test(u.title)));
});

test('with an LLM: the baseline is parsed, invented titles are caught, and the note is validated', async () => {
  const fake: LlmProvider = {
    name: 'fake-llm',
    async completeJson(prompt: string) {
      if (prompt.includes('in-flight entertainment programmer')) return JSON.stringify({ movie: ['Paper Comets', 'A Film That Does Not Exist'], tv_show: ['Corner Booth'] });
      return JSON.stringify({ sentences: [{ text: 'Made-up claim with 999 viewers.', evidence: ['E1'] }, { text: 'Another with bad evidence.', evidence: ['E999'] }] });
    },
  };
  const r = await runPipeline(base, { qloo: new FixtureQlooClient(), llm: fake, emit: () => {} });
  assert.equal(r!.comparison!.kind, 'llm');
  assert.deepEqual(r!.comparison!.inventedTitles, ['A Film That Does Not Exist']);
  assert.ok(r!.programmerNote.every((n) => n.by === 'template'), 'invalid LLM sentences are rejected and the template is used');
});

test('an anchor is never a pick: each domain is scored with anchors from other domains', async () => {
  for (const [o, d] of [['Minneapolis', 'Orlando'], ['Atlanta', 'Seattle'], ['Miami', 'Denver']]) {
    const r = await runPipeline({ ...base, origin: o!, destination: d! }, { qloo: new FixtureQlooClient(), llm: null, emit: () => {} });
    const anchorIds = new Set(r!.evidence.filter((e) => e.step.startsWith('Anchored read')).flatMap((e) => (e.params['signal.interests.entities'] ?? '').split(',')));
    for (const ds of r!.domains) for (const p of ds.picks) assert.ok(!anchorIds.has(p.entityId), `${p.title} was an anchor and a pick`);
    for (const ev of r!.evidence.filter((e) => e.step.startsWith('Anchored read'))) {
      const target = ev.params['filter.type'];
      assert.ok(!ev.step.includes(`anchors (${({ 'urn:entity:movie': 'films', 'urn:entity:tv_show': 'tv', 'urn:entity:artist': 'music' } as Record<string, string>)[target!] ?? '-'})`), 'same-domain anchors');
    }
  }
});

test('ranks use the same n at both ends with no duplicates, and picks clear the fit floor', async () => {
  const r = await runPipeline(base, { qloo: new FixtureQlooClient(), llm: null, emit: () => {} });
  for (const ds of r!.domains) {
    const ranked = [...ds.picks, ...ds.bench].filter((p) => p.rankOrigin && p.rankDest);
    const ro = ranked.map((p) => p.rankOrigin);
    assert.equal(new Set(ro).size, ro.length, 'no duplicate origin ranks');
    for (const p of ranked) assert.ok(p.rankOrigin! <= p.rankN! && p.rankDest! <= p.rankN!);
    for (const p of ds.picks) assert.ok(p.fit >= 0.3, `${p.title} fit ${p.fit} below floor`);
  }
});

test('a tiny catalogue abstains instead of claiming "#1 of 1, fit 100"', async () => {
  const r = await runPipeline({ ...base, catalogue: 'movie: Paper Comets\nmovie: Glass Orbit\ntv: Corner Booth' }, { qloo: new FixtureQlooClient(), llm: null, emit: () => {} });
  for (const ds of r!.domains) {
    assert.equal(ds.picks.length, 0);
    assert.match(ds.abstained ?? '', /Your catalogue has only \d/, 'the message blames the catalogue, not the cities');
    assert.ok(!ds.notes.some((n) => /abstained/.test(n)), 'no repeated per-city abstention notes');
  }
});

test('an unknown city stops the run with a clear message', async () => {
  await assert.rejects(() => runPipeline({ ...base, origin: 'Qwxzy' }, { qloo: new FixtureQlooClient(), llm: null, emit: () => {} }), /no place matching "Qwxzy"/);
});

test('synthetic mode labels every title, including real ones pasted in', async () => {
  const r = await runPipeline({ ...base, catalogue: 'movie: Wicked (2024)\nmovie: Fargo (1996)\nmovie: Moonlight (2016)\nmovie: Coco (2017)\ntv: Bluey' }, { qloo: new FixtureQlooClient(), llm: null, emit: () => {} });
  const titles = [...r!.domains.flatMap((d) => [...d.picks, ...d.bench, ...d.cut].map((p) => p.title)), ...r!.unresolved.map((u) => u.title)];
  assert.ok(titles.length > 0);
  for (const t of titles) assert.match(t, /\(synthetic\)$/);
  const facts = r!.evidence.flatMap((e) => e.facts).filter((f) => /Wicked|Bluey/.test(f));
  for (const f of facts) assert.match(f, /\(synthetic\)/);
});

test('single-end picks never claim one city ranks it higher than the other', async () => {
  const events: TraceEvent[] = [];
  const r = await runPipeline(base, { qloo: new FixtureQlooClient(), llm: null, emit: (e) => events.push(e) });
  for (const ds of r!.domains) for (const p of ds.picks) {
    if (p.side === 'single-end') assert.ok(!p.why.some((c) => /ranks it well above/.test(c.text)));
    if (p.side === 'origin' || p.side === 'destination') assert.ok(p.rankOrigin && p.rankDest);
  }
  // Recovery loop is logged whenever an end abstains on the first attempt.
  const firstAbstain = events.some((e) => e.type === 'step' && /score-.*-0$/.test(e.id) && e.status === 'warn' && !/needed to rank/.test(e.detail ?? ''));
  if (firstAbstain) assert.ok(events.some((e) => e.type === 'decision' && /retrying once/.test(e.text)));
});

test('every ranked domain uses two consistent readings per city; no rescued single reading', async () => {
  for (const [o, d] of [['Minneapolis', 'Orlando'], ['Atlanta', 'Seattle'], ['Miami', 'Denver']]) {
    const events: TraceEvent[] = [];
    const r = await runPipeline({ ...base, origin: o!, destination: d! }, { qloo: new FixtureQlooClient(), llm: null, emit: (e) => events.push(e) });
    for (const ds of r!.domains) if (ds.picks.length) assert.equal(ds.readings, 2, `${o}-${d} ${ds.label}`);
    assert.ok(!events.some((e) => e.type === 'step' && /: 1 anchored reading$/.test(e.label)), 'no single anchored reading');
  }
});

test('cities are compared only on 5 or more paired titles', async () => {
  const r = await runPipeline({ ...base, catalogue: SYNTHETIC_CATALOGUE.split('\n').filter((l) => !/^podcast:/.test(l) || /Tailwind|Layover|Small Plates|Case File/.test(l)).join('\n') }, { qloo: new FixtureQlooClient(), llm: null, emit: () => {} });
  const pods = r!.domains.find((d) => d.domain === 'podcast')!;
  assert.equal(pods.separationTau, null);
});

test('empty slots report the real cause; family-safe removals are not listed as weak fit or bench', async () => {
  const r = await runPipeline({ ...base, familySafeOnly: true, slots: { movie: 12, tv_show: 8, podcast: 6, artist: 6 } }, { qloo: new FixtureQlooClient(), llm: null, emit: () => {} });
  for (const ds of r!.domains) {
    const fam = new Set(ds.familyRemoved.map((x) => x.key));
    const cut = new Set(ds.cut.map((x) => x.key));
    for (const b of ds.bench) assert.ok(!fam.has(b.key) && !cut.has(b.key), 'bench is disjoint from removed and below-floor');
    for (const c of ds.cut) assert.ok(!fam.has(c.key));
    if (!ds.abstained && ds.picks.length < ds.slots) assert.ok(ds.notes.some((n) => /slots filled: .*(family-safe|floor|withheld|no more titles|without a Qloo score)/.test(n)), ds.notes.join(' | '));
  }
  const tv = r!.domains.find((d) => d.domain === 'tv_show')!;
  if (tv.familyRemoved.length) assert.ok(tv.notes.some((n) => /removed by the family-safe rule/.test(n)));
});

test('the no-LLM comparison names the route-blind baselines, says no LLM ran, and calls the fit gap circular', async () => {
  const r = await runPipeline(base, { qloo: new FixtureQlooClient(), llm: null, emit: () => {} });
  const c = r!.comparison!;
  assert.match(c.caveat, /newest-first/);
  assert.match(c.caveat, /No LLM baseline ran/);
  assert.match(c.caveat, /NOT evidence/);
  assert.ok(!/LLM's unaided judgement/.test(c.caveat));
});

test('shortCity keeps the synthetic label', async () => {
  const { shortCity } = await import('../src/agent/pipeline.ts');
  assert.equal(shortCity('Portland, Oregon (synthetic)'), 'Portland (synthetic)');
  assert.equal(shortCity('Portland, Oregon'), 'Portland');
});

test('network fit, arrival spotlight and theme run on synthetic fixtures, labelled and grounded', async () => {
  const events: TraceEvent[] = [];
  const r = (await runPipeline({ ...base, theme: 'family' }, { qloo: new FixtureQlooClient(), llm: null, emit: (e) => events.push(e) }))!;
  assert.ok(r.network, 'network fit ran');
  assert.equal(r.network!.evidence.length, 2, 'two destination readings');
  const sa = new Set(r.network!.seeds.a);
  assert.ok(r.network!.seeds.b.every((t) => !sa.has(t)), 'seed halves are disjoint');
  assert.ok(r.network!.rows.filter((x) => x.status === 'route-end').length === 2);
  assert.ok(r.network!.topDestinations.every((d) => d.name.endsWith('(synthetic)')));
  assert.ok(r.spotlight && r.spotlight.items.length > 0);
  assert.ok(r.spotlight!.items.every((i) => i.title.endsWith('(synthetic)')));
  assert.ok(r.theme && r.theme.tag, 'theme resolved to a tag');
  assert.ok(r.evidence.some((e) => e.path === '/v2/tags'));
  assert.ok(r.evidence.some((e) => e.params['filter.type'] === 'urn:entity:destination' && e.params['filter.geocode.country_code'] === 'US'));
  assert.ok(r.evidence.some((e) => 'filter.tags' in e.params));
  assert.equal(r.grounding.rate, 1);
  assert.ok(r.metrics.qlooCalls <= 110, 'stays inside the per-run budget');
  assert.ok(events.some((e) => e.type === 'step' && e.id === 'network'));
});

test('no theme means no tag search; an unmatched theme says so instead of guessing', async () => {
  const none = (await runPipeline(base, { qloo: new FixtureQlooClient(), llm: null, emit: () => {} }))!;
  assert.equal(none.theme, null);
  assert.ok(!none.evidence.some((e) => e.path === '/v2/tags'));
  const odd = (await runPipeline({ ...base, theme: 'qzx' }, { qloo: new FixtureQlooClient(), llm: null, emit: () => {} }))!;
  assert.equal(odd.theme!.tag, null);
  assert.match(odd.theme!.note, /no film or TV tag/);
});

test('network fit is withheld when the two destination readings disagree', async () => {
  const inner = new FixtureQlooClient();
  let n = 0;
  const flip = new Proxy(inner, {
    get(target, prop, recv) {
      if (prop === 'destinations') {
        return async (req: Parameters<FixtureQlooClient['destinations']>[0]) => {
          const r = await target.destinations(req);
          if (n++ === 1) r.data.reverse();
          return r;
        };
      }
      const v = Reflect.get(target, prop, recv);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  const r = (await runPipeline(base, { qloo: flip, llm: null, emit: () => {} }))!;
  assert.match(r.network!.abstain ?? '', /disagree/);
  assert.ok(!r.claims.some((c) => /network/.test(c.text)));
});

test('network fit is skipped, not faked, with fewer than 4 consistency-checked picks', async () => {
  const events: TraceEvent[] = [];
  const r = (await runPipeline({ ...base, slots: { movie: 2, tv_show: 1, podcast: 0, artist: 0 } }, { qloo: new FixtureQlooClient(), llm: null, emit: (e) => events.push(e) }))!;
  assert.equal(r.network, null);
  assert.ok(events.some((e) => e.type === 'decision' && /Network fit skipped/.test(e.text)));
});

test('theme leads never repeat arrival-spotlight leads', async () => {
  const r = (await runPipeline({ ...base, theme: 'comedy' }, { qloo: new FixtureQlooClient(), llm: null, emit: () => {} }))!;
  const spot = new Set((r.spotlight?.items ?? []).map((i) => i.title));
  assert.ok((r.theme?.items ?? []).every((i) => !spot.has(i.title)));
});
