import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from './helpers/tmp.ts';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { bracketPlaceholders, checkShots, checkText, formatReport, runCheck } from '../scripts/presubmit-check.ts';

const CLEAN = [
  '# Seatback',
  'Program a route, not a fleet. Airlines buy audience data ([Runway Girl Network, 2024](https://example.com/x)).',
  'Live result: 5 of 6 hometown titles ranked higher (p = 0.01).',
  '- [ ] a task box is fine',
].join('\n');

const rules = (text: string) => [...new Set(checkText(text, 't.md').map((f) => f.rule))].sort();

test('clean submission text passes (links, numbers and prose are not flagged)', () => {
  assert.deepEqual(checkText(CLEAN, 't.md'), []);
});

test('each failure mode is caught on its own', () => {
  assert.deepEqual(rules('>>> FILL AFTER LIVE RUN (links)'), ['fill-marker', 'open-marker']);
  assert.ok(rules('FILL AFTER LIVE RUN').includes('fill-marker'));
  assert.deepEqual(rules('<<< END FILL'), ['close-marker', 'end-fill']);
  assert.deepEqual(rules('END FILL'), ['end-fill']);
  assert.deepEqual(rules('some text >>> more'), ['open-marker']);
  assert.deepEqual(rules('some text <<< more'), ['close-marker']);
  assert.deepEqual(rules('demo [Worker URL] and repo'), ['placeholder']);
  assert.deepEqual(rules('(synthetic)'), ['synthetic']);
  assert.deepEqual(rules('Minneapolis (Synthetic) to Orlando'), ['synthetic']);
  assert.deepEqual(rules('TODO tidy this'), ['todo']);
});

test('the old grep would have printed 0 for these; the new check does not', () => {
  const leaky = ['- WARMED LIVE: stored runs were recorded live.', '- NOT WARMED: replay of fixtures.'].join('\n');
  assert.deepEqual(rules(leaky), ['variant']);
  assert.equal(checkText(leaky, 't.md').length, 2, 'both unchosen variants are listed');
  for (const line of [
    '- PASS version (the direction check passed): Live result: [k of n] titles',
    '- FAIL version (it did not pass): only [k of n]',
    '- PASS (direction check passed): Program a route',
    '- FAIL (it did not pass): Program a route',
    'keep exactly one of these',
  ]) assert.ok(rules(line).includes('variant'), line);
  assert.equal((leaky.match(/FILL AFTER LIVE RUN/g) ?? []).length, 0, 'the old grep count is 0 and misses them');
});

test('unfilled bracket placeholders are found one by one; links, task boxes and footnote numbers are not', () => {
  assert.deepEqual(bracketPlaceholders('tau [x] over [n] cities, [k of n] titles, p = [p]'), ['[x]', '[n]', '[k of n]', '[p]']);
  assert.deepEqual(bracketPlaceholders('[optional: delete if none]'), ['[optional: delete if none]']);
  assert.deepEqual(bracketPlaceholders('[a link](http://x.y) and [ ] and [12] and [ref]: note'), []);
});

test('a key-looking string is flagged without printing it', () => {
  const key = 'QLOO_API_KEY=abcdefghijklmnop1234';
  const f = checkText(`config ${key}`, 't.md');
  assert.deepEqual(f.map((x) => x.rule), ['secret']);
  assert.ok(!JSON.stringify(f).includes('abcdefghijklmnop1234'));
  assert.ok(!formatReport(f, ['t.md']).includes('abcdefghijklmnop1234'));
});

test('findings carry file and line, and the report lists everything that is left', () => {
  const text = ['ok line', '>>> FILL AFTER LIVE RUN (links)', '**Links:** demo [Worker URL]', '<<< END FILL'].join('\n');
  const f = checkText(text, 'final.md');
  assert.ok(f.some((x) => x.where === 'final.md:2' && x.rule === 'fill-marker'));
  assert.ok(f.some((x) => x.where === 'final.md:3' && x.rule === 'placeholder'));
  const report = formatReport(f, ['final.md']);
  assert.match(report, /presubmit FAILED: \d+ thing\(s\) left/);
  for (const rule of ['fill-marker', 'open-marker', 'placeholder', 'end-fill', 'close-marker']) assert.match(report, new RegExp(`^${rule} \\(\\d+\\)$`, 'm'));
  assert.match(report, /final\.md:3 {2}unfilled placeholder \[Worker URL\]/);
});

function dir(): string {
  return mkdtempSync(join(tmpdir(), 'seatback-presubmit-'));
}

test('screenshot folder: missing, empty, and synthetic-named folders and files all fail', () => {
  const d = dir();
  assert.deepEqual(checkShots(join(d, 'nope')).map((f) => f.rule), ['shots-missing']);
  assert.deepEqual(checkShots(d).map((f) => f.rule), ['shots-empty']);
  const s = join(d, 'screenshots-SYNTHETIC');
  mkdirSync(s);
  writeFileSync(join(s, '1366-slate.png'), 'x');
  assert.ok(checkShots(s).some((f) => f.rule === 'synthetic' && /folder name/.test(f.detail)));
  const live = join(d, 'live');
  mkdirSync(live);
  writeFileSync(join(live, 'SYNTHETIC-desktop-slate.png'), 'x');
  writeFileSync(join(live, 'ok.png'), 'x');
  assert.ok(checkShots(live).some((f) => f.rule === 'synthetic' && /SYNTHETIC-desktop-slate/.test(f.where)));
  mkdirSync(join(live, 'synthetic-old'));
  assert.ok(checkShots(live).some((f) => /synthetic-old/.test(f.where)));
});

test('screenshot folder: a text file inside that says (synthetic) fails; a clean folder passes', () => {
  const live = dir();
  writeFileSync(join(live, 'desktop-slate.png'), 'x');
  writeFileSync(join(live, 'README.txt'), 'taken from the live deploy');
  assert.deepEqual(checkShots(live), []);
  writeFileSync(join(live, 'README.txt'), 'These are (synthetic) images');
  assert.deepEqual(checkShots(live).map((f) => f.rule), ['synthetic']);
});

test('runCheck: exit 1 with a list when anything is left, 0 and "presubmit OK" when clean', () => {
  const d = dir();
  const shots = join(d, 'shots');
  mkdirSync(shots);
  writeFileSync(join(shots, 'a.png'), 'x');
  const f = join(d, 'final.md');
  const out: string[] = [];
  writeFileSync(f, `${CLEAN}\nTODO\n`);
  assert.equal(runCheck(f, [shots], (s) => out.push(s)), 1);
  assert.match(out.join('\n'), /^todo \(1\)$/m);
  writeFileSync(f, CLEAN);
  out.length = 0;
  assert.equal(runCheck(f, [shots], (s) => out.push(s)), 0);
  assert.match(out.join('\n'), /^presubmit OK/);
  assert.equal(runCheck(join(d, 'missing.md'), [shots], () => {}), 1, 'a missing text file fails');
  writeFileSync(f, '  \n');
  assert.equal(runCheck(f, [shots], () => {}), 1, 'an empty text file fails');
});

test('the command line (npm run presubmit) exits non-zero on a dirty file and zero on a clean one', () => {
  const d = dir();
  const shots = join(d, 'shots');
  mkdirSync(shots);
  writeFileSync(join(shots, 'a.png'), 'x');
  const f = join(d, 'final.md');
  const script = new URL('../scripts/presubmit-check.ts', import.meta.url).pathname;
  writeFileSync(f, '>>> FILL AFTER LIVE RUN\n');
  const bad = spawnSync(process.execPath, [script, f, '--shots', shots], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /presubmit FAILED/);
  writeFileSync(f, CLEAN);
  const good = spawnSync(process.execPath, [script, f, '--shots', shots], { encoding: 'utf8' });
  assert.equal(good.status, 0, good.stdout);
  assert.match(good.stdout, /presubmit OK/);
});

test('package.json wires "npm run presubmit" to the script', async () => {
  const { readFileSync } = await import('node:fs');
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts.presubmit, 'node scripts/presubmit-check.ts');
});

const INTERNAL_KIT = new URL('../../seatback-internal/SUBMISSION-KIT.md', import.meta.url);
// Reported as SKIPPED (not passed) when the internal folder is absent, as it is in the published repository.
test('the runbook in the internal kit points at presubmit and no longer relies on grep -c', { skip: !existsSync(INTERNAL_KIT) && 'internal kit not present in this tree' }, async () => {
  const f = INTERNAL_KIT;
  const kit = readFileSync(f, 'utf8');
  assert.match(kit, /npm run presubmit/);
  assert.ok(!/must print `0`/.test(kit));
  assert.ok(!/grep -c "FILL AFTER LIVE RUN" <your/.test(kit));
});
