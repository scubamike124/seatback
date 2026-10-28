// Live-LLM smoke test of the planner loop against MOCK Qloo data. Skipped unless GEMINI_API_KEY is set AND
// PLANNER_LIVE=1. It spends a handful of free-tier Gemini requests, never prints the key or the model text.
// It checks only that a real model's replies survive the loop's guards (terminal status, every call validated
// or rejected, nothing crashes). It says nothing about plan QUALITY.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GeminiProvider } from '../src/llm/provider.ts';
import { runPipeline } from '../src/agent/pipeline.ts';
import { createQlooClient } from '../src/qloo/client.ts';
import { SYNTHETIC_CATALOGUE } from '../src/examples.ts';

const key = process.env.GEMINI_API_KEY;
const on = !!key && process.env.PLANNER_LIVE === '1';
const reason = !key ? 'no GEMINI_API_KEY in the environment' : 'PLANNER_LIVE=1 not set (explicit opt-in)';
if (!on) console.log(`# LIVE-LLM planner smoke test SKIPPED: ${reason}`);

test('live LLM planner smoke (mock Qloo data)', { skip: on ? false : `skipped: ${reason}` }, async () => {
  const llm = new GeminiProvider(key!, process.env.GEMINI_MODEL);
  const h = createQlooClient({}, { budget: 200 });
  let r;
  try {
    r = await runPipeline({ origin: 'Minneapolis', destination: 'Orlando', catalogue: SYNTHETIC_CATALOGUE, autoConfirm: true, swap: false, compare: false }, { qloo: h.client, llm, planner: { enabled: true, maxSteps: 8 }, emit: () => {} });
  } catch (e) {
    assert.match((e as Error).message, /abstained/); // an honest abstention is an acceptable outcome
    return;
  }
  assert.ok(r);
  assert.ok(['llm-planner', 'planner-fallback'].includes(r.workflow!.kind));
  assert.ok(r.plannerDecisions!.length >= 1 && r.plannerDecisions!.length <= 8);
  console.log(`# live planner: ${r.workflow!.label}; steps ${r.plannerDecisions!.length}; statuses ${r.plannerDecisions!.map((d) => d.status).join(',')}`);
});
