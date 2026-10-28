// Tests for the independent-review fixes: honest baselines, the single-end scale, the origin in
// network fit, the fixture rejecting unknown places, and the plain-text claims in the UI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { FixtureQlooClient, isKnownPlace } from '../src/qloo/fixture-client.ts';
import { UserFacingError, runPipeline } from '../src/agent/pipeline.ts';
import { SYNTHETIC_CATALOGUE } from '../src/examples.ts';
import { DEFAULT_NETWORK, isRouteEndName } from '../src/agent/network.ts';
import { routeBlindPicks, tagTypicality } from '../src/agent/baseline.ts';
import { DEFAULT_SLOTS } from '../src/agent/pipeline.ts';
import { parseCatalogue } from '../src/agent/catalogue.ts';
import type { LlmProvider } from '../src/llm/provider.ts';
import type { TraceEvent } from '../src/agent/types.ts';
import type { InsightsRequest, QlooClient } from '../src/qloo/types.ts';
import { APP_JS } from '../src/ui/app.ts';
import { APP_CSS } from '../src/ui/styles.ts';
import { PAGE_HTML } from '../src/ui/page.ts';

const base = { origin: 'Minneapolis', destination: 'Orlando', originShare: 0.6, catalogue: SYNTHETIC_CATALOGUE, autoConfirm: true };
const quiet = { llm: null, emit: () => {} };

// ---------- 1. baselines ----------
test('without a key, three route-blind baselines run, no LLM baseline exists, and the text says so', async () => {
  const c = (await runPipeline(base, { qloo: new FixtureQlooClient(), ...quiet }))!.comparison!;
  assert.deepEqual(c.baselines.map((b) => b.id).sort(), ['generic-taste', 'newest', 'popularity']);
  assert.equal(c.llmRan, false);
  assert.ok(c.baselines.every((b) => b.routeBlind && b.id !== 'llm'));
  assert.match(c.ran, /No LLM baseline ran/);
  assert.ok(c.baselines.every((b) => b.inventedTitles.length === 0));
  assert.match(c.caveat, /circular|NOT evidence/);
});

test('route-blind baselines pick the same titles on every route; Seatback does not', async () => {
  const a = (await runPipeline(base, { qloo: new FixtureQlooClient(), ...quiet }))!;
  const b = (await runPipeline({ ...base, origin: 'Atlanta', destination: 'Seattle' }, { qloo: new FixtureQlooClient(), ...quiet }))!;
  for (const id of ['newest', 'popularity', 'generic-taste'] as const) {
    assert.deepEqual(a.comparison!.baselines.find((x) => x.id === id)!.picks, b.comparison!.baselines.find((x) => x.id === id)!.picks, id);
  }
  const seat = (r: typeof a) => r.domains.flatMap((d) => d.picks.map((p) => p.title)).sort().join('|');
  assert.notEqual(seat(a), seat(b), 'the Seatback slate changes with the route');
});

test('baseline pick functions are pure and respect slot counts', () => {
  const items = parseCatalogue('movie: Alpha Film (2020)\nmovie: Beta Film (2024)\nmovie: Gamma Film (2022)\ntv: Show One\ntv: Show Two', 40).items.map((it) => ({ ...it, entity: { entity_id: it.title, popularity: it.title === 'Alpha Film' ? 0.9 : 0.1, tags: [{ id: 'x' }] } }));
  const out = routeBlindPicks(items, { ...DEFAULT_SLOTS, movie: 2, tv_show: 1 });
  assert.deepEqual(out.find((o) => o.id === 'newest')!.picks.movie, ['Beta Film', 'Gamma Film']);
  assert.deepEqual(out.find((o) => o.id === 'popularity')!.picks.movie![0], 'Alpha Film');
  assert.equal(out.find((o) => o.id === 'newest')!.picks.tv_show!.length, 1);
  assert.equal(tagTypicality(items).size, items.length);
});

test('the popularity baseline is skipped, not faked, when the catalogue carries no popularity', () => {
  const items = parseCatalogue('movie: Alpha Film (2020)\nmovie: Beta Film (2024)', 40).items.map((it) => ({ ...it, entity: { entity_id: it.title } }));
  assert.deepEqual(routeBlindPicks(items, DEFAULT_SLOTS).map((o) => o.id), ['newest']);
});

test('an LLM baseline runs only when an LLM is configured, and a failing LLM leaves it out', async () => {
  const good: LlmProvider = { name: 'fake-llm', completeJson: async (p) => (p.includes('in-flight entertainment programmer') ? JSON.stringify({ movie: ['Paper Comets', 'Made Up'] }) : '{}') };
  const withLlm = (await runPipeline(base, { qloo: new FixtureQlooClient(), llm: good, emit: () => {} }))!.comparison!;
  assert.equal(withLlm.llmRan, true);
  assert.equal(withLlm.baselines[0]!.id, 'llm');
  assert.deepEqual(withLlm.baselines[0]!.inventedTitles, ['Made Up']);
  assert.match(withLlm.ran, /ran because an LLM key is configured/);
  const events: TraceEvent[] = [];
  const bad: LlmProvider = { name: 'broken', completeJson: async (p) => { if (p.includes('in-flight entertainment programmer')) throw new Error('boom'); return '{}'; } };
  const failed = (await runPipeline(base, { qloo: new FixtureQlooClient(), llm: bad, emit: (e) => events.push(e) }))!.comparison!;
  assert.equal(failed.llmRan, false);
  assert.ok(!failed.baselines.some((b) => b.id === 'llm'));
  assert.match(failed.ran, /did not run/);
  assert.ok(events.some((e) => e.type === 'step' && e.id === 'compare' && e.status === 'warn'));
});

test('mean baseline fit counts only picks that have a route fit', async () => {
  const c = (await runPipeline(base, { qloo: new FixtureQlooClient(), ...quiet }))!.comparison!;
  for (const b of c.baselines) assert.ok(b.scored + b.unscored >= 1 && (b.meanFit === null || (b.meanFit >= 0 && b.meanFit <= 1)));
});

// ---------- 5. worked example ----------
test('the worked example is computed from the run, labelled synthetic, and claims no validation', async () => {
  const r = (await runPipeline(base, { qloo: new FixtureQlooClient(), ...quiet }))!;
  const w = r.comparison!.workedExample;
  assert.ok(w, 'a decision differs between the baseline and Seatback');
  assert.match(w.label, /^Synthetic example/);
  assert.match(w.text, /not a measured gain/);
  assert.ok(!/validated|proves|proven/i.test(w.text));
  const picks = r.domains.find((d) => d.domain === w.domain)!.picks.map((p) => p.title);
  assert.ok(picks.includes(w.add.title) && !picks.includes(w.drop.title));
  assert.ok(w.add.fit > w.drop.fit);
  assert.ok(w.text.includes('(synthetic)'), 'titles keep their synthetic label');
});

// ---------- 4a. origin in network fit ----------
test('the route origin and destination are never listed as network candidates or top destinations', async () => {
  const r = (await runPipeline(base, { qloo: new FixtureQlooClient(), ...quiet }))!;
  const net = r.network!;
  assert.ok(net.topDestinations.every((d) => !/minneapolis|orlando/i.test(d.name)), net.topDestinations.map((d) => d.name).join());
  assert.ok(net.rows.filter((x) => x.status === 'ranked').every((x) => x.code !== 'MSP' && x.code !== 'MCO'));
  assert.equal(net.rows.find((x) => x.code === 'MSP')!.status, 'route-end');
});

test('isRouteEndName matches by name, alias or documented geocode name', () => {
  assert.equal(isRouteEndName({ name: 'Twin Cities' }, DEFAULT_NETWORK, ['Minneapolis']), true);
  assert.equal(isRouteEndName({ name: 'Minneapolis, Minnesota (synthetic)' }, DEFAULT_NETWORK, ['Minneapolis']), true);
  assert.equal(isRouteEndName({ name: 'Mile High', properties: { geocode: { name: 'Denver' } } }, DEFAULT_NETWORK, ['Denver']), true);
  assert.equal(isRouteEndName({ name: 'Tampa' }, DEFAULT_NETWORK, ['Minneapolis', 'Orlando']), false);
  assert.equal(isRouteEndName({ name: 'Honolulu' }, DEFAULT_NETWORK, ['Honolulu']), true, 'an origin outside the network is still excluded by name');
});

// ---------- 4b. single-end scale ----------
/** A fixture where the origin has no open-read data, so only the destination can be read. */
function originBlind(): QlooClient {
  const inner = new FixtureQlooClient();
  return new Proxy(inner, {
    get(t, prop, recv) {
      if (prop === 'insights') {
        return async (req: InsightsRequest) => {
          const r = await t.insights(req);
          if (req.location && 'query' in req.location && /minneapolis/i.test(req.location.query) && !req.onlyEntityIds) r.data = [];
          return r;
        };
      }
      const v = Reflect.get(t, prop, recv);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  }) as QlooClient;
}

test('a single-end slate is flagged as a different scale and is not described as route fit', async () => {
  const r = (await runPipeline(base, { qloo: originBlind(), ...quiet }))!;
  const single = r.domains.filter((d) => d.picks.length && d.picks.every((p) => p.side === 'single-end'));
  assert.ok(single.length > 0, 'at least one domain is single-end');
  for (const d of single) {
    assert.equal(d.scale, 'single-end');
    for (const p of d.picks) {
      assert.ok(p.why.every((c) => !/^Route fit/.test(c.text)), 'no "Route fit" sentence for a one-city pick');
      assert.ok(p.why.some((c) => /not a route fit/.test(c.text)));
    }
  }
  assert.ok(r.domains.filter((d) => !single.includes(d)).every((d) => d.scale === 'route'));
  // The comparison's Seatback mean never mixes in one-city scores.
  const routeOnly = r.domains.flatMap((d) => d.picks).filter((p) => p.side !== 'single-end');
  const c = r.comparison!;
  if (!routeOnly.length) assert.equal(c.meanFitSeatback, null);
  // The network is not seeded from one-city picks.
  if (r.network) assert.ok(r.network.seeds.a.concat(r.network.seeds.b).every((t) => !single.some((d) => d.picks.some((p) => p.title === t))));
});

test('on a normal run no domain is labelled single-end', async () => {
  const r = (await runPipeline(base, { qloo: new FixtureQlooClient(), ...quiet }))!;
  assert.ok(r.domains.every((d) => d.scale === 'route'));
});

// ---------- 4c. fixture rejects unknown places ----------
test('the fixture rejects unknown places so the stop is demonstrable; real cities still resolve', async () => {
  const q = new FixtureQlooClient();
  assert.equal((await q.searchLocality('Atlantis')).data.length, 0);
  assert.equal((await q.searchLocality('Gotham City')).data.length, 0);
  assert.equal((await q.searchLocality('Orlando, Florida')).data.length, 1);
  assert.equal((await q.searchLocality('portland')).data.length, 2, 'ambiguous');
  assert.equal((await q.searchLocality('Springfield')).data.length, 2, 'ambiguous');
  assert.ok(isKnownPlace('Honolulu') && isKnownPlace('Las Vegas') && isKnownPlace('Twin Cities') && !isKnownPlace('Atlantis'));
  await assert.rejects(() => runPipeline({ ...base, destination: 'Atlantis' }, { qloo: new FixtureQlooClient(), ...quiet }), (e) => e instanceof UserFacingError && /no place matching "Atlantis"/.test(e.message));
});

test('every demo route city is accepted by the fixture', () => {
  for (const c of ['Minneapolis', 'Orlando', 'Atlanta', 'Seattle', 'Miami', 'Denver', 'Boston', 'Las Vegas', 'Chicago', 'Honolulu', 'Dallas', 'New York', 'Phoenix']) assert.ok(isKnownPlace(c), c);
});

// ---------- UI: plain-text claims and structure ----------
test('the page makes no unconditional LLM-only or invented-titles claim', () => {
  assert.ok(!/LLM-only/.test(PAGE_HTML));
  assert.ok(!/titles it invented/i.test(PAGE_HTML + APP_JS));
  // "invented" in the client appears only where the comparison reports an LLM baseline's own titles.
  assert.match(APP_JS, /b\.id === 'llm' \? String\(b\.inventedTitles\.length\)/);
  assert.match(APP_JS, /No LLM baseline ran|c\.ran/);
});

test('the first result screen is an Answer with How Qloo is used one tap away; detail and evidence chips are collapsed', () => {
  assert.match(APP_JS, /id: 'answer'/);
  assert.match(APP_JS, /'How Qloo is used'/);
  assert.match(APP_JS, /id: 'fullslate'/);
  assert.ok(!/id: 'fullslate'[^\n]*open/.test(APP_JS), 'the full slate starts closed');
  assert.match(APP_CSS, /#tab-slate \.ev \{ display: none; \}/);
  assert.match(APP_CSS, /#tab-slate\.evon \.ev/);
  assert.match(PAGE_HTML, /<details class="howto">/);
});

test('phone layout: tabs wrap instead of hiding behind a fade, the tagline is short, glance tiles do not wrap', () => {
  assert.match(APP_CSS, /\.tabs \{ flex-wrap: wrap; overflow-x: visible; \}/);
  assert.ok(!/tabs-wrap::after/.test(APP_CSS), 'no hidden-scroll fade');
  assert.match(PAGE_HTML, /tag-short/);
  assert.match(APP_CSS, /\.glance \.tile b \{ overflow-wrap: normal; white-space: nowrap; \}/);
  assert.ok(!/'Cities ' \+ sepLabel/.test(APP_JS), 'the tile headline is one short word');
});

test('the 2018 / one provider qualifier sits next to the $315M figure on the page', () => {
  assert.match(PAGE_HTML, /\$315M[\s\S]{0,200}2018, one provider/);
});

const INTERNAL_KIT = new URL('../../seatback-internal/SUBMISSION-KIT.md', import.meta.url);
// Reported as SKIPPED (not passed) when the internal folder is absent, as it is in the published repository.
test('the internal Devpost text has no unfilled bracket template, no unconditional LLM claims, and states 2018, one provider', { skip: !existsSync(INTERNAL_KIT) && 'internal kit not present in this tree' }, () => {
  const f = INTERNAL_KIT;
  const kit = readFileSync(f, 'utf8');
  const devpost = kit.slice(kit.indexOf('## 1.'), kit.indexOf('## 2.'));
  assert.ok(!/titles it invented|LLM-only" baseline|"LLM-only"/.test(kit.slice(0, kit.indexOf('## 3.'))), 'no LLM-only baseline claim in text or script');
  assert.ok(!/\[gemini|\[heatmap result\]/.test(devpost), 'conditional lines removed');
  assert.match(devpost, /FILL AFTER LIVE RUN/);
  assert.match(devpost, /PASS version/);
  assert.match(devpost, /FAIL version/);
  assert.match(devpost, /\$315\.4M[^.]{0,120}2018, one provider/);
  assert.match(devpost, /fixture replay/i);
  const stray = devpost.replace(/>>> FILL AFTER LIVE RUN[\s\S]*?<<< END FILL/g, '').match(/\[[^\]\n]{1,60}\]/g)?.filter((x) => !/^\[(Runway|SEC|Platinum|APEX)/.test(x) && !/\]\(/.test(x)) ?? [];
  assert.deepEqual(stray, [], 'every bracket lives inside a FILL AFTER LIVE RUN block');
});
