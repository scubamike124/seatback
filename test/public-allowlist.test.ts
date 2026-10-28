// The public-file allowlist: what may be published, and the dry-run that refuses anything else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALLOW, inventoryMarkdown, problems, scanPublic, stagePrivate } from '../scripts/public-allowlist.ts';
import { tmpdir } from './helpers/tmp.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const put = (d: string, rel: string, text: string) => { mkdirSync(dirname(join(d, rel)), { recursive: true }); writeFileSync(join(d, rel), text); };

test('the real tree: nothing unlisted, no scratch paths, no placeholder other than the three owner-only ones', () => {
  const r = scanPublic(root);
  assert.deepEqual(problems(r), []);
  assert.deepEqual([...new Set(r.ownerOnly.map((o) => o.id))].sort(), ['hosted demo URL (README)', 'licence holder (LICENSE)', 'repo creation date (README)']);
  for (const must of ['README.md', 'LICENSE', 'package.json', 'src/worker.ts', 'wrangler.toml']) assert.ok(r.files.some((f) => f.path === must), must);
});
test('excluded items are never on the list: internal log, pilot plan, unsealed candidate, licence candidates, output and temp folders', () => {
  for (const p of ['BUILD-LOG.md', 'docs/PILOT-PLAN.md', 'prereg/validity-prereg.CANDIDATE-UNSEALED.json', 'docs/LICENSE-CANDIDATES/NOTICE-CANDIDATE', 'eval-output/x.png', '.tmp-test/a.ts', '.private/x.json', '.dev.vars', 'docs/OWNER-RAILWAY-5-STEPS.md', '../INDEPENDENT-REVIEW-1.md', 'research/kit/README.md'])
    assert.ok(!ALLOW.some((a) => a.re.test(p)), p);
});
test('dry run catches an unlisted file, a scratch path, a stray placeholder, and tolerates the three owner-only ones', () => {
  const d = mkdtempSync(join(tmpdir(), 'allow-'));
  try {
    put(d, 'README.md', 'Demo [OWNER: the hosted demo URL goes here]. Created [OWNER TO FILL IN before publishing: the date x]. [LIVE-GATED] pending.');
    put(d, 'LICENSE', 'Copyright [LICENSE HOLDER: OWNER MUST REPLACE]');
    put(d, 'notes.txt', 'private'); put(d, 'BUILD-LOG.md', 'internal');
    put(d, 'src/a.ts', '// see /tm' + 'p/claude-0/-x/y');
    put(d, 'docs/FIXTURES.md', 'PASTE_ID_' + 'HERE');
    const r = scanPublic(d);
    assert.deepEqual(r.unlisted.map((u) => u.path), ['notes.txt']);
    assert.deepEqual(r.keptOut.map((u) => u.path), ['BUILD-LOG.md']);
    assert.deepEqual(r.scratch, ['src/a.ts:1']);
    assert.equal(r.ownerOnly.length, 3);
    const p = problems(r).join('\n');
    assert.match(p, /NOT ON LIST: notes\.txt/); assert.match(p, /SCRATCH PATH: src\/a\.ts:1/); assert.match(p, /PLACEHOLDER: README\.md:1.*LIVE-GATED/); assert.match(p, /PLACEHOLDER: docs\/FIXTURES\.md/);
    assert.ok(!/LICENSE HOLDER|hosted demo URL|the date x/.test(p.replace(/PLACEHOLDER: README\.md:1.*/, '')), 'owner-only placeholders are not problems');
    assert.match(problems(r, true).join('\n'), /NOT ON LIST: BUILD-LOG\.md/, '--strict also fails on excluded files');
    assert.match(inventoryMarkdown(r), /\| `README\.md` \| \d+ \| `[0-9a-f]{16}\.\.\.` \|/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
test('the allowlist script never creates a repo or uses the network', () => {
  const src = readFileSync(join(root, 'scripts/public-allowlist.ts'), 'utf8');
  assert.ok(!/\bgit (init|push|remote)\b|fetch\(|https?:\/\/[a-z]/i.test(src.replace(/^\/\/.*$/gm, '')));
});

test('the owner checklist is private-only: kept out of the public list, copied into the private demo source, and contains the token recipe but no secret', { skip: !existsSync(join(root, 'docs/OWNER-RAILWAY-5-STEPS.md')) && 'private-only file is absent in a public clone' }, () => {
  const r = scanPublic(root);
  assert.ok(r.keptOut.some((k) => k.path === 'docs/OWNER-RAILWAY-5-STEPS.md')); assert.ok(!r.files.some((f) => f.path === 'docs/OWNER-RAILWAY-5-STEPS.md'));
  const d = mkdtempSync(join(tmpdir(), 'priv-'));
  try {
    const dest = join(d, 'out');
    const n = stagePrivate(root, dest);
    assert.equal(n.length, r.files.length);
    assert.ok(readFileSync(join(dest, 'docs/OWNER-RAILWAY-5-STEPS.md'), 'utf8').includes('openssl rand -hex 16'));
    assert.ok(readFileSync(join(dest, 'RAILWAY-README.txt'), 'utf8').includes('DEMO_ACCESS_TOKEN'));
    assert.throws(() => stagePrivate(root, dest), /non-empty/, 'never stages into a folder that already has files');
    assert.ok(!readdirSync(dest).includes('.dev.vars'));
  } finally { rmSync(d, { recursive: true, force: true }); }
  const doc = readFileSync(join(root, 'docs/OWNER-RAILWAY-5-STEPS.md'), 'utf8');
  assert.match(doc, /Do not use the amberai repository/); assert.match(doc, /\/healthz/); assert.match(doc, /LIVE_ENABLED. = .0./);
});
