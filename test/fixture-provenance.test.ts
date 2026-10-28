// Provenance guard: the synthetic fixtures are hand-written and generated, never copied from Qloo responses (docs/FIXTURES.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FixtureQlooClient } from '../src/qloo/fixture-client.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const UUID = /\b[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\b/;
const HEX32 = /\b[0-9A-Fa-f]{32}\b/;

test('the fixture source holds no UUID or 32-hex id, no recorded response, and says it is not derived from Qloo', () => {
  const src = readFileSync(join(root, 'src/qloo/fixture-client.ts'), 'utf8');
  assert.ok(!UUID.test(src) && !HEX32.test(src));
  assert.ok(!/"results"\s*:\s*\{\s*"entities"/.test(src), 'no pasted JSON response');
  assert.match(src, /Nothing here is a Qloo response, and nothing was derived from one/);
  assert.match(src, /every ID starts with "SYN-"/);
});
test('test fixtures contain no Qloo-looking ids or response bodies', () => {
  const dir = join(root, 'test/fixtures');
  for (const n of readdirSync(dir)) { const t = readFileSync(join(dir, n), 'utf8'); assert.ok(!UUID.test(t) && !HEX32.test(t) && !/"entity_id"/.test(t), n); }
});
test('everything the fixture client returns is labelled: SYN- ids, "(synthetic)" names, source synthetic-fixture', async () => {
  const c = new FixtureQlooClient();
  const loc = await c.searchLocality('Orlando');
  const ins = await c.insights({ domain: 'movie', location: { query: 'Orlando' }, take: 8 });
  const art = await c.insights({ domain: 'artist', location: { query: 'Seattle' }, take: 8 });
  for (const r of [loc, ins, art]) {
    assert.equal(r.source, 'synthetic-fixture');
    for (const e of r.data as { entity_id: string; name?: string }[]) { assert.match(e.entity_id, /^SYN-/); if (e.name) assert.match(e.name, /\(synthetic\)$/); }
  }
});
test('the provenance document exists and names how the data is made', () => {
  const p = join(root, 'docs/FIXTURES.md');
  assert.ok(existsSync(p));
  const t = readFileSync(p, 'utf8');
  assert.match(t, /Nothing was copied from, or derived from, a Qloo response/); assert.match(t, /hash\(/);
});
