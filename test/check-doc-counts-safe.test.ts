// check-doc-counts is OPT-IN: only a sentence tagged [current] is ever checked against the last run or rewritten. Every other count sentence is
// never written, and in the fixed list of submission-facing files an untagged one is an error. No date or wording heuristic is involved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkDocCounts, historyMask, isHistoryFile, type Counts } from '../scripts/check-doc-counts.ts';
import { tmpdir } from './helpers/tmp.ts';

const COUNTS: Counts = { fail: 0, files: 40, tests: 443, pass: 434, skipped: 9, mutations: 105, killed: 105, workspacePass: 434, workspaceSkipped: 9, publicPass: 430, publicSkipped: 13 };
const work = () => mkdtempSync(join(tmpdir(), 'cdc-'));
const write = (d: string, name: string, text: string) => { const p = join(d, name); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, text); return p; };
const run = (name: string, text: string, fix: boolean, strict: boolean) => { const f = write(work(), name, text); const r = checkDocCounts(f, COUNTS, fix, strict); return { r, unchanged: r.text === readFileSync(f, 'utf8'), kinds: r.findings.map((x) => x.kind ?? 'stale') }; };

// Every variant the reviewers found (plus the ISO ones): none may EVER be written, whatever the wording.
const VARIANTS = ['2026-10-26', '2026/10/26', '10/26/2026', '26 Oct 2026', 'Oct 26, 2026', "Oct '26", '26 octobre', 'Okt 26', 'Q4', 'Yesterday', 'Back then', 'Run #3', 'last Tuesday', 'v1.2', 'a year ago', 'in the first round', 'Previously', 'Was', 'Before', 'Formerly', 'Stale'];

test('no wording or date format can get an untagged count sentence rewritten: it is only reported (strict files) or ignored (other files)', () => {
  for (const v of VARIANTS) {
    const text = `${v}: 429 tests in 39 files, 418 pass, 7 skipped, 105 of 100 mutations.\n`;
    for (const fix of [false, true]) {
      const strictRun = run('a.md', text, fix, true);
      assert.ok(strictRun.unchanged, `${v} untouched (fix=${fix})`);
      assert.ok(strictRun.kinds.length >= 1 && strictRun.kinds.every((k) => k === 'untagged'), `${v} reported as untagged in a checked file`);
      const other = run('b.md', text, fix, false);
      assert.ok(other.unchanged && other.r.findings.length === 0, `${v} ignored outside the checked list`);
    }
  }
  // a heading like "## Results (old)" cannot cause a write either
  const h = run('c.md', '## Results (old)\n429 tests in 39 files.\n', true, true);
  assert.ok(h.unchanged, 'never written (a heading naming old results also makes the section history, which is only ever ignored)');
});

test('[history] makes a sentence a record: never checked, never rewritten, no error even in a checked file', () => {
  for (const v of VARIANTS) { const x = run('d.md', `[history] ${v}: 429 tests in 39 files, 418 pass.\n`, true, true); assert.equal(x.r.findings.length, 0, v); assert.ok(x.unchanged, v); }
  const html = run('e.md', '<!-- history --> 429 tests in 39 files.\n', true, true); assert.equal(html.r.findings.length, 0);
  const lineLevel = run('f.md', '- [history] 429 tests in 39 files. [history] 418 pass, 7 skipped.\n', true, true); assert.equal(lineLevel.r.findings.length, 0); assert.ok(lineLevel.unchanged);
});

test('[current]: a wrong count fails the check and is fixed only with fix; a right count passes; the dated or "old"-sounding wording around it changes nothing', () => {
  const bad = run('g.md', '[current] We ran 100 tests in 41 files, 400 pass.\n', false, true);
  assert.deepEqual(bad.kinds, ['stale', 'stale', 'stale']); assert.ok(bad.unchanged, 'check mode never writes');
  const fixed = run('h.md', '[current] We ran 100 tests in 41 files, 400 pass.\n', true, true);
  assert.equal(fixed.r.text, '[current] We ran 443 tests in 40 files, 434 pass.\n');
  assert.equal(run('i.md', '<!-- current --> 443 tests in 40 files; <!-- current --> 105 of 105 mutations.\n', true, true).r.findings.length, 0);
  assert.ok(run('j.md', 'Oct 26: [current] 100 tests.\n', false, false).r.findings.length >= 1, 'a date does not exempt a [current] sentence');
});

test('tags: a tag inside a sentence tags that sentence; each sentence needs its own tag; the public/workspace tag carries over a semicolon, not a full stop', () => {
  const mixed = run('k.md', '[current] Now 100 tests. Earlier [history] 429 tests.\n', true, true);
  assert.equal(mixed.r.text, '[current] Now 443 tests. Earlier [history] 429 tests.\n');
  assert.equal(run('l.md', '[current] 443 tests. [history] 429 tests. [current] 443 tests.\n', true, true).r.findings.length, 0, 'the nearest preceding tag in the clause decides');
  assert.equal(run('m.md', '[current] On a fresh clone: 430 pass; [current] 13 skipped.\n', false, true).r.findings.length, 0);
  assert.deepEqual(run('n.md', '[current] On a fresh clone: 430 pass; [current] 99 skipped.\n', false, true).r.findings.map((x) => x.stated), ['99 skipped']);
  assert.deepEqual(run('o.md', '[current] On a fresh clone: 430 pass. [current] 13 skipped.\n', false, true).r.findings.map((x) => x.stated), ['13 skipped'], 'a full stop ends the tag');
  assert.equal(run('p.md', '[current] Full workspace: 434 pass; [current] 9 skipped.\n', false, true).r.findings.length, 0);
});

test('log files, history blocks and history sections are never checked, even with a [current] tag inside', () => {
  assert.ok(isHistoryFile('/x/STATUS.md') && isHistoryFile('BUILD-LOG.md') && isHistoryFile('READINESS-CHECK-2026-10-26.md') && isHistoryFile('DEMO-CLAIMS-AUDIT.md') && isHistoryFile('REPO-REVIEW-INDEPENDENT-4.md'));
  assert.ok(!isHistoryFile('README.md') && !isHistoryFile('docs/DEPLOY-RAILWAY.md') && !isHistoryFile('FINAL-TEXT-DRAFT.md'));
  const x = run('STATUS.md', '[current] 429 tests in 39 files.\n', true, true); assert.equal(x.r.findings.length, 0); assert.ok(x.unchanged);
  assert.deepEqual(historyMask(['# T', 'a', '## Old results', 'b', '## Now', 'c', '<!-- history:start -->', 'd', '<!-- history:end -->', 'e']), [false, false, true, true, false, false, true, true, true, false]);
  const y = run('q.md', '# D\n## Old results\n[current] 100 tests.\n## Now\n[current] 100 tests.\n', true, true);
  assert.deepEqual(y.r.findings.map((f) => f.line), [5]);
});

function project(readme: string, extra: Record<string, string> = {}) {
  const root = work();
  write(root, 'docs/test-counts.json', JSON.stringify(COUNTS));
  write(root, 'README.md', readme);
  for (const [n, t] of Object.entries(extra)) write(root, n, t);
  return root;
}
const cli = (root: string, args: string[]) => spawnSync(process.execPath, ['scripts/check-doc-counts.ts', ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, DOC_COUNTS_ROOT: root } });

test('CLI: untagged count in README fails with file:line; stale [current] fails; --fix is a dry run; --fix --write rewrites only [current] sentences; --write alone is refused', () => {
  const readme = (r: string) => join(r, 'README.md');
  const keep = 'Run on 26 octobre: 429 tests in 39 files.\nOkt 26: 7 skipped.\nPreviously 100 tests.\n';
  const root = project(keep + '[current] We ran 100 tests in 41 files.\n');
  const a = cli(root, []); assert.equal(a.status, 1); assert.match(a.stdout, /UNTAGGED .*README\.md:1/); assert.match(a.stdout, /STALE .*README\.md:4: states 100 tests/);
  const b = cli(root, ['--fix']); assert.equal(b.status, 1); assert.match(b.stdout, /would fix .*README\.md:4/); assert.equal(readFileSync(readme(root), 'utf8'), keep + '[current] We ran 100 tests in 41 files.\n', 'dry run writes nothing');
  const c = cli(root, ['--fix', '--write']); assert.equal(c.status, 1, 'untagged lines still fail'); assert.equal(readFileSync(readme(root), 'utf8'), keep + '[current] We ran 443 tests in 40 files.\n', 'only the [current] line changed');
  assert.equal(cli(root, ['--write']).status, 64);
  const clean = project('[history] 429 tests.\n[current] 443 tests in 40 files.\n'); assert.equal(cli(clean, []).status, 0);
});

test('CLI: STATUS.md is byte-identical after --fix --write (default list and named explicitly); a path outside the list is refused and unchanged', () => {
  const hist = 'Tests 429 in 39 files (422 pass, 7 skipped)\n[current] 100 tests.\n';
  const root = project('[current] 443 tests in 40 files.\n', { 'STATUS.md': hist, 'notes/other.md': '[current] 100 tests in 40 files.\n' });
  cli(root, ['--fix', '--write']);
  const st = join(root, 'STATUS.md'); cli(root, ['--fix', '--write', st]);
  assert.equal(readFileSync(st, 'utf8'), hist);
  const o = join(root, 'notes/other.md'); const r = cli(root, ['--fix', '--write', o]);
  assert.equal(readFileSync(o, 'utf8'), '[current] 100 tests in 40 files.\n'); assert.match(r.stdout, /REFUSED/); assert.equal(r.status, 1);
});

// ---------- round 4: clause scoping, N/N forms, published-file counts ----------
test('a tag covers only its own clause: a second sentence, text after a semicolon, a parenthesis, a second count after the clause ends and a quoted or code-span tag are NOT covered and never rewritten', () => {
  const keep = (text: string, expectUnchanged: string) => { const x = run('r.md', text, true, true); assert.equal(x.r.text, expectUnchanged, text); return x; };
  keep('[current] Now 100 tests. And 429 tests in an old run.\n', '[current] Now 443 tests. And 429 tests in an old run.\n');
  keep('- [current] 100 tests; (was 429 tests)\n', '- [current] 443 tests; (was 429 tests)\n');
  keep('[current] 100 tests (was 429 tests, 418 pass).\n', '[current] 443 tests (was 429 tests, 418 pass).\n');
  keep('Run: 429 tests [current] and later 100 tests.\n', 'Run: 429 tests [current] and later 443 tests.\n'); // only what follows the tag in its clause
  keep('He wrote "[current] 429 tests" and `[current] 429 tests`.\n', 'He wrote "[current] 429 tests" and `[current] 429 tests`.\n');
  keep('```\n[current] 429 tests\n```\n', '```\n[current] 429 tests\n```\n');
  const u = run('s.md', '[current] Now 443 tests. And 429 tests in an old run.\n', false, true);
  assert.deepEqual(u.kinds, ['untagged'], 'the untagged second count is an error in a checked file');
  const p = run('t.md', '[current] 443 tests ([current] 100 pass; 9 skipped)\n', true, true);
  assert.equal(p.r.text, '[current] 443 tests ([current] 434 pass; 9 skipped)\n', 'a parenthesis needs its own tag, and only the tagged number changes');
});

test('count forms: N/N pass/skipped, N pass/passed/passing, N skip/skips/skipped, N of M mutations, 105/105 mutations, N files, N published files, "N files, M bytes", N fail', () => {
  const c = (t: string) => run('u.md', t + '\n', false, true).r.findings.map((x) => x.stated);
  assert.deepEqual(c('workspace count ([current] 434/9) needs it'), []);
  assert.deepEqual(c('workspace count ([current] 441/9) needs it'), ['441/9 pass/skipped']);
  assert.deepEqual(c('[current] 100 passed, 3 skips'), ['100 pass', '3 skipped']);
  assert.deepEqual(c('[current] 100 passing and 3 skipping'), ['100 pass', '3 skipped']);
  assert.deepEqual(c('[current] 104/105 mutations killed'), ['104/105 killed/mutations']);
  assert.deepEqual(c('[current] 105/105 mutations killed'), []);
  assert.deepEqual(c('[current] killed 104 of 105 mutations'), ['104 of 105 mutations']);
  assert.deepEqual(c('[current] 12 files in 3 dirs'), ['12 files']);
  assert.deepEqual(c('[current] 3 failing'), ['3 fail']);
  assert.deepEqual(c('[current] 401/403/404 and 429/5xx and 10/26/2026 are not counts'), []);
  const pub = checkDocCounts(write(work(), 'v.md', '[current] 135 files, 985002 bytes.\n[current] 99 published files and 7 allowlisted paths.\n'), { ...COUNTS, publishedFiles: 137 }, false, true);
  assert.deepEqual(pub.findings.map((x) => x.stated), ['135 publishedFiles', '99 publishedFiles', '7 publishedFiles']);
  const ok = checkDocCounts(write(work(), 'w.md', '[current] 137 files, 985002 bytes.\n'), { ...COUNTS, publishedFiles: 137 }, false, true); assert.equal(ok.findings.length, 0);
});

test('no line-level exemption is left: a line that merely mentions live-guard or a "12 tests" figure is checked like any other', () => {
  assert.ok(run('x.md', 'test/live-guard.test.ts has 12 tests.\n', false, true).kinds.includes('untagged'));
});
