// MINIMAL LIVE QLOO PROBE (at most 5 calls). Proves three things and nothing else:
//   1. the key is accepted at https://hackathon.api.qloo.com (header X-Api-Key) and a real taste result comes back;
//   2. the answer is GENUINE LIVE data, not a stored example or a fixture;
//   3. nothing secret leaves the process (only redacted summaries are printed or written).
//
//   node scripts/qloo-minimal-probe.ts --dry-run     prints the plan; no key read, no network
//   node scripts/qloo-minimal-probe.ts --yes         the live run (needs QLOO_API_KEY in the environment or .dev.vars)
//
// Calls (sequential): C1 /search locality for a rare place; C2 the identical request again after 2.2 s (cache-bypass proof);
// C3 /v2/insights open location read (movie, take 3); C4 a deliberately unsupported request (urn:heatmap) to prove errors are
// clean; C5 is never used unless C1 fails to run. Abort at once on 401, 403 on C1-C3, 429 or 5xx. No retries (maxRetries 0).
// Output: a redacted summary only, to .private/qloo-minimal-probe-<time>.json (gitignored). No raw Qloo payload is written.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HttpQlooClient } from '../src/qloo/http-client.ts';
import { FixtureQlooClient } from '../src/qloo/fixture-client.ts';
import { entityProblems } from '../src/qloo/schema.ts';
import { containsSecret, redactSecrets } from '../src/qloo/redact.ts';
import { QlooError, type QlooEntity } from '../src/qloo/types.ts';
import { blockNetwork, dryRunLines, findKey, isDryRun, requireKey } from './live-guard.ts';

export const MAX_CALLS = 5;
/** The probe's call counter: runs before every HTTP attempt and throws on the (max+1)th. Exported so the tests exercise the exact code the probe uses. */
export function callCap(max: number = MAX_CALLS): { hook: () => void; used: () => number } {
  let n = 0;
  return { hook: () => { n++; if (n > max) throw new QlooError('probe call cap reached', 0, 'budget'); }, used: () => n };
}
export const SPACING_MS = 2200; // Date headers have 1-second resolution: wait longer than that between the identical calls
/** Response headers whose VALUES may be recorded (they cannot come from a fixture). Everything else: names only. */
const RECORD_HEADERS = ['date', 'server', 'via', 'x-request-id', 'x-amzn-requestid', 'x-amz-cf-id', 'cf-ray', 'x-cache', 'age', 'content-type', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'retry-after'];
/** Rare localities: none appears in the stored fixtures (the probe checks this against the repo text before use). */
export const PLACE_POOL = ['Fairbanks', 'Bozeman', 'Missoula', 'Santa Fe', 'Duluth', 'Asheville', 'Burlington', 'Juneau'];

export interface Check { id: string; ok: boolean; detail: string }
export interface CallRecord { n: number; label: string; path: string; params: Record<string, string>; status: number | string; ms: number; cached: boolean; source: string; headers: Record<string, string>; headerNames: string[]; bodySha256?: string; entities?: number }
export interface ProbeReport { at: string; place: string; calls: CallRecord[]; checks: Check[]; verdict: 'PASS' | 'FAIL' | 'ABORTED'; abortedBecause?: string }

export interface ProbeOptions {
  key: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  repoRoot: string;
  place?: string;
  log?: (line: string) => void;
}

const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

/** Text of the repo files a fixture or stored example could live in (src, test, docs, eval-output): a place name found here is not "fresh". */
function repoText(root: string): string {
  let out = '';
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      if (['node_modules', '.git', '.private', '.tmp-test'].includes(n)) continue;
      const p = join(d, n);
      const s = statSync(p);
      if (s.isDirectory()) walk(p);
      else if (/\.(ts|json|md|txt|mjs)$/.test(n) && s.size < 2_000_000 && !/qloo-minimal-probe/.test(n)) out += '\n' + readFileSync(p, 'utf8');
    }
  };
  for (const d of ['src', 'test', 'docs', 'eval-output', 'scripts']) if (existsSync(join(root, d))) walk(join(root, d));
  return out;
}

export async function runProbe(o: ProbeOptions): Promise<ProbeReport> {
  const log = o.log ?? ((l: string) => console.log(l));
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const rt = repoText(o.repoRoot);
  const place = o.place ?? PLACE_POOL.find((p) => !rt.toLowerCase().includes(p.toLowerCase())) ?? '';
  const report: ProbeReport = { at: new Date(now()).toISOString(), place, calls: [], checks: [], verdict: 'FAIL' };
  const add = (id: string, ok: boolean, detail: string) => { report.checks.push({ id, ok, detail: redactSecrets(detail, [o.key]) }); log(`  ${ok ? 'PASS' : 'FAIL'} ${id}: ${redactSecrets(detail, [o.key])}`); };
  if (!place) { report.verdict = 'ABORTED'; report.abortedBecause = 'every pool place already occurs in the repo text; add a rarer one'; return report; }

  // Recording fetch: sees only RESPONSES. It never logs or stores the request init (which holds the key).
  let last: { status: number; headers: Record<string, string>; names: string[] } | null = null;
  const inner = o.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const recording = (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const res = await inner(url, init);
    const headers: Record<string, string> = {};
    const names: string[] = [];
    res.headers.forEach((v, k) => { const lk = k.toLowerCase(); if (RECORD_HEADERS.includes(lk)) headers[lk] = redactSecrets(v, [o.key]).slice(0, 120); else names.push(lk); });
    last = { status: res.status, headers, names: names.sort() };
    return res;
  }) as typeof fetch;

  const cap = callCap();
  const client = new HttpQlooClient({
    apiKey: o.key, fetchImpl: recording, maxRetries: 0, timeoutMs: 12_000, maxConcurrent: 1, now,
    onNetworkCall: cap.hook,
    // no cache: every call must reach the network
  });

  const record = (n: number, label: string, r: { request: { path: string; params: Record<string, string> }; cached: boolean; ms: number; source: string; data: unknown }): CallRecord => {
    const l = last as { status: number; headers: Record<string, string>; names: string[] } | null;
    const c: CallRecord = { n, label, path: r.request.path, params: r.request.params, status: l?.status ?? 'none', ms: r.ms, cached: r.cached, source: r.source, headers: l?.headers ?? {}, headerNames: l?.names ?? [], bodySha256: sha(r.data), entities: Array.isArray(r.data) ? r.data.length : undefined };
    report.calls.push(c);
    log(`[C${n}] ${label}: HTTP ${c.status}, ${c.ms} ms, source ${c.source}, cached ${c.cached}, Date ${c.headers.date ?? 'MISSING'}, entities ${c.entities ?? '?'}`);
    return c;
  };
  const abort = (why: string): ProbeReport => { report.verdict = 'ABORTED'; report.abortedBecause = redactSecrets(why, [o.key]); log(`ABORTED: ${report.abortedBecause}`); return report; };
  const fixtures = new FixtureQlooClient();

  try {
    // C1
    const r1 = await client.searchLocality(place);
    const c1 = record(1, `/search locality "${place}"`, r1);
    // C2: identical request, after the Date resolution has passed
    await sleep(SPACING_MS);
    const r2 = await client.searchLocality(place);
    const c2 = record(2, 'identical repeat of C1', r2);
    // C3
    const r3 = await client.insights({ domain: 'movie', location: { query: place }, take: 3 });
    const c3 = record(3, `/v2/insights movie, signal.location.query "${place}"`, r3);

    // ---- genuine-vs-replay proof
    const d1 = Date.parse(c1.headers.date ?? ''), d2 = Date.parse(c2.headers.date ?? ''), t = now();
    add('live_mode', [r1, r2, r3].every((r) => r.source === 'qloo-live' && !r.cached), `source qloo-live and cached=false on C1-C3 (cache bypass: no cache object was given to the client)`);
    add('status_200', [c1, c2, c3].every((c) => c.status === 200), `HTTP ${[c1, c2, c3].map((c) => c.status).join('/')}`);
    add('server_date_headers', Number.isFinite(d1) && Number.isFinite(d2) && Math.abs(t - d1) < 600_000 && Math.abs(t - d2) < 600_000, `Date headers present and within 10 min of local time: C1 ${c1.headers.date ?? 'none'}, C2 ${c2.headers.date ?? 'none'}`);
    add('second_call_new_date', Number.isFinite(d1) && Number.isFinite(d2) && d2 > d1, `C2 Date is later than C1 Date (${Number.isFinite(d1) && Number.isFinite(d2) ? `${(d2 - d1) / 1000} s` : 'unknown'}); cache would repeat the stored header`);
    add('network_call_count', cap.used() === 3, `the client made ${cap.used()} network calls for 3 requests (no cache, no coalescing hit)`);
    const rtl = rt.toLowerCase();
    add('fresh_query_not_in_repo', !rtl.includes(place.toLowerCase()), `"${place}" occurs nowhere in src/test/docs/scripts/eval-output text, so no stored example or fixture can contain it`);
    const fx = await fixtures.searchLocality(place);
    add('differs_from_fixture', sha(r1.data) !== sha(fx.data) && sha(r3.data) !== sha((await fixtures.insights({ domain: 'movie', location: { query: place }, take: 3 })).data), 'response body hashes differ from the fixture client answer to the same requests');
    const all = [...(r1.data as QlooEntity[]), ...(r3.data as QlooEntity[])];
    add('no_synthetic_marks', all.length > 0 && all.every((e) => !/\(synthetic\)/i.test(String(e.name)) && !/^SYN-/.test(String(e.entity_id))), `${all.length} entities, none with "(synthetic)" or an SYN- id`);
    // ---- usable result + schema
    const probs = all.flatMap((e) => entityProblems(e));
    add('schema_valid', (r1.data as QlooEntity[]).length > 0 && (r3.data as QlooEntity[]).length > 0 && probs.length === 0, probs.length ? probs.slice(0, 3).join('; ') : `C1 ${(r1.data as QlooEntity[]).length} and C3 ${(r3.data as QlooEntity[]).length} entities, entity_id and name present`);
    add('taste_result_scored', (r3.data as QlooEntity[]).some((e) => typeof e.query?.affinity === 'number'), 'C3 returns at least one entity with a numeric query.affinity');
    add('stable_between_repeats', sha(r1.data) === sha(r2.data), 'C1 and C2 bodies identical (same question, same answer); informational, not a genuineness test');

    // ---- C4: clean error proof (expected 400/403/404 for an unsupported type)
    try {
      const r4 = await client.heatmap({ locationQuery: place, tagIds: ['urn:tag:genre:media:comedy'], take: 3 });
      record(4, 'negative test (urn:heatmap)', r4);
      add('error_path_exercised', false, 'the unsupported request returned HTTP 200; the clean-error behaviour was not exercised live (the offline fake-key tests cover it)');
    } catch (e) {
      const err = e as QlooError; const l = last as { status: number } | null;
      const text = `${err.name} ${err.message} ${err.stack ?? ''}`;
      report.calls.push({ n: 4, label: 'negative test (urn:heatmap)', path: '/v2/insights', params: { 'filter.type': 'urn:heatmap' }, status: l?.status ?? 'none', ms: 0, cached: false, source: 'qloo-live', headers: {}, headerNames: [] });
      log(`[C4] negative test: HTTP ${l?.status ?? 'none'}, error kind ${err.kind}`);
      add('error_is_clean', ['forbidden_type', 'bad_request', 'not_found'].includes(String(err.kind)) && !containsSecret(text, [o.key]) && !/x-api-key/i.test(text), `error kind ${err.kind}, message fixed, no key or header text`);
    }
    report.verdict = report.checks.every((c) => c.ok || c.id === 'stable_between_repeats') ? 'PASS' : 'FAIL';
  } catch (e) {
    const err = e as QlooError;
    const l = last as { status: number } | null;
    return abort(`${err.kind ?? 'error'} (HTTP ${l?.status ?? 'none'}) on a probe call; stopped, nothing retried: ${err.message}`);
  }
  return report;
}

/** Final choke point: nothing leaves the process if it still contains the key or a key shape. */
export function assertClean(text: string, key: string): void {
  if (containsSecret(text, [key])) throw new Error('A secret-shaped string was about to be printed or written; output suppressed.');
}

async function main() {
  const varsPath = new URL('../.dev.vars', import.meta.url);
  const root = new URL('..', import.meta.url).pathname;
  if (isDryRun(process.argv)) {
    blockNetwork();
    for (const l of dryRunLines({
      script: 'scripts/qloo-minimal-probe.ts', keyPresent: !!findKey(process.env, varsPath),
      plan: ['C1 /search locality (rare place), C2 identical repeat after 2.2 s, C3 /v2/insights open read (movie, take 3), C4 one unsupported request (expected clean error); at most 5 calls', 'abort on 401/429/5xx, no retries', 'prove genuine live data: source qloo-live, Date headers, new Date on the repeat, fresh query, differs from fixtures, no SYN- ids', 'print a redacted summary only'],
      outputFiles: ['.private/qloo-minimal-probe-<time>.json (redacted summary)'], gitignoreText: existsSync(new URL('../.gitignore', import.meta.url)) ? readFileSync(new URL('../.gitignore', import.meta.url), 'utf8') : '',
    })) console.log(l);
    return 0;
  }
  if (!process.argv.includes('--yes')) { console.error('Refusing to run without --yes: this makes up to 5 real calls against the event quota. Nothing was called.'); return 2; }
  const key = requireKey(process.env, varsPath);
  const lines: string[] = [];
  const rep = await runProbe({ key, repoRoot: root, log: (l) => lines.push(l) });
  const text = lines.join('\n') + '\n' + JSON.stringify(rep, null, 1);
  assertClean(text, key);
  for (const l of lines) console.log(l);
  console.log(`VERDICT: ${rep.verdict}${rep.abortedBecause ? ' (' + rep.abortedBecause + ')' : ''}`);
  const dir = new URL('../.private/', import.meta.url).pathname;
  mkdirSync(dir, { recursive: true });
  const f = `${dir}qloo-minimal-probe-${rep.at.replace(/[:.]/g, '-')}.json`;
  writeFileSync(f, JSON.stringify(rep, null, 1));
  console.log(`summary written to .private/${f.split('/').pop()}`);
  return rep.verdict === 'PASS' ? 0 : 1;
}
if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://').href) process.exit(await main());
