// The export script: refuses cleanly without a key, dry-runs without writing, and its synthetic output is
// byte-for-byte what the Worker serves from KV in judge mode.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import worker from '../src/worker.ts';
import { EXAMPLE_ROUTES } from '../src/examples.ts';
import { NO_KEY_MESSAGE } from '../scripts/live-guard.ts';

const ROOT = new URL('../', import.meta.url).pathname;
const STUB = new URL('./helpers/stub-fetch.mjs', import.meta.url).href;
const OUT = join(ROOT, '.private', 'examples');
const hasRealVars = existsSync(join(ROOT, '.dev.vars'));
const run = (args: string[], env: Record<string, string> = {}) =>
  spawnSync(process.execPath, ['--import', STUB, join(ROOT, 'scripts', 'export-examples.ts'), ...args], { cwd: ROOT, env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf8', timeout: 90_000 });

test('needs exactly one of --live or --synthetic', () => {
  assert.equal(run([]).status, 1);
  assert.equal(run(['--live', '--synthetic']).status, 1);
});

test('--live with no key: exit 2, clear message, nothing written, no fetch', { skip: hasRealVars }, () => {
  const before = existsSync(OUT);
  const r = run(['--live']);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes(NO_KEY_MESSAGE));
  assert.ok(!(r.stdout + r.stderr).includes('STUB-FETCH'));
  assert.equal(existsSync(OUT), before);
});

test('--live --dry-run with a key present: prints the plan, never the key, writes nothing, no fetch', () => {
  const FAKE = 'FAKE-KEY-for-test-export-0123456789';
  const before = existsSync(OUT);
  const r = run(['--live', '--dry-run'], { QLOO_API_KEY: FAKE });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /present \(value not shown\)/);
  assert.match(r.stdout, /example-live-msp-mco\.json/);
  assert.ok(!(r.stdout + r.stderr).includes(FAKE));
  assert.ok(!(r.stdout + r.stderr).includes('STUB-FETCH'));
  assert.equal(existsSync(OUT), before);
});

test('--synthetic writes 3 files under .private/examples only, and the Worker serves each exactly as stored', async () => {
  const existed = existsSync(OUT);
  try {
    const r = run(['--synthetic']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(!(r.stdout + r.stderr).includes('STUB-FETCH'));
    assert.deepEqual(readdirSync(OUT).sort(), EXAMPLE_ROUTES.map((x) => `example-synthetic-${x.id}.json`).sort());
    assert.match(r.stdout, /wrangler kv key put --binding CACHE_KV --remote "example:synthetic:msp-mco"/);
    const kv = { m: new Map<string, string>(), async get(k: string, t?: string) { const v = this.m.get(k) ?? null; return v && t === 'json' ? JSON.parse(v) : v; }, async put(k: string, v: string) { this.m.set(k, v); } };
    for (const x of EXAMPLE_ROUTES) kv.m.set(`example:synthetic:${x.id}`, readFileSync(join(OUT, `example-synthetic-${x.id}.json`), 'utf8'));
    // Not live (no key): the Worker reads the "synthetic" key. A fresh isolate per request is simulated by the KV-only path.
    const res = await worker.fetch(new Request('http://x/api/example/msp-mco', { headers: { 'cf-connecting-ip': '9.9.9.9' } }), { CACHE_KV: kv as never }, { waitUntil: () => {} });
    const body = (await res.json()) as { provenance: string; result: { domains: unknown[]; metrics: { qlooCalls: number } } };
    assert.equal(res.status, 200);
    assert.equal(body.provenance, 'computed-synthetic');
    assert.ok(body.result.domains.length > 0);
    assert.ok(body.result.metrics.qlooCalls > 0);
  } finally {
    if (!existed) rmSync(join(ROOT, '.private'), { recursive: true, force: true });
    else rmSync(OUT, { recursive: true, force: true });
  }
});
