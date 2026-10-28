// Contract harness. Same suite three ways: replayed recorded-shape fixtures through the real HTTP
// client, the synthetic fixture client, and (only with QLOO_API_KEY and CONTRACT_LIVE=1) the live host.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpQlooClient, resetQlooCooldown } from '../src/qloo/http-client.ts';
import { FixtureQlooClient } from '../src/qloo/fixture-client.ts';
import { createQlooClient, probeEndpoints } from '../src/qloo/client.ts';
import { contractCases, replayFetch } from './helpers/contract-suite.ts';

const FAKE = ['FAKE', 'KEY', 'contract', '0123456789'].join('-');

for (const c of contractCases) {
  test(`contract [replay via HttpQlooClient]: ${c.name}`, async () => {
    resetQlooCooldown();
    await c.run(new HttpQlooClient({ apiKey: FAKE, fetchImpl: replayFetch(), sleep: async () => {} }));
  });
  test(`contract [MOCK fixture client]: ${c.name}`, async () => {
    await c.run(new FixtureQlooClient({}));
  });
}

test('endpoint probe records which endpoints exist (replay: trending and demographics absent)', async () => {
  resetQlooCooldown();
  const client = new HttpQlooClient({ apiKey: FAKE, fetchImpl: replayFetch(['/v2/trending', 'demographics']), sleep: async () => {} });
  const p = await probeEndpoints(client);
  assert.equal(p['/search']?.status, 'available');
  assert.equal(p['/v2/insights']?.status, 'available');
  assert.equal(p['/v2/tags']?.status, 'available');
  assert.equal(p['/v2/trending']?.status, 'unavailable');
  assert.equal(p['/v2/insights?filter.type=urn:demographics']?.status, 'unavailable');
});

const liveKey = process.env.QLOO_API_KEY;
const liveOn = !!liveKey && process.env.CONTRACT_LIVE === '1';
const reason = !liveKey ? 'no QLOO_API_KEY in the environment' : 'CONTRACT_LIVE=1 not set (explicit opt-in so tests never spend live calls by accident)';
if (!liveOn) console.log(`# LIVE contract suite SKIPPED: ${reason}`);

for (const c of contractCases) {
  test(`contract [LIVE]: ${c.name}`, { skip: liveOn ? false : `skipped: ${reason}` }, async () => {
    const h = createQlooClient({ QLOO_API_KEY: liveKey }, { budget: 20 });
    assert.equal(h.mode, 'LIVE');
    await c.run(h.client);
  });
}
test('contract [LIVE]: endpoint probe (statuses only, nothing stored)', { skip: liveOn ? false : `skipped: ${reason}` }, async () => {
  const h = createQlooClient({ QLOO_API_KEY: liveKey }, { budget: 20 });
  const p = await probeEndpoints(h.client);
  for (const [k, v] of Object.entries(p)) console.log(`# probe ${k}: ${v.status}${v.kind ? ` (${v.kind})` : ''}`);
  assert.equal(p['/search']?.status, 'available');
});
