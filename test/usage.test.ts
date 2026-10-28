import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FixtureQlooClient } from '../src/qloo/fixture-client.ts';
import { runPipeline } from '../src/agent/pipeline.ts';
import { qlooUsage } from '../src/agent/usage.ts';
import { SYNTHETIC_CATALOGUE } from '../src/examples.ts';

const base = { origin: 'Minneapolis', destination: 'Orlando', originShare: 0.6, catalogue: SYNTHETIC_CATALOGUE, autoConfirm: true };

test('"How Qloo is used" accounts for every Qloo call in the ledger, and only those', async () => {
  const r = (await runPipeline({ ...base, theme: 'family' }, { qloo: new FixtureQlooClient(), llm: null, emit: () => {} }))!;
  const total = r.usage.reduce((s, u) => s + u.calls, 0);
  assert.equal(total, r.evidence.filter((e) => e.path !== 'error').length);
  const keys = r.usage.map((u) => u.key);
  for (const k of ['resolve-place', 'resolve-catalogue', 'open-read', 'anchored', 'taste', 'tag-search', 'tag-filtered', 'destinations', 'demographics', 'trending']) assert.ok(keys.includes(k), `missing ${k}`);
  assert.ok(!keys.includes('pinned'), 'pinned reads did not happen, so they are not claimed');
  for (const u of r.usage) assert.ok(u.evidence.every((id) => r.evidence.some((e) => e.id === id)));
});

test('usage never lists a kind with no calls', () => {
  assert.deepEqual(qlooUsage([]), []);
});
