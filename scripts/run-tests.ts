// Runs each test file on its own, one at a time. Set TEST_LOCK=/path/to/lockfile to also
// serialise with other jobs via flock (used on the build machine); otherwise no lock is needed.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { cleanProjectTmp } from './clean-tmp.ts';
import { saveCounts } from './check-doc-counts.ts';
const dir = new URL('../test/', import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith('.test.ts')).sort();
let failed = 0;
const sum = { tests: 0, pass: 0, skipped: 0 };
for (const f of files) {
  const file = new URL(f, dir).pathname;
  const lock = process.env.TEST_LOCK;
  const r = lock ? spawnSync('flock', [lock, process.execPath, '--test', file], { encoding: 'utf8', maxBuffer: 64 << 20 }) : spawnSync(process.execPath, ['--test', file], { encoding: 'utf8', maxBuffer: 64 << 20 });
  process.stdout.write(r.stdout ?? ''); process.stderr.write(r.stderr ?? '');
  for (const k of ['tests', 'pass', 'skipped'] as const) sum[k] += Number(new RegExp(`^# ${k} (\\d+)`, 'm').exec(r.stdout ?? '')?.[1] ?? 0);
  if (r.status !== 0) failed++;
}
cleanProjectTmp();
if (!failed) saveCounts({ files: files.length, ...sum, fail: 0 }); // counts are written only when no file failed, so fail is 0 here
console.log(failed ? `${failed} test file(s) failed` : `All ${files.length} test files passed`);
process.exit(failed ? 1 : 0);
