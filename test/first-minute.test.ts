// What a judge sees in the first minute, run through the real client script in the fake DOM:
// the question, one-click answers, the answer shown at once (not after an animated replay), the Qloo calls
// behind it taken from the run's own ledger, synthetic labelling, and readable error states.
// Nothing here needs live data. Layout and scrolling are checked in a real browser (tools/judge-walkthrough.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { runPipeline } from '../src/agent/pipeline.ts';
import { FixtureQlooClient } from '../src/qloo/fixture-client.ts';
import { EXAMPLE_ROUTES, SYNTHETIC_CATALOGUE } from '../src/examples.ts';
import type { SlateResult } from '../src/agent/types.ts';
import { APP_JS } from '../src/ui/app.ts';
import { PAGE_HTML } from '../src/ui/page.ts';
import { bootApp, json, type App } from './fake-dom.ts';
import { APP_CSS as APP_CSS_FOR_TESTS } from '../src/ui/styles.ts';

let cached: SlateResult | null = null;
async function result(): Promise<SlateResult> {
  cached ??= (await runPipeline({ ...EXAMPLE_ROUTES[0]!.request, catalogue: SYNTHETIC_CATALOGUE }, { qloo: new FixtureQlooClient(), llm: null, emit: () => {} }))!;
  return cached;
}
async function app(over: Record<string, () => Response | Promise<Response>> = {}) {
  const r = await result();
  const a = await bootApp({
    '/api/config': () => json({ mode: 'synthetic', llm: null, sampleCatalogue: SYNTHETIC_CATALOGUE, examples: EXAMPLE_ROUTES.map(({ id, title, blurb, request }) => ({ id, title, blurb, request })) }),
    '/api/example/*': () => json({ provenance: 'stored-recording', result: r }),
    '/api/slate': () => json({ error: 'unused' }, 400),
    ...over,
  });
  return { a, r };
}
const nextTasks = async () => { for (let i = 0; i < 4; i++) await new Promise((res) => setImmediate(res)); };
const selectedTab = (a: App) => a.doc.querySelectorAll('[role=tab]').find((t) => t.getAttribute('aria-selected') === 'true')?.getAttribute('data-tab');

test('first screen: the question, one answer button per example, and the data source stated', async () => {
  const { a } = await app();
  assert.match(PAGE_HTML, /The question it answers:/);
  assert.match(PAGE_HTML, /<p class="q-mobile"><b>The question:<\/b>/, 'phones see the question above the example buttons');
  const ctas = a.$('hero-examples').querySelectorAll('button');
  assert.equal(ctas.length, EXAMPLE_ROUTES.length);
  assert.deepEqual(ctas.map((b) => b.textContent), EXAMPLE_ROUTES.map((e) => `Answer for ${e.title}`));
  assert.match(a.text('hero-note'), /^SYNTHETIC SAMPLE DATA: the titles are invented/);
  assert.equal(a.$('synthetic-banner').hidden, false, 'the banner is shown in synthetic mode');
});

test('a hero button shows the answer at once on the Slate tab (no animated replay delay)', async () => {
  const { a } = await app();
  assert.doesNotMatch(APP_JS, /setTimeout\(next/, 'the 45 ms per step replay is gone');
  a.$('hero-examples').querySelectorAll('button')[0]!.click();
  await nextTasks(); // a few event-loop turns, far less than the old 45 ms x steps
  assert.equal(selectedTab(a), 'slate');
  assert.ok(a.$('answer'), 'the Answer card exists');
  assert.equal(a.$('tab-slate').hidden, false);
  assert.equal(a.$('tab-trace').hidden, true);
  assert.ok(a.$('trace').children.length > 5, 'the recorded trace is still there, one tab away');
});

test('example loading keeps the Slate tab, a live run still opens on the trace', async () => {
  const { a } = await app({ '/api/slate': () => new Response('{"type":"start","mode":"synthetic-fixture"}\n', { status: 200 }) });
  a.$('examples').querySelectorAll('button')[1]!.click();
  await nextTasks();
  assert.equal(selectedTab(a), 'slate');
  a.$('run').dispatch('click');
  a.$('form').dispatch('submit');
  await nextTasks();
  assert.equal(selectedTab(a), 'trace', 'a live run shows its steps while it runs');
});

test('"What fed this answer" is computed from the run ledger and says it is synthetic', async () => {
  const { a, r } = await app();
  a.$('examples').querySelectorAll('button')[0]!.click();
  await nextTasks();
  const box = a.$('answer').querySelector('.fedby')!;
  assert.ok(box, 'the strip exists inside the Answer card');
  assert.equal(box.open, false, 'collapsed by default so the picks stay on the first screen');
  const rows = r.usage.filter((u) => ['open-read', 'anchored', 'pinned'].includes(u.key));
  const total = rows.reduce((n, u) => n + u.calls, 0);
  assert.equal(box.querySelector('summary')!.textContent, `What fed this answer: ${rows.length} kinds of call, ${total} fixture calls (not Qloo)`);
  const items = box.querySelectorAll('li');
  assert.equal(items.length, rows.length);
  rows.forEach((u, i) => {
    assert.ok(items[i]!.textContent.startsWith(`${u.calls} fixture calls (not sent to Qloo): ${u.purpose}`), items[i]!.textContent);
    const chips = items[i]!.querySelectorAll('button');
    assert.deepEqual(chips.map((c) => c.textContent), u.evidence.slice(0, 2));
  });
  assert.match(box.textContent, /Synthetic run: nothing here came from Qloo/);
});

test('each domain says how many readings scored it, from the result data only', async () => {
  const { a, r } = await app();
  a.$('examples').querySelectorAll('button')[0]!.click();
  await nextTasks();
  const notes = a.$('answer').querySelectorAll('.dom-note').map((n) => n.textContent);
  const shown = r.domains.filter((d) => d.picks.length);
  assert.equal(notes.length, shown.filter((d) => d.scale === 'single-end' || d.readings >= 1 || d.picks.every((p) => p.side === 'single-end')).length);
  for (const n of notes) assert.match(n, /^(Scored in two independent readings per city; titles the readings disagree on are withheld\.|One reading only: no consistency check for this group\.|Only .+ could be read for this group, so each pick shows its rank in that city and no route fit\.)$/);
});

test('error states: a failed example shows a message, takes focus-ready markup and keeps no stale result', async () => {
  const { a } = await app({ '/api/example/*': () => json({ error: 'Example needs confirmation' }, 500) });
  a.$('examples').querySelectorAll('button')[0]!.click();
  await nextTasks();
  assert.equal(a.$('error').hidden, false);
  assert.equal(a.text('error'), 'Example needs confirmation');
  assert.equal(a.$('error').getAttribute('role'), 'alert');
  assert.equal(a.$('error').getAttribute('tabindex'), '-1', 'focusable so keyboard and screen-reader users land on it');
  assert.equal(a.$('tabs-wrap').hidden, true);
  assert.ok(!a.doc.getElementById('answer'), 'no answer card from a failed run');
  assert.equal(a.$('run').disabled, false, 'the button is usable again');
});

test('error states: an unreachable server gives a plain-language message', async () => {
  const { a } = await app({ '/api/example/*': () => { throw new Error('offline'); } });
  a.$('examples').querySelectorAll('button')[0]!.click();
  await nextTasks();
  assert.equal(a.text('error'), 'Could not reach the server. Check your connection and try again.');
  assert.equal(a.$('run').disabled, false);
});

test('error states: a config failure and a dropped stream are readable', async () => {
  const a1 = await bootApp({ '/api/config': () => { throw new Error('x'); } });
  assert.equal(a1.text('error'), 'Could not load the example list. Reload the page to try again.');
  const { a } = await app({ '/api/slate': () => { throw new Error('drop'); } });
  a.$('form').dispatch('submit');
  await nextTasks();
  assert.match(a.text('error'), /^Could not reach the server|^The connection dropped/);
});

test('the page works without JavaScript only as a clear notice, not a blank page', () => {
  assert.match(PAGE_HTML, /<noscript><div class="banner">Seatback needs JavaScript/);
});

test('the sourced context sits in a collapsible block and keeps all three sourced facts', () => {
  assert.match(PAGE_HTML, /<details class="context" id="why"><summary>Why this matters \(sourced\)/);
  assert.doesNotMatch(PAGE_HTML, /class="why"/, 'the name .why belongs to the per-pick "why" lists in the stylesheet');
  for (const f of ['$315M', '150+', '"Demand for data"']) assert.ok(PAGE_HTML.includes(f), f);
});

test('a synthetic run never says "Qloo calls": counts are labelled as fixture calls everywhere', async () => {
  const { a, r } = await app();
  a.$('examples').querySelectorAll('button')[0]!.click();
  await nextTasks();
  const label = `${r.metrics.qlooCalls} fixture calls (not Qloo)`;
  assert.ok(a.text('pass').includes(label), a.text('pass'));
  assert.ok(a.text('tab-evidence').includes('fixture calls (not Qloo)'));
  const visible = ['pass', 'tab-slate', 'tab-evidence'].map((id) => a.text(id)).join(' ');
  assert.ok(!/\d+ Qloo calls/.test(visible), 'no bare "N Qloo calls" in a synthetic run');
});

test('evidence rows say "1 result", not "1 results"', async () => {
  const { a } = await app();
  a.$('examples').querySelectorAll('button')[0]!.click();
  await nextTasks();
  const t = a.text('tab-evidence');
  assert.ok(!/\b1 results\b/.test(t));
  assert.match(t, /\b1 result(?!s)/);
});

test('synthetic mode never says Qloo answered: unknown place and local-anchor labels name the fixture', async () => {
  await assert.rejects(
    runPipeline({ origin: 'Atlantis', destination: 'Orlando', originShare: 0.5, catalogue: SYNTHETIC_CATALOGUE }, { qloo: new FixtureQlooClient(), llm: null, emit: () => {} }),
    /^Error: The synthetic fixture has no place matching "Atlantis"|The synthetic fixture has no place matching "Atlantis"/,
  );
  const { a } = await app();
  a.$('examples').querySelectorAll('button')[0]!.click();
  await nextTasks();
  const labels = a.$('pass').querySelectorAll('.anchors summary').map((s) => s.textContent);
  assert.deepEqual(labels, ['Local anchors (fixture, not Qloo)', 'Local anchors (fixture, not Qloo)']);
});

test('the "How Qloo is used" heading follows the data source (synthetic runs do not claim to have used Qloo)', async () => {
  const { a } = await app();
  a.$('examples').querySelectorAll('button')[0]!.click();
  await nextTasks();
  assert.equal(a.$('tab-qloo').querySelector('h3')!.textContent, 'What this run did in place of Qloo calls (synthetic fixture)');
});

// ---------- round 5: residual defects ----------
const liveConfig = () => json({ mode: 'live', llm: null, sampleCatalogue: SYNTHETIC_CATALOGUE, examples: EXAMPLE_ROUTES.map(({ id, title, blurb, request }) => ({ id, title, blurb, request })) });

test('tagline: beside the SYNTHETIC pill it says the data is synthetic; in live mode it keeps the Qloo wording', async () => {
  const { a } = await app();
  assert.match(a.text('mode-pill'), /SYNTHETIC/);
  assert.match(a.text('tag-long'), /SYNTHETIC data, not Qloo results/);
  assert.match(a.text('tag-short'), /SYNTHETIC data shown, not Qloo results/);
  assert.doesNotMatch(a.text('tag-long'), /grounded in Qloo taste data/);
  const live = await app({ '/api/config': liveConfig });
  assert.match(live.a.text('mode-pill'), /LIVE/);
  assert.equal(live.a.text('tag-long'), 'Route-aware in-flight entertainment programming, grounded in Qloo taste data');
  assert.doesNotMatch(live.a.text('tag-long') + live.a.text('tag-short'), /SYNTHETIC/);
});

test('the grounding line says on screen that it measures traceability, not correctness', async () => {
  const { a } = await app();
  a.$('examples').querySelectorAll('button')[0]!.click();
  await nextTasks();
  const t = a.text('tab-slate');
  assert.match(a.$('answer').querySelector('.grounding-line')!.textContent, /This measures traceability/, 'in the visible Answer card, not only inside the collapsed full slate');
  assert.match(t, /Grounding: \d+ of \d+ factual claims cite a recorded fixture call\. This measures traceability \(where a number came from\), not correctness: a traced number can still be wrong\./);
});

test('example buttons are shown once: the layout flips to "has-result" on the first run, and CSS hides the duplicate', async () => {
  const { a } = await app();
  const layout = a.doc.querySelector('.layout')!;
  assert.equal(layout.classList.contains('has-result'), false);
  a.$('hero-examples').querySelectorAll('button')[0]!.click();
  await nextTasks();
  assert.equal(layout.classList.contains('has-result'), true);
  assert.match(APP_CSS_FOR_TESTS, /@media \(min-width: 901px\) \{ \.layout:not\(\.has-result\) \.examples \{ display: none; \} \}/);
  assert.match(APP_CSS_FOR_TESTS, /@media \(max-width: 900px\) \{ \.hero-ctas, #hero-note \{ display: none; \} \}/);
});

test('synthetic marks are compact: titles in the Answer card carry a "synthetic" badge, not a long suffix, and the labels survive elsewhere', async () => {
  const { a, r } = await app();
  a.$('examples').querySelectorAll('button')[0]!.click();
  await nextTasks();
  const ans = a.$('answer');
  assert.doesNotMatch(ans.querySelectorAll('.ans-list').map((l) => l.textContent).join(' '), /\(synthetic\)/, 'the picks carry a badge, not the long suffix');
  assert.doesNotMatch(ans.querySelector('#answer-h')!.textContent, /\(synthetic\)/);
  assert.match(ans.textContent, /Swap test: .*\(synthetic\)/, 'other sentences that name invented places keep their full label');
  const items = ans.querySelectorAll('.ans-list li');
  assert.ok(items.length >= 6);
  for (const li of items) assert.equal(li.querySelectorAll('.ans-t .badge.syn').length, 1, li.textContent);
  assert.equal(ans.querySelectorAll('#answer-h .badge.syn').length, 1);
  assert.ok(a.text('tab-evidence').includes('(synthetic)'), 'the evidence tab keeps the full label on every entity');
  assert.ok(r.domains[0]!.picks[0]!.title.includes('(synthetic)'), 'the data itself is unchanged');
});

test('one-city domains show one clear rank per pick and one sentence saying why, with no "n/a" cells', async () => {
  const { a, r } = await app();
  a.$('examples').querySelectorAll('button')[0]!.click();
  await nextTasks();
  const single = r.domains.filter((d) => d.picks.length && d.picks.every((p) => p.side === 'single-end'));
  assert.ok(single.length >= 1, 'the synthetic example has one-city domains');
  const ans = a.$('answer');
  assert.doesNotMatch(ans.textContent, /n\/a/);
  const notes = ans.querySelectorAll('.one-note').map((n) => n.textContent);
  assert.equal(notes.length, single.length);
  for (const n of notes) assert.match(n, /^Only (Minneapolis|Orlando) could be read for this group, so each pick shows its rank in that city and no route fit\.$/);
  for (const li of ans.querySelectorAll('.ans-n.one')) {
    assert.equal(li.querySelectorAll('.n').length, 1);
    assert.match(li.textContent, /^#\d+\/\d+rank in (MSP|MCO)$/);
  }
});

test('on a phone the reveal lands on the Answer card (review 8 superseded the earlier tab-row landing) and collapses the build form', () => {
  assert.match(APP_JS, /var b = \$\('build'\); if \(b && b\.open\) b\.open = false;/);
  assert.match(APP_JS, /\(ans \|\| \(tw && !tw\.hidden \? tw : \$\('out'\)\)\)\.scrollIntoView/);
});

test('the sourced-context block no longer borrows the per-pick ".why" styles (inset and small text)', () => {
  assert.match(PAGE_HTML, /<details class="context" id="why">/);
  assert.match(APP_CSS_FOR_TESTS, /\.why \{ margin: 0; padding-left: 1rem;/, 'the per-pick list style still exists, for its own use');
});

test('the route header cards use the same compact badge, and the tab row has a scroll margin on phones', async () => {
  const { a } = await app();
  a.$('examples').querySelectorAll('button')[0]!.click();
  await nextTasks();
  const heads = a.$('pass').querySelectorAll('.end h3');
  assert.equal(heads.length, 2);
  for (const h of heads) { assert.doesNotMatch(h.textContent, /\(synthetic\)/); assert.equal(h.querySelectorAll('.badge.syn').length, 1); }
  assert.match(APP_CSS_FOR_TESTS, /#tabs-wrap \{ scroll-margin-top: \.75rem; \}/);
});
