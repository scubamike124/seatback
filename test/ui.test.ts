// The real client script, run against the real page markup in a small fake DOM (test/fake-dom.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { runPipeline } from '../src/agent/pipeline.ts';
import { FixtureQlooClient } from '../src/qloo/fixture-client.ts';
import { EXAMPLE_ROUTES, SYNTHETIC_CATALOGUE } from '../src/examples.ts';
import type { SlateResult } from '../src/agent/types.ts';
import { APP_JS } from '../src/ui/app.ts';
import { APP_CSS } from '../src/ui/styles.ts';
import { bootApp, json } from './fake-dom.ts';

const ex = EXAMPLE_ROUTES[0]!;
let cached: SlateResult | null = null;
async function result(): Promise<SlateResult> {
  cached ??= (await runPipeline({ ...ex.request, catalogue: SYNTHETIC_CATALOGUE }, { qloo: new FixtureQlooClient(), llm: null, emit: () => {} }))!;
  return cached;
}

async function app(opts: { slate?: () => Response } = {}) {
  const r = await result();
  const a = await bootApp({
    '/api/config': () => json({ mode: 'synthetic', llm: null, sampleCatalogue: SYNTHETIC_CATALOGUE, examples: EXAMPLE_ROUTES.map(({ id, title, blurb, request }) => ({ id, title, blurb, request })) }),
    '/api/example/*': () => json({ provenance: 'stored-recording', result: r }),
    '/api/slate': opts.slate ?? (() => json({ error: 'unused' }, 400)),
  });
  return { a, r };
}
const ndjson = (...evs: unknown[]) => new Response(evs.map((e) => JSON.stringify(e)).join('\n') + '\n', { status: 200 });

test('the page loads the example list from config', async () => {
  const { a } = await app();
  assert.equal(a.$('examples').querySelectorAll('button').length, EXAMPLE_ROUTES.length);
  assert.match(a.text('mode-pill'), /SYNTHETIC/);
});

test('Evidence tab: stacked rows, collapsed, capped, "show more" and no four-column table', async () => {
  const { a, r } = await app();
  a.$('examples').querySelectorAll('button')[0]!.click();
  await a.settle();
  const ev = a.$('tab-evidence');
  assert.equal(ev.querySelectorAll('table').length, 0, 'no table to clip on a phone');
  const rows = ev.querySelectorAll('.evrow');
  assert.equal(rows.length, r.evidence.length);
  assert.ok(rows.length > 8, 'the fixture run has more calls than the first page');
  assert.equal(rows.filter((x) => !x.hidden).length, 8, 'only the first 8 are listed');
  assert.equal(rows.filter((x) => x.open).length, 0, 'every row starts collapsed');
  assert.match(a.text('ev-count'), new RegExp(`Showing 8 of ${r.evidence.length} fixture calls \\(not Qloo\\)`));
  a.$('ev-more').click();
  assert.equal(ev.querySelectorAll('.evrow').filter((x) => !x.hidden).length, 16);
  a.$('ev-all').click();
  assert.equal(ev.querySelectorAll('.evrow').filter((x) => x.hidden).length, 0);
  assert.ok(a.$('ev-more').hidden, 'nothing more to show');
  assert.match(APP_CSS, /\.evlist \{[^}]*max-height: 70vh;[^}]*overflow-y: auto/, 'the list has a height cap');
  assert.match(APP_CSS, /\.evrow \.evbody code \{[^}]*overflow-wrap: anywhere/, 'long call text wraps instead of clipping');
});

test('clicking an evidence chip whose row is hidden reveals and opens it', async () => {
  const { a, r } = await app();
  a.$('examples').querySelectorAll('button')[0]!.click();
  await a.settle();
  const lastId = r.evidence[r.evidence.length - 1]!.id;
  const chip = a.$('tab-slate').querySelectorAll('.ev').find((c) => c.attrs['title'] === 'Show evidence ' + lastId) ?? a.$('tab-slate').querySelectorAll('.ev')[0]!;
  const id = chip.attrs['title']!.replace('Show evidence ', '');
  chip.click();
  const row = a.$('ev-' + id);
  assert.equal(row.hidden, false);
  assert.equal(row.open, true);
});

test('after an error, the previous run\'s answer card, tabs and trace are gone', async () => {
  const { a } = await app({ slate: () => ndjson({ type: 'step', id: 'resolve-origin', label: 'Resolve origin: "Atlantis"', status: 'error' }, { type: 'error', message: 'Qloo has no place matching "Atlantis".' }) });
  a.$('examples').querySelectorAll('button')[0]!.click();
  await a.settle();
  assert.ok(a.$('tab-slate').querySelector('#answer'), 'a result is on screen first');
  assert.ok(a.$('pass').children.length > 0);
  assert.equal(a.$('tabs-wrap').hidden, false);
  const oldTrace = a.$('trace').children.length;
  assert.ok(oldTrace > 3);

  a.$('origin').value = 'Atlantis';
  a.$('form').dispatch('submit');
  await a.settle();
  assert.equal(a.$('error').hidden, false);
  assert.match(a.text('error'), /Atlantis/);
  for (const t of ['slate', 'qloo', 'compare', 'evidence', 'limits']) assert.equal(a.$('tab-' + t).children.length, 0, `${t} tab is empty`);
  assert.equal(a.$('pass').children.length, 0, 'no boarding-pass card');
  assert.equal(a.$('tabs-wrap').hidden, true, 'no tab bar');
  assert.equal(a.$('trace').children.length, 1, 'only the failed run\'s own step remains');
  assert.equal(a.$('trace-note').hidden, false);
  assert.deepEqual(a.doc.querySelectorAll('.tabpanel').filter((p) => !p.hidden).map((p) => p.id), ['tab-trace']);
  assert.equal(a.doc.querySelector('#answer'), null);
  assert.match(APP_CSS, /\.pass:empty \{ display: none; \}/, 'the emptied card shell is not drawn');
});

test('a plain HTTP error also clears the previous run, and a new run brings the tabs back', async () => {
  let n = 0;
  const { a, r } = await app({ slate: () => (n++ === 0 ? json({ error: 'Too many requests.' }, 429) : ndjson({ type: 'result', result: r2 })) });
  const r2 = r;
  a.$('examples').querySelectorAll('button')[0]!.click();
  await a.settle();
  a.$('form').dispatch('submit');
  await a.settle();
  assert.equal(a.$('tab-slate').children.length, 0);
  assert.equal(a.$('out').hidden === false ? a.$('trace').children.length : 0, 0, 'no old trace either');
  a.$('form').dispatch('submit');
  await a.settle();
  assert.equal(a.$('tabs-wrap').hidden, false);
  assert.equal(a.$('error').hidden, true);
  assert.ok(a.$('tab-slate').querySelector('#answer'));
});

test('the Answer card shows the swap test line, computed from the run', async () => {
  const { a, r } = await app();
  a.$('examples').querySelectorAll('button')[0]!.click();
  await a.settle();
  assert.ok(r.swap?.ran);
  const line = a.$('swap-test').querySelector('.swap-line')!.textContent;
  assert.equal(line, `Swap test: changes ${r.swap!.changed} of ${r.swap!.total} picks versus ${r.swap!.against}.`);
  assert.match(line, /\(synthetic\)/);
  assert.match(a.$('swap-test').textContent, /route-blind baseline changes 0 of \d+ by construction/);
  assert.match(a.$('swap-test').textContent, /does not show the new picks are better/);
});

test('the worked example appears once on the page, on the Answer card, not again in the Baselines tab', async () => {
  const { a, r } = await app();
  a.$('examples').querySelectorAll('button')[0]!.click();
  await a.settle();
  const text = r.comparison!.workedExample?.text;
  assert.ok(text, 'the fixture run has a worked example');
  const all = ['tab-slate', 'tab-qloo', 'tab-compare', 'tab-evidence', 'tab-limits'].map((t) => a.$(t).textContent).join('\n');
  assert.equal(all.split(text!).length - 1, 1, 'the worked example text occurs exactly once');
  assert.equal(a.$('tab-compare').textContent.includes(text!), false);
  assert.match(a.$('tab-compare').textContent, /on the Answer card/);
});

test('"tau" always comes with a plain-language gloss', async () => {
  const { a, r } = await app();
  a.$('examples').querySelectorAll('button')[0]!.click();
  await a.settle();
  const all = ['tab-slate', 'tab-qloo', 'tab-compare'].map((t) => a.$(t).textContent).join('\n');
  const taus = [...all.matchAll(/tau (-?\d\.\d\d|n\/a)([^)]{0,90})/g)];
  assert.ok(taus.length > 0, 'tau is shown');
  for (const m of taus) assert.match(m[2]!, /[:,] .*(order|alike|opposite|same)/, `gloss next to "tau ${m[1]}"`);
  assert.ok(r.domains.some((d) => d.separationTau !== null));
});

test('tau gloss covers a negative tau in words', () => {
  assert.match(APP_JS, /largely opposite order/);
  assert.match(APP_JS, /unrelated orders/);
});

test('the network list explains every destination it names that the best-routes list leaves out', async () => {
  const { a, r } = await app();
  a.$('examples').querySelectorAll('button')[0]!.click();
  await a.settle();
  const net = r.network!;
  const best = new Set(net.rows.filter((x) => x.status === 'ranked').slice(0, 6).map((x) => x.city));
  const line = a.$('tab-slate').querySelectorAll('p').map((p) => p.textContent).find((t) => /raw top US destinations/.test(t))!;
  assert.ok(line, 'the destinations line is on the page');
  assert.match(line, /before filtering to your network/);
  for (const d of net.topDestinations) {
    const city = d.name.replace(/ \(synthetic\)$/, '');
    if (best.has(city)) continue;
    assert.match(line, new RegExp(city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[^,]*\\((not on your network list|ranked lower|withheld[^)]*|not in both readings)\\)'), `${d.name} is explained`);
  }
});
