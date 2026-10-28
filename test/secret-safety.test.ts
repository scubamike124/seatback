// Fails if a key-shaped string appears in logs, errors, thrown errors, responses, built frontend
// assets or the tracked tree. All fake keys are built at runtime so no key-shaped literal is committed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from './helpers/tmp.ts';
import { join, relative } from 'node:path';
import worker from '../src/worker.ts';
import { PAGE_HTML } from '../src/ui/page.ts';
import { APP_JS } from '../src/ui/app.ts';
import { APP_CSS } from '../src/ui/styles.ts';
import { assertNoSecret, containsSecret, qlooLog, redactSecrets } from '../src/qloo/redact.ts';
import { createQlooClient } from '../src/qloo/client.ts';
import { resetQlooCooldown } from '../src/qloo/http-client.ts';

const ROOT = new URL('../', import.meta.url).pathname;
const KEY = ['FAKE', 'KEY', 'secret', 'Zq81xT0mN4pLw2'].join('-');
const SHAPES = [/\bAIza[0-9A-Za-z_-]{30,}/, /X-Api-Key["']?\s*[:=]\s*["'][A-Za-z0-9._~+/-]{12,}["']/i, /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/, /\b(QLOO_API_KEY|GEMINI_API_KEY|ADMIN_TOKEN)[ \t]*=[ \t]*["']?(?!FAKE-KEY-|abcdefghijklmnop1234)[A-Za-z0-9_-]{12,}/, /\bsk-[A-Za-z0-9]{24,}/];

test('redactSecrets removes the known key and credential shapes; logs carry the mode and no key', () => {
  const dirty = `fail X-Api-Key: ${KEY} and QLOO_API_KEY=${KEY} Bearer ${'a'.repeat(30)} ${KEY}`;
  const clean = redactSecrets(dirty, [KEY]);
  assert.ok(!clean.includes(KEY)); assert.ok(!containsSecret(clean));
  assert.ok(containsSecret(`X-Api-Key: ${'k'.repeat(20)}`));
  const lines: string[] = [];
  qlooLog('MOCK', `calling with ${KEY}`, [KEY], (l) => lines.push(l));
  assert.match(lines[0]!, /^\[QLOO:MOCK\]/); assert.ok(!lines[0]!.includes(KEY));
  assert.throws(() => assertNoSecret({ a: KEY }, [KEY]));
  assert.doesNotThrow(() => assertNoSecret({ a: 'Orlando' }, [KEY]));
});

test('thrown errors, traces and results from the client never contain the key (all failure kinds)', async () => {
  for (const status of [401, 403, 404, 429, 500, 400]) {
    resetQlooCooldown();
    const f = (async () => new Response(`echo ${KEY}`, { status })) as typeof fetch;
    const h = createQlooClient({ QLOO_API_KEY: KEY }, { fetchImpl: f, sleep: async () => {} });
    try { await h.client.insights({ domain: 'movie', location: { query: 'x' } }); } catch (e) { assertNoSecret(e, [KEY]); }
    assertNoSecret(h.client.trace, [KEY]);
  }
  resetQlooCooldown();
  const bad = (async () => { throw Object.assign(new Error(`socket ${KEY}`), { name: 'TimeoutError' }); }) as typeof fetch;
  const h = createQlooClient({ QLOO_API_KEY: KEY }, { fetchImpl: bad, sleep: async () => {}, maxRetries: 0 });
  await assert.rejects(() => h.client.searchLocality('x'), (e: Error) => { assertNoSecret(e, [KEY]); return true; });
});

test('worker responses (pages, assets, health, config, error stream) never carry the key', async () => {
  const env = { QLOO_API_KEY: KEY, GEMINI_API_KEY: KEY + '-g', ADMIN_TOKEN: KEY + '-a' };
  for (const path of ['/', '/app.js', '/app.css', '/api/health', '/api/config', '/nope']) {
    const res = await worker.fetch(new Request(`https://x.test${path}`), env as never);
    const body = await res.text();
    assert.ok(!body.includes(KEY), path);
    for (const [k, v] of res.headers) assert.ok(!v.includes(KEY), `${path} header ${k}`);
    assert.ok(!SHAPES.some((re) => re.test(body)), `${path} key-shaped string`);
  }
});

test('built frontend assets contain no key, no key variable and no Qloo host', () => {
  for (const [name, text] of [['page', PAGE_HTML], ['app.js', APP_JS], ['app.css', APP_CSS]] as const) {
    assert.ok(!/QLOO_API_KEY|GEMINI_API_KEY|ADMIN_TOKEN|X-Api-Key/i.test(text), `${name} mentions a secret name`);
    assert.ok(!/hackathon\.api\.qloo\.com/.test(text), `${name} talks to Qloo directly`);
    assert.ok(!SHAPES.some((re) => re.test(text)), `${name} key-shaped`);
  }
  const ui = readdirSync(join(ROOT, 'src/ui')).map((f) => readFileSync(join(ROOT, 'src/ui', f), 'utf8')).join('\n');
  assert.ok(!/QLOO_API_KEY|X-Api-Key/i.test(ui), 'src/ui must not reference the key');
});

const SKIP = new Set(['node_modules', '.git', '.wrangler', 'dist', '.tmp-test']);
// Existing self-test that plants labelled dummy assignments on purpose (see public-safety.test.ts).
const PLANTED_ON_PURPOSE = new Set(['test/public-safety.test.ts']);
export function secretScan(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      if (SKIP.has(n)) continue;
      const p = join(d, n);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (statSync(p).size > 2_000_000) continue;
      if (PLANTED_ON_PURPOSE.has(relative(root, p))) continue;
      const text = readFileSync(p, 'utf8');
      SHAPES.forEach((re, i) => { if (re.test(text)) out.push(`${relative(root, p)} (pattern ${i})`); });
    }
  };
  walk(root);
  return out;
}

test('secret scan over the project tree is clean, and catches planted keys (self-test)', () => {
  assert.deepEqual(secretScan(ROOT), []);
  const dir = mkdtempSync(join(tmpdir(), 'secret-scan-'));
  try {
    writeFileSync(join(dir, 'a.txt'), `X-Api-Key: "${'q'.repeat(20)}"`);
    writeFileSync(join(dir, 'b.env'), `GEMINI_API_KEY=${'Ab1'.repeat(8)}`);
    assert.equal(secretScan(dir).length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('.gitignore covers .dev.vars, .env and variants; the example file holds no value', () => {
  const lines = readFileSync(join(ROOT, '.gitignore'), 'utf8').split('\n').map((l) => l.trim());
  for (const need of ['.dev.vars', '.env', '.env.*', '.dev.vars.*', '.private/', 'eval-output/']) assert.ok(lines.includes(need), need);
  assert.match(readFileSync(join(ROOT, '.dev.vars.example'), 'utf8'), /^QLOO_API_KEY=\s*$/m);
});
