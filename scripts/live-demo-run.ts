// One capped live (or mock) run of the Minneapolis to Orlando example, to prove the whole Seatback flow on Qloo data.
//   node scripts/live-demo-run.ts --dry-run   prints the plan; reads no key value, makes no call, writes nothing
//   node scripts/live-demo-run.ts --mock      the same run on synthetic fixtures (no key, no network)
//   node scripts/live-demo-run.ts --live      needs QLOO_API_KEY in the environment; at most CAP requests, no retries
// Guarantees (see test/live-demo-run.test.ts): refuses to run live when an LLM is configured; the first 401/403/429/5xx stops the run;
// the key is never printed or written; output goes only to .private/ (gitignored); the console shows counts, never Qloo data.
import { mkdirSync, writeFileSync, existsSync, readFileSync, chmodSync } from 'node:fs';
import { createQlooClient } from '../src/qloo/client.ts';
import { runPipeline } from '../src/agent/pipeline.ts';
import { EXAMPLE_ROUTES, LIVE_SAMPLE_CATALOGUE } from '../src/examples.ts';
import { HACKATHON_BASE, NO_KEY_MESSAGE, EXIT_NO_KEY } from './live-guard.ts';

export const CAP = 90;
const args = process.argv.slice(2);
const mode = args.includes('--live') ? 'live' : args.includes('--dry-run') ? 'dry-run' : 'mock';

export function llmConfigured(env: Record<string, string | undefined>): boolean {
  return !!env.GEMINI_API_KEY || !!env.OPENAI_API_KEY || !!env.ANTHROPIC_API_KEY || (!!env.LLM_PROVIDER && env.LLM_PROVIDER !== 'none');
}

export const PLAN = [
  `Route: ${EXAMPLE_ROUTES[0]!.title}, the 36-title live sample catalogue, swap test off, planner off, no LLM.`,
  `Hard cap ${CAP} Qloo requests in total (the first /search doubles as the key check); retries off; 15 s timeout per request.`,
  `Base URL ${HACKATHON_BASE} only. The run stops at the first 401, 403, 429 or 5xx.`,
  'Console output: counts and statuses only. Files: .private/live-demo-summary-<time>.json and .private/live-demo-result-<time>.json (gitignored, mode 600).',
];

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  if (mode === 'dry-run') {
    console.log('DRY RUN of scripts/live-demo-run.ts: no network call, no file written, no key value read.');
    for (const l of PLAN) console.log('  - ' + l);
    console.log(`QLOO_API_KEY: ${process.env.QLOO_API_KEY ? 'present' : 'NOT SET (a live run would exit 2)'}`);
    console.log(`LLM configured: ${llmConfigured(process.env) ? 'YES (a live run would refuse)' : 'no'}`);
    console.log(`.private/ is gitignored: ${existsSync('.gitignore') && /^\.private\/$/m.test(readFileSync('.gitignore', 'utf8')) ? 'yes' : 'NO (a live run would refuse)'}`);
    process.exit(0);
  }
  const key = process.env.QLOO_API_KEY;
  if (mode === 'live') {
    if (!key) { console.error(NO_KEY_MESSAGE); process.exit(EXIT_NO_KEY); }
    if (llmConfigured(process.env)) { console.error('An LLM key or provider is configured. This run must have no LLM. Nothing was called.'); process.exit(3); }
    if (!(existsSync('.gitignore') && /^\.private\/$/m.test(readFileSync('.gitignore', 'utf8')))) { console.error('.private/ is not gitignored. Nothing was called.'); process.exit(3); }
  }
  const statuses: Record<string, number> = {};
  const dates: string[] = [];
  let stop = false;
  let stopReason = '';
  const fetchImpl: typeof fetch = async (input, init) => {
    const res = await fetch(input, init);
    statuses[res.status] = (statuses[res.status] ?? 0) + 1;
    const d = res.headers.get('date'); if (d && dates.length < 3) dates.push(d);
    if (res.status === 401 || res.status === 403 || res.status === 429 || res.status >= 500) { stop = true; stopReason = `HTTP ${res.status}`; }
    return res;
  };
  const h = mode === 'live'
    ? createQlooClient({ QLOO_API_KEY: key }, { budget: CAP, maxRetries: 0, timeoutMs: 15_000, fetchImpl, shouldStop: () => stop })
    : createQlooClient({}, { forceMode: 'MOCK', budget: CAP });
  const r = EXAMPLE_ROUTES[0]!;
  let result: unknown = null; let error = '';
  try {
    result = await runPipeline({ ...r.request, catalogue: LIVE_SAMPLE_CATALOGUE, autoConfirm: true, swap: false } as never, { qloo: h.client, llm: null, planner: { enabled: false }, emit: () => {} } as never);
  } catch (e) { error = e instanceof Error ? e.message : 'run failed'; }
  const text = JSON.stringify(result ?? {});
  const scrub = (s: string) => (key ? s.split(key).join('<key>') : s);
  const summary = {
    mode, at: new Date().toISOString(), calls: h.counter.used, cap: CAP, statuses, serverDates: dates, stopped: stop ? stopReason : null,
    completed: !!result && !error, error: scrub(error).slice(0, 200), syntheticMarks: (text.match(/\(synthetic\)/g) ?? []).length,
    keyInOutput: key ? text.includes(key) : false,
  };
  console.log(JSON.stringify(summary));
  if (mode === 'live') {
    mkdirSync('.private', { recursive: true });
    const t = summary.at.replace(/[:.]/g, '-');
    const sf = `.private/live-demo-summary-${t}.json`, rf = `.private/live-demo-result-${t}.json`;
    writeFileSync(sf, scrub(JSON.stringify(summary, null, 2)), { mode: 0o600 });
    writeFileSync(rf, scrub(text), { mode: 0o600 });
    chmodSync(sf, 0o600); chmodSync(rf, 0o600);
    console.log(`written: ${sf}, ${rf}`);
  }
  process.exit(summary.completed && !summary.keyInOutput ? 0 : 1);
}
