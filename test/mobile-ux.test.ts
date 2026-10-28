// Review 8: phone UX (answer scrolled into view, build form collapsed), plain "what you are looking at" text,
// jargon moved into "How it works", honest-limits and Qloo-evidence sections that stay conditional on the data mode.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPipeline } from '../src/agent/pipeline.ts';
import { FixtureQlooClient } from '../src/qloo/fixture-client.ts';
import { EXAMPLE_ROUTES, SYNTHETIC_CATALOGUE } from '../src/examples.ts';
import type { SlateResult } from '../src/agent/types.ts';
import { bootApp, json, scrollLog } from './fake-dom.ts';

const ex = EXAMPLE_ROUTES[0]!;
let cached: SlateResult | null = null;
const result = async () => (cached ??= (await runPipeline({ ...ex.request, catalogue: SYNTHETIC_CATALOGUE, autoConfirm: true }, { qloo: new FixtureQlooClient(), llm: null, emit: () => {} }))!);
async function open(r: SlateResult, small: boolean) {
  const a = await bootApp({
    '/api/config': () => json({ mode: 'synthetic', llm: null, sampleCatalogue: SYNTHETIC_CATALOGUE, examples: EXAMPLE_ROUTES.map(({ id, title, blurb, request }) => ({ id, title, blurb, request })) }),
    '/api/example/*': () => json({ provenance: 'computed-synthetic', result: r }),
  }, { small });
  scrollLog.length = 0;
  a.$('build').open = true; // the visitor had the form open
  a.$('examples').querySelectorAll('button')[0]!.click();
  await a.settle();
  return a;
}

test('phone: after an example click the build form is collapsed and the Answer card is scrolled into view', async () => {
  const a = await open(await result(), true);
  assert.equal(a.$('build').open, false);
  assert.equal(scrollLog.at(-1), 'answer', `last scroll target: ${scrollLog.join(',')}`);
});
test('desktop: the build form is left as the visitor had it', async () => {
  const a = await open(await result(), false);
  assert.equal(a.$('build').open, true);
});
test('the answer starts with a plain three-sentence explanation and states that synthetic data is not Qloo', async () => {
  const a = await open(await result(), true);
  const t = a.$('looking').textContent;
  assert.match(t, /^What you are looking at: /);
  assert.equal((t.match(/\./g) ?? []).length, 3, t);
  assert.match(t, /invented.*not what Qloo says/);
  assert.ok(!/anchor|swap/i.test(t), 'no jargon in the plain text');
});
test('jargon (anchors, swap test) lives inside "How it works"; honesty labels stay visible', async () => {
  const a = await open(await result(), false);
  const how = a.$('how-it-works');
  assert.match(how.textContent, /anchors/); assert.match(how.textContent, /Swap test/);
  assert.ok(how.querySelector('#swap-test'), 'the swap test is inside the expandable section');
  assert.equal(how.open, false, 'collapsed by default');
  assert.match(a.$('answer').textContent, /Synthetic example: invented titles and generated scores, not Qloo results/);
});
test('"Honest limits" and "Qloo evidence" sections: synthetic says no Qloo data; a live-labelled result is conditional on its call count', async () => {
  const r = await result();
  let a = await open(r, false);
  assert.match(a.$('honest-limits').textContent, /not viewing forecasts/); assert.match(a.$('honest-limits').textContent, /synthetic fixtures/);
  assert.match(a.$('qloo-evidence').textContent, /no call reached Qloo, so nothing here is Qloo data/);
  const live = { ...r, source: 'qloo-live' as const, generatedAt: '2026-10-26T10:00:00Z' };
  a = await open(live as SlateResult, false);
  assert.match(a.$('qloo-evidence').textContent, new RegExp(`${r.metrics.qlooCalls} .* to Qloo`)); assert.ok(!/no call reached Qloo/.test(a.$('qloo-evidence').textContent));
  assert.match(a.$('looking').textContent, /come from Qloo taste data.*2026-10-26.*not been tested/);
});
test('status bar (synthetic): one number source, the same as the results header, and never "Qloo calls" next to "fixture calls"', async () => {
  const r = await result();
  const a = await open({ ...r, qlooStatus: { mode: 'MOCK', line: 'Qloo calls: 98/130 (94 served from cache) [MOCK]' } } as unknown as SlateResult, false);
  const t = a.text('qloo-status-text');
  assert.ok(!/98|130|Qloo calls/.test(t), t);
  assert.match(t, new RegExp(`Synthetic fixture calls: ${r.metrics.qlooCalls} \\(not Qloo`));
  assert.match(a.text('pass'), new RegExp(`${r.metrics.qlooCalls} fixture calls`), 'the header shows the same figure');
});
test('status bar (live-labelled): an example drops the budget denominator and says examples run with a larger budget', async () => {
  const r = await result();
  const a = await open({ ...r, source: 'qloo-live', qlooStatus: { mode: 'LIVE', line: 'Qloo calls: 98/130 (3 served from cache) [LIVE]' } } as unknown as SlateResult, false);
  const t = a.text('qloo-status-text');
  assert.ok(!/98\/130/.test(t) && /98 \(3 served/.test(t) && /larger budget than custom runs/.test(t), t);
});
