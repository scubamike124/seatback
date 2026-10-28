// The extended validity harness, offline: decision-rule edge cases and threshold sensitivity, the hash gate, the call budget,
// the seeded null, the dry run, key handling, output location and the three entry sentences. Nothing here uses live data:
// a scripted fake client with known effects and the synthetic fixtures stand in for Qloo, and fetch is stubbed in child processes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from './helpers/tmp.ts';
import { join } from 'node:path';
import {
  POWER_NOTE, RULE, decide, entrySentence, nullCitiesFor, parsePrereg, planCalls, routeKey, runExtendedValidity, sha256Hex, twoSidedBinomial, validatePrereg,
  type ClusterTally, type DecisionInput, type Prereg, type Rule,
} from '../src/agent/validity-ext.ts';
import { clusterPermutationP } from '../src/agent/validity.ts';
import { HACKATHON_BASE, NO_KEY_MESSAGE } from '../scripts/live-guard.ts';
import { ScriptedQloo, type Script } from './helpers/scripted-qloo.ts';

const ROOT = new URL('../', import.meta.url).pathname;
const STUB = new URL('./helpers/stub-fetch.mjs', import.meta.url).href;
const SYN = join(ROOT, 'test/fixtures/validity-prereg.synthetic.json');
const TPL = join(ROOT, 'prereg/validity-prereg.template.json');
const synRaw = readFileSync(SYN, 'utf8');
const synSha = sha256Hex(synRaw);
const loadSyn = (): Prereg => parsePrereg(synRaw);
const hasRealVars = existsSync(join(ROOT, '.dev.vars'));
const FAKE_KEY = 'FAKE-KEY-for-test-ext-0123456789abcdef';
const FIXED_NOW = () => new Date('2026-01-01T00:00:00Z');

// ---------------------------------------------------------------- A. decision rule: the numbers and the edges
const cl = (ks: number[], n = 4): ClusterTally[] => ks.map((k, i) => ({ id: `c${i}`, k, n, usable: true }));
const input = (clusters: ClusterTally[], over: Partial<DecisionInput> = {}): DecisionInput => ({ clusters, decoy: { k: 6, n: 12 }, nullK: 24, nullN: 60, ...over });
/** 10 usable clusters of 4 items: 26 of 40 = exactly 65.0%, p well below 0.05. */
const AT65 = () => cl([3, 3, 3, 3, 3, 3, 2, 2, 2, 2]);

test('the rule in code is exactly the pre-registered rule (a tripwire: change a number and this fails)', () => {
  assert.deepEqual({ ...RULE }, { clusterUsableMinItems: 2, minUsableClusters: 10, maxP: 0.05, minPooledRatePct: 65, maxNullRatePct: 60, decoyAlpha: 0.05 });
});

test('pooled rate exactly 65% passes (inclusive); one success fewer fails', () => {
  const d = decide(input(AT65()));
  assert.equal(d.ratePct, 65);
  assert.ok(d.p! < 0.05, `the scenario must be significant on its own: p = ${d.p}`);
  assert.equal(d.outcome, 'GO');
  const below = decide(input(cl([3, 3, 3, 3, 3, 2, 2, 2, 2, 2])));
  assert.equal(below.ratePct, 62.5);
  assert.equal(below.outcome, 'NO-GO');
  assert.match(below.failed.join(' '), /pooled success 62\.5% is below 65%/);
});

test('null rate exactly 60% passes (inclusive); 37 of 60 fails', () => {
  assert.equal(decide(input(AT65(), { nullK: 36, nullN: 60 })).outcome, 'GO');
  const d = decide(input(AT65(), { nullK: 37, nullN: 60 }));
  assert.equal(d.outcome, 'NO-GO');
  assert.match(d.failed.join(' '), /null rate 61\.7% is above 60%/);
});

test('exactly 10 usable clusters are evaluated; 9 are INCONCLUSIVE; 11 of 12 (one cluster missing) are evaluated', () => {
  assert.equal(decide(input(AT65())).outcome, 'GO');
  const nine = AT65(); nine[0]!.usable = false;
  const d9 = decide(input(nine));
  assert.equal(d9.outcome, 'INCONCLUSIVE'); assert.equal(d9.reason, 'too_few_clusters'); assert.equal(d9.usableClusters, 9);
  const twelve = [...cl([3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3], 3)]; twelve[11]!.usable = false; twelve[11]!.n = 0; twelve[11]!.k = 0;
  const d11 = decide(input(twelve));
  assert.equal(d11.usableClusters, 11); assert.equal(d11.totalClusters, 12); assert.equal(d11.outcome, 'GO');
});

test('p must be strictly below 0.05: a threshold equal to the observed p fails, one just above passes', () => {
  const clusters = AT65();
  const p = decide(input(clusters)).p!;
  assert.equal(decide(input(clusters), { ...RULE, maxP: p }).outcome, 'NO-GO');
  assert.equal(decide(input(clusters), { ...RULE, maxP: p + 1e-9 }).outcome, 'GO');
  assert.equal(p, clusterPermutationP(clusters.map((c) => ({ k: c.k, n: c.n }))), 'the decision uses the project\'s own exact permutation function');
});

test('all ties: every comparison fails, so the outcome is NO-GO, never GO and never a division error', () => {
  const d = decide(input(cl(Array(12).fill(0), 3), { decoy: { k: 0, n: 0 } }));
  assert.equal(d.outcome, 'NO-GO'); assert.equal(d.p, 1); assert.equal(d.k, 0); assert.equal(d.ratePct, 0);
});

test('decoy flag: 10 of 12 (two-sided p 0.039) is INCONCLUSIVE, 9 of 12 (p 0.146) is not; a ties-only decoy set (n = 0) never flags', () => {
  assert.ok(Math.abs(twoSidedBinomial(10, 12)! - 0.03857421875) < 1e-12);
  assert.equal(decide(input(AT65(), { decoy: { k: 10, n: 12 } })).reason, 'decoy_flag');
  assert.equal(decide(input(AT65(), { decoy: { k: 2, n: 12 } })).reason, 'decoy_flag', 'the flag is two-sided');
  assert.equal(decide(input(AT65(), { decoy: { k: 9, n: 12 } })).outcome, 'GO');
  assert.equal(decide(input(AT65(), { decoy: { k: 0, n: 0 } })).outcome, 'GO');
  assert.equal(twoSidedBinomial(0, 0), null);
});

test('no null comparisons: INCONCLUSIVE; a budget stop overrides even a perfect result', () => {
  assert.equal(decide(input(AT65(), { nullK: 0, nullN: 0 })).reason, 'no_null_data');
  const perfect = decide(input(cl(Array(12).fill(3), 3), { budgetStopped: true }));
  assert.equal(perfect.outcome, 'INCONCLUSIVE'); assert.equal(perfect.reason, 'budget');
});

test('mutation sensitivity: changing any single threshold flips the matching boundary case, so these tests would fail', () => {
  const mutate = (over: Partial<Rule>) => ({ ...RULE, ...over });
  assert.equal(decide(input(AT65()), mutate({ minPooledRatePct: 66 })).outcome, 'NO-GO');
  assert.equal(decide(input(AT65()), mutate({ minPooledRatePct: 64 })).outcome, 'GO');
  assert.equal(decide(input(AT65(), { nullK: 36, nullN: 60 }), mutate({ maxNullRatePct: 59 })).outcome, 'NO-GO');
  assert.equal(decide(input(AT65()), mutate({ minUsableClusters: 11 })).reason, 'too_few_clusters');
  assert.equal(decide(input(AT65(), { decoy: { k: 9, n: 12 } }), mutate({ decoyAlpha: 0.2 })).reason, 'decoy_flag');
  assert.equal(decide(input(AT65()), mutate({ maxP: 0.0001 })).outcome, 'NO-GO');
});

// ---------------------------------------------------------------- B. the pre-registration file and its hash
test('the shipped files carry the same rule as the code; the template is incomplete by design, the synthetic file is complete', () => {
  const tpl = parsePrereg(readFileSync(TPL, 'utf8'));
  assert.deepEqual(tpl.rule, { ...RULE });
  assert.deepEqual(loadSyn().rule, { ...RULE });
  assert.equal(tpl.status, 'TEMPLATE');
  assert.deepEqual(validatePrereg(tpl, false), ['null.seed must be an integer fixed before the key arrives']);
  const forRun = validatePrereg(tpl, true);
  assert.ok(forRun.length > 40 && forRun.includes('status is TEMPLATE, a run needs SEALED'));
  assert.ok(tpl.items.every((i) => i.title === ''), 'no item is chosen in the template');
  assert.deepEqual(validatePrereg(loadSyn(), true), []);
});

test('validation catches a changed rule, a budget below the plan, a placeholder city, a repeated title and an unsealed file', () => {
  const edit = (f: (p: Prereg) => void) => { const p = loadSyn(); f(p); return validatePrereg(p, true).join(' | '); };
  assert.match(edit((p) => { p.rule.minPooledRatePct = 60; }), /rule\.minPooledRatePct in the file \(60\) differs from the rule in code \(65\)/);
  assert.match(edit((p) => { p.budget.maxCalls = 300; }), /budget\.maxCalls \(300\) is below the planned 328/);
  assert.match(edit((p) => { p.routes[3]![0] = '<<CITY 7>>'; p.items.forEach((i) => { if (i.city === 'Chicago') i.city = '<<CITY 7>>'; }); }), /a city is still a placeholder/);
  assert.match(edit((p) => { p.items[1]!.title = p.items[0]!.title; }), /a title appears twice/);
  assert.match(edit((p) => { p.status = 'TEMPLATE'; }), /status is TEMPLATE/);
  assert.match(edit((p) => { p.items.pop(); }), /exactly one .* item is required/);
});

// ---------------------------------------------------------------- C. the seeded null
test('the seeded null is deterministic, excludes the route ends, and changes with the seed', () => {
  const p = loadSyn();
  const lists = p.routes.map((r) => nullCitiesFor(p, r));
  assert.deepEqual(p.routes.map((r) => nullCitiesFor(p, r)), lists, 'same file, same lists, every time');
  p.routes.forEach((r, i) => {
    assert.equal(lists[i]!.length, 4);
    assert.ok(!lists[i]!.includes(r[0]) && !lists[i]!.includes(r[1]));
    assert.deepEqual(lists[i], [...lists[i]!].sort());
    assert.ok(lists[i]!.every((c) => p.routes.flat().includes(c)));
  });
  const other = { ...p, null: { mode: 'seeded' as const, count: 4, seed: 7 } };
  assert.ok(p.routes.some((r, i) => nullCitiesFor(other, r).join() !== lists[i]!.join()), 'a different seed gives a different selection');
  assert.equal(nullCitiesFor({ ...p, null: { mode: 'full' } }, p.routes[0]!).length, 10);
  assert.deepEqual(nullCitiesFor({ ...p, null: { mode: 'fixed', perRoute: { [routeKey(p.routes[0]!)]: ['Boston', 'Dallas'] } } }, p.routes[0]!), ['Boston', 'Dallas']);
});

// ---------------------------------------------------------------- D. the run, the plan and the budget (scripted client)
async function run(script: Script, maxCalls?: number, p = loadSyn()) {
  const c = new ScriptedQloo(p, script);
  const r = await runExtendedValidity(c, p, { sha256: synSha, expectedSha256: synSha, maxCalls, now: FIXED_NOW });
  return { r, c, p };
}

test('the planned call count is 328 (544 with the full null) and a complete run uses exactly the plan', async () => {
  const plan = planCalls(loadSyn());
  assert.deepEqual({ open: plan.open, resolves: plan.resolves, scoring: plan.scoring, total: plan.total, full: plan.fullNullTotal }, { open: 36, resolves: 76, scoring: 216, total: 328, full: 544 });
  const { r, c } = await run({ effect: 0.4 });
  assert.equal(r.calls.used, 328); assert.equal(c.calls, 328); assert.equal(r.calls.planned, 328);
});

test('outcomes on known effects: a real effect is GO; none or a reversed 40% is NO-GO; biased decoys, unusable clusters or a budget stop are INCONCLUSIVE', async () => {
  const unresolved = new Set(loadSyn().items.filter((i) => ['Chicago', 'Boston', 'Dallas'].includes(i.city) && i.domain !== 'movie').map((i) => i.title));
  const go = (await run({ effect: 0.4 })).r.decision;
  assert.deepEqual([go.outcome, go.k, go.n, go.usableClusters], ['GO', 36, 36, 12]);
  assert.equal((await run({ effect: 0 })).r.decision.outcome, 'NO-GO');
  assert.equal((await run({ effect: 0.4, reverseFraction: 0.4 })).r.decision.outcome, 'NO-GO');
  const decoy = (await run({ effect: 0.4, decoyFavours: 'origin' })).r;
  assert.deepEqual([decoy.decision.outcome, decoy.decision.reason, decoy.decoy.k, decoy.decoy.n], ['INCONCLUSIVE', 'decoy_flag', 12, 12]);
  const few = (await run({ effect: 0.4, unresolved })).r.decision;
  assert.deepEqual([few.outcome, few.reason, few.usableClusters], ['INCONCLUSIVE', 'too_few_clusters', 9]);
  const ties = (await run({ effect: 0.4, allTies: true })).r;
  assert.deepEqual([ties.decision.outcome, ties.decision.k, ties.decoy.n], ['NO-GO', 0, 0]);
});

test('the call budget stops BEFORE the call that would exceed it: the client never sees call max+1, and the outcome is INCONCLUSIVE', async () => {
  const { r, c } = await run({ effect: 0.4 }, 50);
  assert.equal(r.calls.used, 50); assert.equal(c.calls, 50);
  assert.deepEqual([r.decision.outcome, r.decision.reason], ['INCONCLUSIVE', 'budget']);
  assert.equal((await run({ effect: 0.4 }, 328)).r.decision.outcome, 'GO', 'a budget equal to the plan completes');
  const short = await run({ effect: 0.4 }, 327);
  assert.deepEqual([short.r.calls.used, short.c.calls, short.r.decision.reason], [327, 327, 'budget']);
  assert.match(short.r.entrySentence, /reached its pre-registered limit of 327 calls/);
});

test('the run is deterministic: the same file and the same client give an identical result', async () => {
  const a = (await run({ effect: 0.4, reverseFraction: 0.2 })).r;
  const b = (await run({ effect: 0.4, reverseFraction: 0.2 })).r;
  assert.deepEqual(a, b);
  assert.equal(a.preregSha256, synSha);
  assert.equal(a.expectedSha256, synSha);
  assert.deepEqual(a.null.cities, Object.fromEntries(loadSyn().routes.map((r) => [routeKey(r), nullCitiesFor(loadSyn(), r)])));
});

// ---------------------------------------------------------------- E. the entry sentence for each outcome
const BANNED = /validated|\bproves?\b|\bproven\b|predict|forecast|demonstrates that Seatback|guarantee/i;
test('each outcome has its own sentence, and none claims more than the data supports', async () => {
  const unresolved = new Set(loadSyn().items.filter((i) => ['Chicago', 'Boston', 'Dallas'].includes(i.city) && i.domain !== 'movie').map((i) => i.title));
  const go = (await run({ effect: 0.4 })).r, nogo = (await run({ effect: 0 })).r, inc = (await run({ effect: 0.4 }, 50)).r, dec = (await run({ effect: 0.4, decoyFavours: 'origin' })).r, few = (await run({ effect: 0.4, unresolved })).r;
  for (const r of [go, nogo, inc, dec, few]) {
    assert.ok(r.entrySentence.startsWith('NOT FOR SUBMISSION: this run used synthetic fixtures'), 'synthetic runs are marked');
    assert.ok(r.entrySentence.includes(synSha.slice(0, 12)), 'the hash is stated');
    assert.doesNotMatch(r.entrySentence, BANNED);
  }
  assert.match(go.entrySentence, /36 of 36 \(100\.0%\) ranked higher with their own city's anchors/);
  assert.match(go.entrySentence, /It does not show that a slate earns more viewing, that the method holds outside the US, or that route-level programming helps/);
  assert.match(go.entrySentence, /Secondary views, which did not decide the outcome/);
  assert.match(nogo.entrySentence, /The test did not pass: 3 of 36/);
  assert.match(nogo.entrySentence, /We therefore do not claim that Seatback reads cities correctly/);
  assert.ok(nogo.entrySentence.includes(POWER_NOTE) && nogo.entrySentence.includes('so we cannot rule out a smaller effect'));
  assert.match(inc.entrySentence, /could not be evaluated: the run reached its pre-registered limit of 50 calls/);
  assert.match(inc.entrySentence, /We make no claim either way about whether Seatback reads cities correctly\./);
  assert.match(dec.entrySentence, /decoy titles, which belong to neither city, favoured one route end in 12 of 12 non-tied comparisons/);
  assert.match(few.entrySentence, /only 9 of 12 city clusters had enough titles scored \(at least 10 were required\)/);
  for (const r of [go, nogo, inc]) for (const other of [go, nogo, inc]) if (r !== other) assert.notEqual(r.entrySentence, other.entrySentence);
  // A live result carries no synthetic prefix and states the same facts.
  const live = entrySentence({ ...go, source: 'qloo-live' });
  assert.ok(!live.startsWith('NOT FOR SUBMISSION'));
  assert.doesNotMatch(live, BANNED);
});

// ---------------------------------------------------------------- F. the command line: hash gate, dry run, key, output location
function listing(dir: string, out: string[] = [], base = dir): string[] {
  for (const n of readdirSync(dir)) {
    if (n === 'node_modules' || n === '.git') continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) listing(p, out, base); else out.push(p.slice(base.length));
  }
  return out.sort();
}
function cli(args: string[], env: Record<string, string> = {}) {
  const before = listing(ROOT);
  const r = spawnSync(process.execPath, ['--import', STUB, join(ROOT, 'scripts/validity-ext.ts'), ...args], { cwd: ROOT, env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf8', timeout: 120_000 });
  const after = listing(ROOT);
  return { status: r.status, out: r.stdout ?? '', err: r.stderr ?? '', all: `${r.stdout ?? ''}\n${r.stderr ?? ''}`, wrote: after.filter((x) => !before.includes(x)) };
}
const cleanup = () => { rmSync(join(ROOT, '.private/validity-ext'), { recursive: true, force: true }); try { if (!readdirSync(join(ROOT, '.private')).length) rmSync(join(ROOT, '.private'), { recursive: true }); } catch { /* none */ } };

test('hash gate: no expected hash, a wrong hash, or a one-byte-different file all refuse, call nothing and write nothing', () => {
  const none = cli(['--prereg', SYN, '--synthetic']);
  assert.equal(none.status, 4); assert.match(none.err, /REFUSING TO RUN: no --expected-sha256/); assert.deepEqual(none.wrote, []);
  const wrong = cli(['--prereg', SYN, '--expected-sha256', '0'.repeat(64), '--synthetic']);
  assert.equal(wrong.status, 4); assert.match(wrong.err, new RegExp(`HASH MISMATCH: the file's SHA-256 is ${synSha}`)); assert.deepEqual(wrong.wrote, []);
  const dryWrong = cli(['--prereg', SYN, '--expected-sha256', '0'.repeat(64), '--dry-run']);
  assert.equal(dryWrong.status, 4, 'the gate applies to the dry run too when a hash is given');
  const d = mkdtempSync(join(tmpdir(), 'ext-'));
  try {
    const f = join(d, 'edited.json');
    writeFileSync(f, synRaw.replace('"seed": 20261025', '"seed": 20261026'));
    const edited = cli(['--prereg', f, '--expected-sha256', synSha, '--synthetic']);
    assert.equal(edited.status, 4); assert.match(edited.err, /HASH MISMATCH/); assert.deepEqual(edited.wrote, []);
    assert.ok(![none, wrong, edited].some((x) => x.all.includes('STUB-FETCH')));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('with the right hash a synthetic run completes, writes only under .private/validity-ext/, and marks itself synthetic', () => {
  try {
    const r = cli(['--prereg', SYN, '--expected-sha256', synSha, '--synthetic']);
    assert.equal(r.status, 0, r.all);
    assert.match(r.out, /OUTCOME: (GO|NO-GO|INCONCLUSIVE) /);
    assert.match(r.out, /SYNTHETIC FIXTURES \(says nothing about Qloo\)/);
    assert.equal(r.wrote.length, 2);
    for (const w of r.wrote) assert.ok(w.startsWith('.private/validity-ext/'), w);
    const resFile = r.wrote.find((w) => w.endsWith('-result.json'))!;
    const sentFile = r.wrote.find((w) => w.endsWith('-entry-sentence.txt'))!;
    const res = JSON.parse(readFileSync(join(ROOT, resFile), 'utf8'));
    assert.equal(res.preregSha256, synSha); assert.equal(res.expectedSha256, synSha); assert.equal(res.source, 'synthetic-fixture');
    assert.ok(res.calls.used <= res.calls.max);
    assert.ok(readFileSync(join(ROOT, sentFile), 'utf8').startsWith('NOT FOR SUBMISSION'));
    assert.ok(!r.all.includes('STUB-FETCH'), 'a synthetic run makes no network call');
  } finally { cleanup(); }
});

test('dry run: no key, no network, no file; prints the hash, 328 planned calls and 544 with the full null; never prints a key', () => {
  const envs: Record<string, string>[] = [{}, { QLOO_API_KEY: FAKE_KEY }];
  for (const env of envs) {
    const r = cli(['--prereg', SYN, '--dry-run'], env);
    assert.equal(r.status, 0, r.all);
    assert.match(r.out, new RegExp(`SHA-256: ${synSha}`));
    assert.match(r.out, /Planned API calls: 328 {2}\(open reads 36 \+ title lookups 76 \+ scoring 216\)/);
    assert.match(r.out, /With the full null \(every other study city\): 544 calls/);
    assert.match(r.out, /expected hash: NOT supplied: a real run would refuse/);
    assert.match(r.out, env.QLOO_API_KEY ? /present \(value not shown\)/ : /QLOO_API_KEY: NOT SET/);
    assert.ok(!r.all.includes(FAKE_KEY) && !r.all.includes('STUB-FETCH'));
    assert.deepEqual(r.wrote, []);
  }
  const ok = cli(['--prereg', SYN, '--expected-sha256', synSha, '--dry-run']);
  assert.match(ok.out, /expected hash: supplied and matches/);
  const tpl = cli(['--prereg', TPL, '--dry-run']);
  assert.match(tpl.out, /status: TEMPLATE/);
  assert.match(tpl.out, /filler titles not filled in yet: 28 assumed/);
  assert.match(tpl.out, /A real run would refuse today: \d+ problem\(s\), first: status is TEMPLATE/);
});

test('live path: a synthetic test file cannot go live; no key refuses with exit 2; a rejected key (stubbed 401) fails cleanly with the key in no output and nothing written', () => {
  const d = mkdtempSync(join(tmpdir(), 'ext-'));
  try {
    const live = cli(['--prereg', SYN, '--expected-sha256', synSha, '--live'], { QLOO_API_KEY: FAKE_KEY });
    assert.equal(live.status, 5); assert.match(live.err, /a synthetic test file cannot be used with --live/); assert.ok(!live.all.includes(FAKE_KEY)); assert.deepEqual(live.wrote, []);
    const p = JSON.parse(synRaw); delete p.syntheticTestFile;
    const raw = JSON.stringify(p, null, 2) + '\n'; const f = join(d, 'sealed.json'); writeFileSync(f, raw);
    const sha = sha256Hex(raw);
    if (!hasRealVars) {
      const nokey = cli(['--prereg', f, '--expected-sha256', sha, '--live']);
      assert.equal(nokey.status, 2); assert.ok(nokey.err.includes(NO_KEY_MESSAGE)); assert.deepEqual(nokey.wrote, []); assert.ok(!nokey.all.includes('STUB-FETCH'));
    }
    const rejected = cli(['--prereg', f, '--expected-sha256', sha, '--live'], { QLOO_API_KEY: FAKE_KEY, STUB_FETCH_MODE: '401' });
    assert.equal(rejected.status, 1); assert.match(rejected.err, /RUN FAILED/); assert.ok(!rejected.all.includes(FAKE_KEY)); assert.deepEqual(rejected.wrote, []);
    const calls = rejected.err.split('\n').filter((l) => l.startsWith('STUB-FETCH'));
    assert.ok(calls.length >= 1 && calls.every((l) => l.startsWith(`STUB-FETCH ${HACKATHON_BASE}/`) && /X-Api-Key/.test(l)));
  } finally { rmSync(d, { recursive: true, force: true }); cleanup(); }
});

// ---------------------------------------------------------------- G. the candidate file (agent-raters, UNSEALED) cannot be run
const CAND = join(ROOT, 'prereg/validity-prereg.CANDIDATE-UNSEALED.json');
const SKIP_CAND = { skip: !existsSync(CAND) && 'prereg candidate file is not part of the public repo' };
test('the candidate file is marked UNSEALED / CANDIDATE / agent-raters, carries the same rule as the code, and has Houston\'s slots empty', SKIP_CAND, () => {
  const raw = readFileSync(CAND, 'utf8');
  const p = parsePrereg(raw) as Prereg & { candidate: { markers: string[]; unresolved: { what: string }[] } };
  assert.equal(p.status, 'CANDIDATE-UNSEALED');
  assert.deepEqual(p.candidate.markers, ['UNSEALED', 'CANDIDATE', 'agent-raters']);
  assert.deepEqual(p.rule, { ...RULE });
  assert.equal(p.registeredAt, null);
  assert.match(p.raters.rater1 + p.raters.rater2, /AI model/);
  assert.deepEqual(p.items.filter((i) => i.city === 'Houston').map((i) => i.title), ['', '', '']);
  assert.ok(p.candidate.unresolved.some((u) => /^Houston/.test(u.what)) && p.candidate.unresolved.some((u) => /^Denver/.test(u.what)));
  assert.ok(p.notes[0]!.startsWith('CANDIDATE, UNSEALED, agent-raters'));
  const errs = validatePrereg(p, true);
  assert.ok(errs.includes('status is CANDIDATE-UNSEALED, a run needs SEALED'));
  assert.ok(errs.some((e) => /Houston: the \w+ title is empty/.test(e)));
});

test('the candidate fails the live gate: dry run with its hash reports it would refuse; --live and --synthetic refuse (exit 5) with the right hash, and exit 4 without one; nothing is called or written; no key is printed', SKIP_CAND, () => {
  const sha = sha256Hex(readFileSync(CAND, 'utf8'));
  const dry = cli(['--prereg', CAND, '--expected-sha256', sha, '--dry-run'], { QLOO_API_KEY: FAKE_KEY });
  assert.equal(dry.status, 0, dry.all);
  assert.match(dry.out, new RegExp(`SHA-256: ${sha}`));
  assert.match(dry.out, /status: CANDIDATE-UNSEALED/);
  assert.match(dry.out, /expected hash: supplied and matches/);
  assert.match(dry.out, /Planned API calls: \d+/);
  assert.match(dry.out, /A real run would refuse today: \d+ problem\(s\), first: status is CANDIDATE-UNSEALED, a run needs SEALED/);
  for (const mode of ['--live', '--synthetic']) {
    const r = cli(['--prereg', CAND, '--expected-sha256', sha, mode], { QLOO_API_KEY: FAKE_KEY });
    assert.equal(r.status, 5, r.all); assert.match(r.err, /REFUSING TO RUN: the pre-registration file is not valid/); assert.match(r.err, /status is CANDIDATE-UNSEALED/);
    assert.ok(!r.all.includes(FAKE_KEY) && !r.all.includes('STUB-FETCH')); assert.deepEqual(r.wrote, []);
    const nohash = cli(['--prereg', CAND, mode], { QLOO_API_KEY: FAKE_KEY });
    assert.equal(nohash.status, 4); assert.deepEqual(nohash.wrote, []);
  }
});
