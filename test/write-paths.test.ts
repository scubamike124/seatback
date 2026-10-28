// Lint: nothing in this project may write outside the project root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, relative } from 'node:path';
import { assertWritable, isInside, PROJECT_ROOT } from '../scripts/safe-path.ts';
import { tmpdir } from './helpers/tmp.ts';

const ROOT = new URL('../', import.meta.url).pathname;
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : /\.(ts|mjs|js|sh)$/.test(e.name) ? [join(dir, e.name)] : []));
}
const all = ['scripts', 'src', 'test', 'deploy'].flatMap((d) => files(join(ROOT, d)));
const WRITE = /\b(?:writeFileSync|appendFileSync|mkdirSync|mkdtempSync|createWriteStream|copyFileSync|renameSync|rmSync|writeFile|mkdir)\(\s*(['"`])(\/[^'"`]*)\1/;

test('no write call uses an absolute path literal', () => {
  const bad = all.filter((f) => !f.endsWith('write-paths.test.ts')).filter((f) => WRITE.test(readFileSync(f, 'utf8'))).map((f) => relative(ROOT, f));
  assert.deepEqual(bad, []);
});
test('no file uses os.tmpdir() or hard-codes /tmp: tests use test/helpers/tmp.ts (inside the project)', () => {
  const bad = all.filter((f) => !f.endsWith('write-paths.test.ts')).filter((f) => /node:os'/.test(readFileSync(f, 'utf8')) && /\btmpdir\b/.test(readFileSync(f, 'utf8')) || /['"`]\/tmp\//.test(readFileSync(f, 'utf8')) || /process\.env\.TMPDIR/.test(readFileSync(f, 'utf8'))).map((f) => relative(ROOT, f));
  assert.deepEqual(bad, []);
  assert.ok(isInside(tmpdir(), PROJECT_ROOT));
});
test('assertWritable allows the project and SEATBACK_SCRATCH only', () => {
  assert.doesNotThrow(() => assertWritable(join(ROOT, 'eval-output/x.md'), {}));
  assert.throws(() => assertWritable('/x.md', {}), /outside the project/);
  assert.throws(() => assertWritable(join(ROOT, '../escape.md'), {}), /outside the project/);
  assert.throws(() => assertWritable('/etc/passwd', { SEATBACK_SCRATCH: '/scratch' }));
  assert.doesNotThrow(() => assertWritable('/scratch/a/b.md', { SEATBACK_SCRATCH: '/scratch' }));
});
test('request-to-result refuses an --out path outside the project and writes nothing', () => {
  const out = '/qloo-write-guard-probe/x.md';
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts/request-to-result.ts'), '--out', out], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(r.status, 1); assert.match(r.stderr, /Refusing to write outside/);
  assert.ok(!existsSync(out) && !existsSync('/qloo-write-guard-probe'));
});
