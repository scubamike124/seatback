// Generates REQUEST-TO-RESULT.md from a run. Default is MOCK (or DRY-RUN with --dry-run); LIVE only
// if QLOO_API_KEY is in the environment AND --live is passed. Output goes to eval-output/ (gitignored).
//   node scripts/request-to-result.ts [--live] [--dry-run] [--out path]
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { assertWritable } from './safe-path.ts';
import { createQlooClient } from '../src/qloo/client.ts';
import { buildRequestToResult } from '../src/qloo/report.ts';
import { runPipeline } from '../src/agent/pipeline.ts';
import { providerFromEnv } from '../src/llm/provider.ts';
import { EXAMPLE_ROUTES, LIVE_SAMPLE_CATALOGUE, SYNTHETIC_CATALOGUE } from '../src/examples.ts';
import { resolveLocality, resolveTag, type Resolution } from '../src/qloo/resolve.ts';

const args = process.argv.slice(2);
const live = args.includes('--live');
const env = live ? { QLOO_API_KEY: process.env.QLOO_API_KEY } : {};
if (live && !process.env.QLOO_API_KEY) {
  console.error('--live needs QLOO_API_KEY in the environment. Nothing was called.');
  process.exit(2);
}
const h = createQlooClient(env, { budget: 150, dryRun: args.includes('--dry-run') });
const choices: Resolution[] = [];
const loc = await resolveLocality(h.client, 'Orlando');
choices.push(loc);
choices.push(await resolveTag(h.client, 'holiday'));
const read = await h.client.insights({ domain: 'movie', location: loc.chosen ? { localityId: loc.chosen.id } : { query: 'Orlando' }, take: 5 });
// Use a REAL id returned by the read above (never a made-up one). No result, no trending call.
const topId = read.data.find((e) => e.entity_id)?.entity_id;
if (topId) await h.client.trending({ domain: 'movie', entityId: topId, startDate: '2026-09-01', endDate: '2026-10-01' });
// One full example run on the same client, so the report shows the planner's decisions (if an LLM is configured).
const ex = EXAMPLE_ROUTES[0]!;
const run = await runPipeline({ ...ex.request, catalogue: live ? LIVE_SAMPLE_CATALOGUE : SYNTHETIC_CATALOGUE, autoConfirm: true }, { qloo: h.client, llm: providerFromEnv({ GEMINI_API_KEY: process.env.GEMINI_API_KEY, LLM_PROVIDER: process.env.GEMINI_API_KEY ? 'gemini' : 'none' } as never), planner: { enabled: true }, emit: () => {} });
const md = buildRequestToResult(h, { workflow: run?.workflow?.label, plannerDecisions: run?.plannerDecisions, title: 'Seatback request to result', choices, secrets: [process.env.QLOO_API_KEY] });
const out = args.includes('--out') ? args[args.indexOf('--out') + 1]! : new URL('../eval-output/REQUEST-TO-RESULT.md', import.meta.url).pathname;
try { assertWritable(out); } catch (e) { console.error((e as Error).message); process.exit(1); }
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, md);
console.log(`[QLOO:${h.mode}] wrote ${out}. ${h.counter.line(h.mode)}`);
