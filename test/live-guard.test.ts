// Proves, with no key and no real network, that the live scripts refuse cleanly, never print or write the
// key, and write only to the gitignored private folders. Child processes run the real scripts with
// a stubbed fetch (test/helpers/stub-fetch.mjs). If a real .dev.vars with a key exists the "no key"
// cases are skipped, because they could not prove anything.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from './helpers/tmp.ts';
import { join } from 'node:path';
import { EXIT_NO_KEY, HACKATHON_BASE, NO_KEY_MESSAGE, PRIVATE_OUTPUT_DIRS, blockNetwork, dryRunLines, findKey, missingIgnores, redact, requireKey } from '../scripts/live-guard.ts';
import { readFileSync } from 'node:fs';

const ROOT = new URL('../', import.meta.url).pathname;
const STUB = new URL('./helpers/stub-fetch.mjs', import.meta.url).href;
const FAKE_KEY = 'FAKE-KEY-for-test-0123456789abcdef';
const hasRealVars = existsSync(join(ROOT, '.dev.vars'));

function listing(dir: string, out: string[] = [], base = dir): string[] {
  for (const n of readdirSync(dir)) {
    if (n === 'node_modules' || n === '.git') continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) listing(p, out, base);
    else out.push(`${p.slice(base.length)}:${statSync(p).size}`);
  }
  return out.sort();
}

function run(script: string, args: string[], env: Record<string, string>) {
  const before = listing(ROOT);
  const r = spawnSync(process.execPath, ['--import', STUB, join(ROOT, 'scripts', script), ...args], {
    cwd: ROOT, env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf8', timeout: 90_000,
  });
  const after = listing(ROOT);
  return { status: r.status, out: r.stdout ?? '', err: r.stderr ?? '', all: `${r.stdout ?? ''}\n${r.stderr ?? ''}`, wrote: after.filter((x) => !before.includes(x)) };
}

for (const [script, args] of [['live-probe.ts', []], ['eval.ts', ['--live']]] as const) {
  test(`${script} ${args.join(' ')} with no key refuses: exit 2, clear message, no network, no file written`, { skip: hasRealVars }, () => {
    const r = run(script, [...args], {});
    assert.equal(r.status, EXIT_NO_KEY);
    assert.ok(r.err.includes(NO_KEY_MESSAGE), r.all);
    assert.ok(!r.all.includes('STUB-FETCH'), 'no fetch may be attempted');
    assert.deepEqual(r.wrote, []);
  });

  test(`${script} --dry-run with no key: exit 0, says key not set, no network, no file written`, { skip: hasRealVars }, () => {
    const r = run(script, [...args, '--dry-run'], {});
    assert.equal(r.status, 0, r.all);
    assert.match(r.out, /DRY RUN/);
    assert.match(r.out, /QLOO_API_KEY: NOT SET/);
    assert.match(r.out, /refuse with exit code 2/);
    assert.ok(!r.all.includes('STUB-FETCH'));
    assert.deepEqual(r.wrote, []);
  });

  test(`${script} --dry-run with a key present: key value never printed, no network, no file written`, () => {
    const r = run(script, [...args, '--dry-run'], { QLOO_API_KEY: FAKE_KEY });
    assert.equal(r.status, 0, r.all);
    assert.match(r.out, /QLOO_API_KEY: present \(value not shown\)/);
    assert.ok(!r.all.includes(FAKE_KEY), 'the key value must not appear in any output');
    assert.ok(!r.all.includes('STUB-FETCH'));
    assert.deepEqual(r.wrote, []);
    assert.match(r.out, new RegExp(PRIVATE_OUTPUT_DIRS.join('.*').replace(/\//g, '\\/')));
    assert.ok(!/MISSING from \.gitignore/.test(r.out), 'private folders must be listed in .gitignore');
  });
}

test('live probe with a key that Qloo rejects (stubbed 401): only the hackathon host is called, key never printed, nothing written', () => {
  const r = run('live-probe.ts', [], { QLOO_API_KEY: FAKE_KEY, STUB_FETCH_MODE: '401' });
  assert.equal(r.status, 1, r.all);
  const calls = r.err.split('\n').filter((l) => l.startsWith('STUB-FETCH'));
  assert.ok(calls.length >= 1);
  for (const c of calls) {
    assert.ok(c.startsWith(`STUB-FETCH ${HACKATHON_BASE}/`), c);
    assert.match(c, /headers=.*X-Api-Key/);
  }
  assert.ok(!r.all.includes(FAKE_KEY), 'the key value must not appear in any output');
  assert.deepEqual(r.wrote, []);
});

test('findKey: environment first, then .dev.vars (quotes stripped); empty values count as no key', () => {
  const d = mkdtempSync(join(tmpdir(), 'guard-'));
  try {
    const f = join(d, '.dev.vars');
    assert.equal(findKey({}, f), undefined);
    writeFileSync(f, 'QLOO_API_KEY=\nGEMINI_API_KEY=x\n');
    assert.equal(findKey({}, f), undefined);
    writeFileSync(f, 'QLOO_API_KEY="FAKE-KEY-from-file"\n');
    assert.equal(findKey({}, f), 'FAKE-KEY-from-file');
    assert.equal(findKey({ QLOO_API_KEY: 'from-env' }, f), 'from-env');
    assert.equal(findKey({ QLOO_API_KEY: '' }, f), 'FAKE-KEY-from-file');
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('requireKey exits with code 2 and prints only the message when there is no key', () => {
  const seen: string[] = [];
  const orig = console.error;
  console.error = (m: string) => { seen.push(String(m)); };
  try {
    const exit = ((c: number) => { throw new Error(`exit:${c}`); }) as (c: number) => never;
    assert.throws(() => requireKey({}, join(tmpdir(), 'no-such-dir', '.dev.vars'), exit), /exit:2/);
  } finally {
    console.error = orig;
  }
  assert.deepEqual(seen, [NO_KEY_MESSAGE]);
});

test('redact removes every occurrence of the key; dry-run lines never contain it', () => {
  assert.equal(redact(`a ${FAKE_KEY} b ${FAKE_KEY}`, FAKE_KEY), 'a [key hidden] b [key hidden]');
  assert.equal(redact('plain', undefined), 'plain');
  const text = dryRunLines({ script: 's', keyPresent: true, plan: ['x'], outputFiles: ['.private/p.json'], gitignoreText: '.private/\neval-output/\n' }).join('\n');
  assert.ok(!text.includes(FAKE_KEY));
  assert.match(text, /\(both listed\)/);
});

test('missingIgnores flags a .gitignore that lacks a private output folder; the project .gitignore has both', () => {
  assert.deepEqual(missingIgnores('.private/\n'), ['eval-output/']);
  assert.deepEqual(missingIgnores(readFileSync(join(ROOT, '.gitignore'), 'utf8')), []);
});

test('blockNetwork makes any later fetch throw', () => {
  const orig = globalThis.fetch;
  try {
    blockNetwork();
    assert.throws(() => fetch('https://hackathon.api.qloo.com/search'), /blocked/);
  } finally {
    globalThis.fetch = orig;
  }
});
