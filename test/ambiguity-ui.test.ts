import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPipeline } from '../src/agent/pipeline.ts';
import { FixtureQlooClient } from '../src/qloo/fixture-client.ts';
import { createQlooClient } from '../src/qloo/client.ts';
import { EXAMPLE_ROUTES, SYNTHETIC_CATALOGUE } from '../src/examples.ts';
import type { SlateResult, TraceEvent } from '../src/agent/types.ts';
import { bootApp, json } from './fake-dom.ts';

const base = { origin: 'Minneapolis', destination: 'Orlando', originShare: 0.6, catalogue: SYNTHETIC_CATALOGUE };
const ex = EXAMPLE_ROUTES[0]!;

test('ambiguous place: needs_confirmation carries candidates + confidence and NOTHING is chosen', async () => {
  const events: TraceEvent[] = [];
  const out = await runPipeline({ ...base, origin: 'Portland', autoConfirm: false }, { qloo: new FixtureQlooClient(), llm: null, emit: (e) => events.push(e) });
  assert.equal(out, null, 'run stops instead of forcing a match');
  const ask = events.find((e) => e.type === 'needs_confirmation');
  assert.ok(ask && ask.type === 'needs_confirmation');
  const it = ask.items[0]!;
  assert.ok(it.candidates.length >= 2);
  assert.equal(it.options?.length, it.candidates.length);
  assert.ok(it.options!.every((o) => typeof o.confidence === 'number' && o.confidence >= 0 && o.confidence <= 1));
  assert.ok(!events.some((e) => e.type === 'result'));
});

test('auto-confirmed ambiguous place is still surfaced in the result and in the step text', async () => {
  const r = (await runPipeline({ ...base, origin: 'Portland', autoConfirm: true }, { qloo: new FixtureQlooClient(), llm: null, emit: () => {} }))!;
  const a = r.ambiguities!.find((x) => x.kind === 'place' && x.query === 'Portland');
  assert.ok(a, 'ambiguity recorded'); assert.equal(a.how, 'auto-top-candidate'); assert.ok(a.candidates.length >= 2);
  assert.ok(r.trace.some((e) => e.type === 'step' && e.id === 'resolve-origin' && /not a confident match/.test(e.detail ?? '')));
});

test('a clear match is not flagged; a user-confirmed ambiguous place is recorded as confirmed', async () => {
  const r = (await runPipeline({ ...base, autoConfirm: false }, { qloo: new FixtureQlooClient(), llm: null, emit: () => {} }))!;
  assert.ok(!r.ambiguities!.some((x) => x.kind === 'place'));
  const c = (await runPipeline({ ...base, origin: 'Portland', confirmations: { Portland: 'Portland, Maine (synthetic)' } }, { qloo: new FixtureQlooClient(), llm: null, emit: () => {} }))!;
  assert.equal(c.ambiguities!.find((x) => x.query === 'Portland')?.how, 'user-confirmed');
});

class TwinTitles extends FixtureQlooClient {
  override async searchTitle(q: string, d: Parameters<FixtureQlooClient['searchTitle']>[1]) {
    const r = await super.searchTitle(q, d);
    const first = r.data[0];
    return first ? { ...r, data: [first, { ...first, entity_id: 'SYN-TWIN-1' }] } : r;
  }
}
test('ambiguous title: provisional pick is flagged with candidates and confidence, never silent', async () => {
  const r = (await runPipeline({ ...base, autoConfirm: true }, { qloo: new TwinTitles(), llm: null, emit: () => {} }))!;
  const t = r.ambiguities!.filter((x) => x.kind === 'title');
  assert.ok(t.length > 0);
  assert.ok(t.every((x) => x.how === 'provisional-top-candidate' && x.candidates.length >= 2 && x.picked));
  const flagged = r.domains.flatMap((d) => d.picks).filter((p) => /ambiguous|matched as/i.test(JSON.stringify(p)));
  assert.ok(flagged.length >= 0);
});

test('the result carries the mode and the visible call counter (MOCK), within budget', async () => {
  const h = createQlooClient({}, { budget: 200 });
  const r = (await runPipeline({ ...base, autoConfirm: true }, { qloo: h.client, llm: null, emit: () => {} }))!;
  assert.equal(r.qlooStatus?.mode, 'MOCK');
  assert.match(r.qlooStatus!.line, /^Qloo calls: \d+\/200 \(\d+ served from cache\) \[MOCK\]$/);
  assert.ok(r.qlooStatus!.used > 0 && r.qlooStatus!.used <= 200);
  console.log(`# measured mock full run: ${r.qlooStatus!.line}`);
});

async function boot(result: SlateResult, mode = 'synthetic') {
  return bootApp({
    '/api/config': () => json({ mode, callBudget: 70, llm: null, sampleCatalogue: SYNTHETIC_CATALOGUE, examples: EXAMPLE_ROUTES.map(({ id, title, blurb, request }) => ({ id, title, blurb, request })) }),
    '/api/example/*': () => json({ provenance: 'stored-recording', result }),
  });
}
test('UI: MOCK badge is on screen before any run, and the counter + ambiguities show after a run', async () => {
  const h = createQlooClient({}, { budget: 200 });
  const r = (await runPipeline({ ...ex.request, catalogue: SYNTHETIC_CATALOGUE, origin: 'Portland', autoConfirm: true }, { qloo: h.client, llm: null, emit: () => {} }))!;
  const a = await boot(r);
  assert.equal(a.text('qloo-badge'), 'MOCK'); assert.match(a.$('qloo-status').className, /mock/); assert.ok(!/LIVE/.test(a.text('qloo-status')));
  a.$('examples').querySelectorAll('button')[0]!.click();
  await a.settle();
  assert.match(a.text('qloo-status-text'), /Synthetic fixture calls: \d+ \(not Qloo/); assert.match(a.text('qloo-status-text'), /\[MOCK\]/);
  assert.equal(a.$('ambig').hidden, false);
  assert.match(a.text('ambig'), /Portland/); assert.match(a.text('ambig'), /0\.\d+/);
});
test('UI: a stored replay without a counter says it is a replay and keeps the recorded mode', async () => {
  const r = (await runPipeline({ ...ex.request, catalogue: SYNTHETIC_CATALOGUE }, { qloo: new FixtureQlooClient(), llm: null, emit: () => {} }))!;
  const a = await boot(r);
  a.$('examples').querySelectorAll('button')[0]!.click();
  await a.settle();
  assert.equal(a.text('qloo-badge'), 'MOCK'); assert.match(a.text('qloo-status-text'), /Stored replay recorded in MOCK mode/);
});
test('UI: confirmation prompt shows each candidate with its confidence', async () => {
  const a = await bootApp({
    '/api/config': () => json({ mode: 'synthetic', llm: null, sampleCatalogue: SYNTHETIC_CATALOGUE, examples: [] }),
    '/api/slate': () => new Response(JSON.stringify({ type: 'needs_confirmation', items: [{ typed: 'Portland', candidates: ['Portland, Maine', 'Portland, Oregon'], options: [{ name: 'Portland, Maine', confidence: 0.55 }, { name: 'Portland, Oregon', confidence: 0.55 }] }] }) + '\n', { status: 200 }),
  });
  a.$('origin').value = 'Portland'; a.$('destination').value = 'Orlando'; a.$('catalogue').value = SYNTHETIC_CATALOGUE;
  a.$('form').dispatch('submit');
  await a.settle();
  const t = a.text('confirm');
  assert.match(t, /match 0\.55/); assert.match(t, /Nothing is chosen for you/);
});
