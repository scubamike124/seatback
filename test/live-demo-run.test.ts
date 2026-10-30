import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CAP, PLAN, llmConfigured } from '../scripts/live-demo-run.ts';

test('the capped run: cap is 90, below the agreed 91 limit; the plan says no retries and no LLM', () => {
  assert.equal(CAP, 90);
  assert.ok(PLAN.some((l) => /retries off/.test(l)) && PLAN.some((l) => /no LLM/.test(l)));
});

test('an LLM key or provider in the environment counts as configured, so a live run would refuse', () => {
  assert.equal(llmConfigured({}), false);
  assert.equal(llmConfigured({ LLM_PROVIDER: 'none' }), false);
  for (const k of ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY']) assert.equal(llmConfigured({ [k]: 'x' }), true, k);
  assert.equal(llmConfigured({ LLM_PROVIDER: 'gemini' }), true);
});
