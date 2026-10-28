// Guard: fails if anything that looks like Qloo response data, a live artifact or a key is present
// in the project tree. The Qloo developer guide says: "Do not store Qloo response data in a public repository".
// This test checks shape and names. It cannot prove that a file is not Qloo data; it catches the usual leaks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from './helpers/tmp.ts';
import { join, relative } from 'node:path';

const ROOT = new URL('../', import.meta.url).pathname;
const ALLOWED_JSON = new Set(['package.json', 'package-lock.json', 'tsconfig.json']);
// Authored pre-registration files (no Qloo data): allowed by exact relative path, nothing else.
const ALLOWED_JSON_PATHS = new Set(['railway.json', 'docs/test-counts.json', 'prereg/validity-prereg.template.json', 'prereg/validity-prereg.json', 'prereg/validity-prereg.CANDIDATE-UNSEALED.json', 'test/fixtures/validity-prereg.synthetic.json']);
const SKIP_DIRS = new Set(['node_modules', '.git', '.wrangler', 'dist', '.tmp-test']);
const TEXT_EXT = /\.(ts|js|mjs|md|json|toml|txt|csv|ndjson|example|sh|html|yml|yaml)$/i;
const LIVE_NAMES = [/^\.private$/, /^eval-output$/, /\.live\.json$/i, /^probe-.*\.json$/i, /^eval-live/i, /^screenshots-live$/i, /\.ndjson$/i, /^\.dev\.vars$/, /^\.env$/];
// Real Qloo entity ids look like 32 hex characters or a UUID. Synthetic ids here start with "SYN-".
// The SYN- prefix marks an invented id (a UUID after SYN- is allowed).
const REAL_ID = [/\b[0-9A-Fa-f]{32}\b/, /(?<!SYN-)\b[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\b/];
// A value counts only if it looks like a key (12 or more key characters, the same rule as scripts/predeploy-check.sh)
// and is not one of the two fake values the tests feed to the scripts on purpose.
const KEY_ASSIGN = /\bQLOO_API_KEY[ \t]*=[ \t]*["']?(?!abcdefghijklmnop1234|FAKE-KEY-)[A-Za-z0-9_-]{12,}/;
const REQUIRED_IGNORES = ['.dev.vars', '.private/', 'eval-output/', '*.live.json'];

// eval-output/ may hold MOCK-labelled screenshots (gitignored); anything else in it is a live artifact.
function onlyMockShots(dir: string): boolean {
  return readdirSync(dir).every((n) => /^MOCK-[\w.-]+\.png$/.test(n));
}

export function scan(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (SKIP_DIRS.has(name)) continue;
      const p = join(dir, name);
      const rel = relative(root, p);
      if (name === 'eval-output' && statSync(p).isDirectory() && onlyMockShots(p)) continue;
      if (LIVE_NAMES.some((re) => re.test(name))) out.push(`live-artifact: ${rel}`);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (name.endsWith('.json') && !ALLOWED_JSON.has(name) && !ALLOWED_JSON_PATHS.has(rel)) out.push(`unexpected-json: ${rel}`);
      if (rel === join('test', 'public-safety.test.ts')) continue;
      if (!TEXT_EXT.test(name) && name !== '.gitignore') continue;
      const text = readFileSync(p, 'utf8');
      for (const re of REAL_ID) if (re.test(text)) out.push(`real-looking-id: ${rel}`);
      const m = KEY_ASSIGN.exec(text);
      if (m) out.push(`key-assignment: ${rel} (${m[0].replace(/=.*/, '=<value hidden>')})`);
    }
  };
  walk(root);
  return [...new Set(out)];
}

test('project tree has no Qloo-looking response data, live artifacts or key assignments', () => {
  assert.deepEqual(scan(ROOT), []);
});

test('.gitignore keeps live output, caches and secrets out of git', () => {
  const lines = readFileSync(join(ROOT, '.gitignore'), 'utf8').split('\n').map((l) => l.trim());
  for (const need of REQUIRED_IGNORES) assert.ok(lines.includes(need), `.gitignore must list ${need}`);
});

test('every fixture entity id is synthetic (SYN-) and the fixture client says so', () => {
  const src = readFileSync(join(ROOT, 'src/qloo/fixture-client.ts'), 'utf8');
  assert.match(src, /SYNTHETIC fixture client\. Nothing here is a Qloo response/);
  const ids = [...src.matchAll(/entity_id:\s*[`'"]([^`'"$]+)/g)].map((m) => m[1] ?? "");
  assert.ok(ids.length > 0);
  for (const id of ids) assert.ok(id.startsWith('SYN-'), `fixture id ${id} must start with SYN-`);
});

test('the scanner itself catches planted violations (self-test)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'public-safety-'));
  try {
    assert.deepEqual(scan(dir), [], 'an empty tree is clean');
    mkdirSync(join(dir, '.private'));
    writeFileSync(join(dir, 'sample.json'), '{"results":{"entities":[{"entity_id":"A1B2C3D4E5F60718293A4B5C6D7E8F90"}]}}');
    writeFileSync(join(dir, 'notes.md'), 'id 3F2504E0-4F89-41D3-9A0C-0305E82C3301');
    writeFileSync(join(dir, 'x.example'), 'QLOO_API_KEY=notarealvalue');
    writeFileSync(join(dir, 'eval-live-1.log'), 'x');
    const found = scan(dir).join('\n');
    for (const want of ['live-artifact: .private', 'unexpected-json: sample.json', 'real-looking-id: sample.json', 'real-looking-id: notes.md', 'key-assignment: x.example', 'live-artifact: eval-live-1.log']) {
      assert.ok(found.includes(want), `scanner missed: ${want}\n${found}`);
    }
    assert.ok(!found.includes('notarealvalue'), 'key value must not be echoed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
