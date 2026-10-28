// Extended validity harness (a second harness; the original check and the probe are untouched).
//
//   node scripts/validity-ext.ts --prereg prereg/validity-prereg.json --dry-run
//   node scripts/validity-ext.ts --prereg prereg/validity-prereg.json --expected-sha256 <hex> --live
//   node scripts/validity-ext.ts --prereg <file> --expected-sha256 <hex> --synthetic     (fixtures only; a rehearsal)
//
// Guarantees (each covered by test/validity-ext.test.ts):
//   - It refuses to run unless the SHA-256 of the pre-registration file equals --expected-sha256, a value recorded
//     BEFORE the key existed. No expected hash, a mismatch, an unsealed or incomplete file: refusal, nothing called.
//   - --dry-run needs no key and makes no network call (fetch is blocked); it prints the planned call count and writes nothing.
//   - A live run needs QLOO_API_KEY (environment or .dev.vars); without one it exits 2 before anything is built. The key is
//     never printed or written.
//   - The call budget stops the run BEFORE the call that would exceed it; the outcome is then INCONCLUSIVE.
//   - Output goes only to .private/validity-ext/ (gitignored): the result file and the entry sentence for the outcome.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { FixtureQlooClient } from '../src/qloo/fixture-client.ts';
import { HttpQlooClient } from '../src/qloo/http-client.ts';
import { MemoryCache } from '../src/qloo/cache.ts';
import { RULE, parsePrereg, planCalls, runExtendedValidity, sha256Hex, validatePrereg, type ExtResult } from '../src/agent/validity-ext.ts';
import { blockNetwork, findKey, missingIgnores, requireKey } from './live-guard.ts';

const EXIT = { OK: 0, USAGE: 3, HASH: 4, INVALID: 5 } as const;
const root = new URL('../', import.meta.url);

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (n: string) => process.argv.includes(n);
const fail = (code: number, msg: string): never => { console.error(msg); return process.exit(code); };

const preregPath = arg('--prereg');
const expected = arg('--expected-sha256')?.trim().toLowerCase();
const dry = has('--dry-run');
const live = has('--live');
const synthetic = has('--synthetic');
if (!preregPath || (!dry && live === synthetic)) {
  fail(EXIT.USAGE, 'usage: node scripts/validity-ext.ts --prereg <file> (--dry-run | --expected-sha256 <hex> (--live | --synthetic))');
}
if (!existsSync(preregPath!)) fail(EXIT.USAGE, `pre-registration file not found: ${preregPath}`);
const raw = readFileSync(preregPath!, 'utf8');
const sha = sha256Hex(raw);
let prereg: ReturnType<typeof parsePrereg> | undefined;
try { prereg = parsePrereg(raw); } catch (e) { fail(EXIT.INVALID, `cannot read the pre-registration file: ${(e as Error).message}`); }
const p = prereg!;
const varsPath = new URL('../.dev.vars', import.meta.url);
const outDir = new URL('../.private/validity-ext/', import.meta.url);

// The hash gate applies to every mode, including the dry run when a hash is supplied.
if (expected && expected !== sha) fail(EXIT.HASH, `HASH MISMATCH: the file's SHA-256 is ${sha}, expected ${expected}. Refusing to run.`);

if (dry) {
  blockNetwork();
  const plan = planCalls(p);
  const errors = validatePrereg(p, true);
  const gi = new URL('../.gitignore', import.meta.url);
  const missing = existsSync(gi) ? missingIgnores(readFileSync(gi, 'utf8')) : ['.gitignore'];
  const lines = [
    'DRY RUN of scripts/validity-ext.ts: no network call, no file written.',
    `Pre-registration file: ${preregPath}`,
    `  SHA-256: ${sha}`,
    `  status: ${p.status}${p.syntheticTestFile ? ' (synthetic test file: --synthetic only)' : ''}`,
    `  expected hash: ${expected ? 'supplied and matches' : 'NOT supplied: a real run would refuse'}`,
    `Design: ${p.routes.length} routes, ${new Set(p.routes.flat()).size} cities (= clusters of 3 items each), ${p.items.length} items, ${p.decoys.length} decoys, null: ${p.null.mode}${p.null.mode === 'seeded' ? ` (${p.null.count} cities per route, seed ${p.null.seed})` : ''}`,
    `Planned API calls: ${plan.total}  (open reads ${plan.open} + title lookups ${plan.resolves}${plan.assumedFiller ? ' (filler titles not filled in yet: 28 assumed)' : ''} + scoring ${plan.scoring})`,
    `With the full null (every other study city): ${plan.fullNullTotal} calls`,
    `Call budget in the file: ${p.budget?.maxCalls}${p.budget?.maxCalls >= plan.total ? '' : '  BELOW THE PLAN: a real run would refuse'}`,
    `Decision rule: usable clusters >= ${RULE.minUsableClusters}; cluster permutation p < ${RULE.maxP}; pooled rate >= ${RULE.minPooledRatePct}%; null rate <= ${RULE.maxNullRatePct}%; decoy two-sided p < ${RULE.decoyAlpha} makes it INCONCLUSIVE`,
    `QLOO_API_KEY: ${findKey(process.env, varsPath) ? 'present (value not shown)' : 'NOT SET. A live run would refuse with exit code 2.'}`,
    `Output a real run would write (only): .private/validity-ext/<time>-result.json and .private/validity-ext/<time>-entry-sentence.txt; .private/ ignored by git: ${missing.length ? 'NO, MISSING from .gitignore' : 'yes'}`,
    errors.length ? `A real run would refuse today: ${errors.length} problem(s), first: ${errors[0]}` : 'The file passes every check a real run makes.',
  ];
  for (const l of lines) console.log(l);
  process.exit(EXIT.OK);
}

if (!expected) fail(EXIT.HASH, 'REFUSING TO RUN: no --expected-sha256. Supply the hash recorded before the key existed.');
const errors = validatePrereg(p, true);
if (errors.length) fail(EXIT.INVALID, `REFUSING TO RUN: the pre-registration file is not valid:\n - ${errors.join('\n - ')}`);
if (live && p.syntheticTestFile) fail(EXIT.INVALID, 'REFUSING TO RUN: a synthetic test file cannot be used with --live.');

const client = live ? new HttpQlooClient({ apiKey: requireKey(process.env, varsPath), cache: new MemoryCache(4000) }) : new FixtureQlooClient();
let result: ExtResult;
try {
  result = await runExtendedValidity(client, p, { sha256: sha, expectedSha256: expected! });
} catch (e) {
  // Nothing is written on a failed run. The message never contains the key (the client never puts it in a message).
  fail(1, `RUN FAILED: ${(e as Error).message}\nNothing was written.`);
}
result = result!;
mkdirSync(outDir, { recursive: true });
const stamp = result.at.replace(/[:.]/g, '-');
const resultFile = new URL(`${stamp}-result.json`, outDir);
const sentenceFile = new URL(`${stamp}-entry-sentence.txt`, outDir);
writeFileSync(resultFile, JSON.stringify(result, null, 2));
writeFileSync(sentenceFile, result.entrySentence + '\n');
const d = result.decision;
console.log(`OUTCOME: ${d.outcome} (${d.reason}). Usable clusters ${d.usableClusters} of ${d.totalClusters}; success ${d.k}/${d.n}; calls ${result.calls.used} of ${result.calls.max}.`);
console.log(`Source: ${result.source === 'synthetic-fixture' ? 'SYNTHETIC FIXTURES (says nothing about Qloo)' : 'live Qloo'}`);
console.log(`Wrote .private/validity-ext/${stamp}-result.json and ...-entry-sentence.txt (gitignored).`);
console.log('\nEntry sentence:\n' + result.entrySentence);
