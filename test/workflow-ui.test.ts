import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPipeline } from '../src/agent/pipeline.ts';
import { FixtureQlooClient } from '../src/qloo/fixture-client.ts';
import { createQlooClient } from '../src/qloo/client.ts';
import { EXAMPLE_ROUTES, SYNTHETIC_CATALOGUE } from '../src/examples.ts';
import type { SlateResult } from '../src/agent/types.ts';
import { FakeLlm, act } from './helpers/fake-llm.ts';
import { bootApp, json } from './fake-dom.ts';

const ex = EXAMPLE_ROUTES[0]!;
const base = { ...ex.request, catalogue: SYNTHETIC_CATALOGUE, autoConfirm: true, swap: false, compare: false };
async function open(r: SlateResult) {
  const a = await bootApp({
    '/api/config': () => json({ mode: 'synthetic', callBudget: 70, llm: null, sampleCatalogue: SYNTHETIC_CATALOGUE, examples: [{ id: ex.id, title: ex.title, blurb: ex.blurb, request: ex.request }] }),
    '/api/example/*': () => json({ provenance: 'stored-recording', result: r }),
  });
  a.$('examples').querySelectorAll('button')[0]!.click();
  await a.settle();
  return a;
}
test('UI: a scripted run is labelled "scripted workflow (no LLM)", says it is not an agent, and the trace never says Agent', async () => {
  const r = (await runPipeline(base, { qloo: new FixtureQlooClient(), llm: null, emit: () => {} }))!;
  const a = await open(r);
  assert.match(a.text('qloo-status-text'), /scripted workflow \(no LLM\)/);
  assert.match(a.text('planner-box'), /scripted workflow \(no LLM\)/); assert.match(a.text('planner-box'), /not an agent/);
  assert.ok(!/\bAgent\b/.test(a.text('trace')) && !/Agent trace|Agent running/.test(a.text('results')));
});
test('UI: a planner run shows each LLM step with its reason and the Qloo result summary', async () => {
  const llm = new FakeLlm((c) => {
    if (c.step === 1) return act('read_location', { end: 'origin', domain: 'artist' }, 'home artists first');
    if (c.step === 2) return act('read_location', { end: 'destination', domain: 'artist' }, 'then the destination');
    const ids = (n: number) => [...c.data.history.find((h) => h.n === n)!.result.matchAll(/(?:^|[:;] )([A-Za-z0-9:_-]+) \| /g)].map((m) => m[1]!).slice(0, 3);
    return act('finish', { anchors: { origin: { artist: ids(1) }, destination: { artist: ids(2) } } }, 'distinct locals');
  });
  const r = (await runPipeline(base, { qloo: createQlooClient({}, { budget: 200 }).client, llm, planner: { enabled: true }, emit: () => {} }))!;
  const a = await open(r);
  const t = a.text('planner-box');
  assert.match(t, /LLM planner/); assert.match(t, /home artists first/); assert.match(t, /read_location/); assert.match(t, /Result: \d+ results/);
  assert.match(a.text('qloo-status-text'), /LLM planner/);
});
