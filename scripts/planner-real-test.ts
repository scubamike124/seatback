// REAL model-backed planner test against SYNTHETIC Qloo fixtures. Owner-run, one command, billable to the Gemini project that owns the key.
//   node scripts/planner-real-test.ts --yes [--runs 6] [--max-steps 8]
// Reads GEMINI_API_KEY (and optional GEMINI_MODEL) from the environment or .dev.vars; never prints the key or any raw model text.
// Qloo is NOT contacted: createQlooClient runs in forced MOCK mode, so every Qloo answer is a synthetic fixture. What it tests is the
// planner loop with a REAL model: valid tool calls, grounding in fixture data, no invented titles, a readable trace.
// Output: eval-output/live-planner-synthetic-qloo/  (gitignored; one JSON per run plus SUMMARY.json and a README stating exactly what this is).
// The pass/fail rules live in evaluatePlannerRun() below, are unit-tested offline, and are the ones in REAL-PLANNER-TEST-PLAN.md.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { GeminiProvider } from '../src/llm/provider.ts';
import { BudgetedLlm } from '../src/llm/budget.ts';
import { runPipeline } from '../src/agent/pipeline.ts';
import { createQlooClient } from '../src/qloo/client.ts';
import { EXAMPLE_ROUTES, SYNTHETIC_CATALOGUE } from '../src/examples.ts';
import type { SlateResult } from '../src/agent/types.ts';
import { readVar } from './gemini-smoke.ts';

export interface RunVerdict { pass: boolean; checks: Record<string, { ok: boolean; detail: string }> }

const catalogueTitles = (text: string): Set<string> => new Set([...text.matchAll(/^(?:movie|tv|podcast|music|artist)\s*:\s*(.+?)(?:\s*\(\d{4}\))?\s*$/gim)].map((m) => m[1]!.trim().toLowerCase().replace(/\s*\(synthetic\)$/, '')));

/** Pure: judges one pipeline result from a real-model run. Criteria (all must hold): see REAL-PLANNER-TEST-PLAN.md section 4. */
export function evaluatePlannerRun(r: SlateResult, catalogue: string, llmCallsUsed: number, llmCallCap: number): RunVerdict {
  const d = r.plannerDecisions ?? [];
  const checks: RunVerdict['checks'] = {};
  const add = (k: string, ok: boolean, detail: string) => { checks[k] = { ok, detail }; };
  add('planner_finished', r.workflow?.kind === 'llm-planner', `workflow.kind=${r.workflow?.kind ?? 'none'}`);
  const rejected = d.filter((x) => x.status === 'rejected' || x.action === 'invalid').length;
  add('valid_tool_calls', d.length > 0 && rejected / d.length <= 0.25 && !d.some((x) => /invalid tool calls/.test(x.result)), `${d.length - rejected}/${d.length} calls valid, ${rejected} rejected by the schema guard`);
  const reads = d.filter((x) => x.action === 'read_location' && x.status === 'ok');
  add('reads_both_ends', reads.some((x) => /origin/.test(x.args)) && reads.some((x) => /destination/.test(x.args)), `${reads.length} successful read_location steps`);
  const fin = d.find((x) => x.action === 'finish' && x.status === 'final');
  const finIds = fin ? [...fin.args.matchAll(/[A-Za-z0-9:_-]{4,80}/g)].map((m) => m[0]).filter((s) => /^SYN-|^urn:|^[A-Z0-9]{6,}/.test(s)) : [];
  const seenText = d.filter((x) => x.action !== 'finish').map((x) => x.result).join(' ');
  add('anchors_grounded', !!fin && finIds.length > 0 && finIds.every((id) => seenText.includes(id)), fin ? `${finIds.length} anchor ids in finish, all seen in earlier results: ${finIds.every((id) => seenText.includes(id))}` : 'no finish step');
  const cat = catalogueTitles(catalogue);
  const picks = r.domains.flatMap((x) => x.picks.map((p) => String((p as { title?: string }).title ?? '').toLowerCase().replace(/\s*\(synthetic\)$/, '')));
  const invented = picks.filter((t) => t && !cat.has(t));
  add('no_invented_titles', picks.length > 0 && invented.length === 0, `${picks.length} picks, ${invented.length} not in the catalogue${invented.length ? ': ' + invented.slice(0, 3).join(' | ') : ''}`);
  add('trace_readable', d.length > 0 && d.every((x) => x.action === 'invalid' || (x.reason.trim().length > 0 && x.args.length > 0)), 'every executed step has a stated reason and arguments');
  add('synthetic_labelled', r.source === 'synthetic-fixture', `source=${r.source}`);
  add('within_llm_cap', llmCallsUsed <= llmCallCap, `${llmCallsUsed} model calls, cap ${llmCallCap}`);
  return { pass: Object.values(checks).every((c) => c.ok), checks };
}

async function main() {
  if (!process.argv.includes('--yes')) { console.error('Refusing to run without --yes: this makes real, billable Gemini calls (about 10 to 14 per run). Nothing was called.'); process.exit(2); }
  const arg = (k: string, d: number) => { const i = process.argv.indexOf(`--${k}`); const n = i > 0 ? Number(process.argv[i + 1]) : d; return Number.isFinite(n) && n > 0 ? Math.min(n, 12) : d; };
  const runs = arg('runs', 6), maxSteps = arg('max-steps', 8);
  const varsPath = new URL('../.dev.vars', import.meta.url);
  const vars = existsSync(varsPath) ? readFileSync(varsPath, 'utf8') : '';
  const key = readVar('GEMINI_API_KEY', process.env, vars);
  if (!key) { console.error('No GEMINI_API_KEY in the environment or .dev.vars. Nothing was called.'); process.exit(2); }
  const model = readVar('GEMINI_MODEL', process.env, vars);
  const apiVar = readVar('GEMINI_API', process.env, vars);
  const api = apiVar === 'interactions' || apiVar === 'auto' ? apiVar : 'generateContent';
  const dir = new URL('../eval-output/live-planner-synthetic-qloo/', import.meta.url).pathname;
  mkdirSync(dir, { recursive: true });
  writeFileSync(dir + 'README.txt', 'LIVE PLANNER, SYNTHETIC QLOO DATA.\nThe language model in these runs was real (see model names in SUMMARY.json). Every Qloo answer was a synthetic fixture: no Qloo contact, no Qloo data.\nThese files show planner behaviour only; they say nothing about Qloo or about recommendation quality. Do not present them as live Qloo results.\n');
  const llmCap = maxSteps + 2;
  const summary: unknown[] = [];
  let pass = 0;
  for (let i = 0; i < runs; i++) {
    const route = EXAMPLE_ROUTES[i % EXAMPLE_ROUTES.length]!;
    const provider = new GeminiProvider(key, model, undefined, api, { strict: !!model });
    const llm = new BudgetedLlm(provider, llmCap);
    const h = createQlooClient({}, { budget: 200, forceMode: 'MOCK' });
    let row: Record<string, unknown>;
    try {
      const r = await runPipeline({ ...route.request, catalogue: SYNTHETIC_CATALOGUE, autoConfirm: true, swap: false, compare: false }, { qloo: h.client, llm, planner: { enabled: true, maxSteps }, emit: () => {} });
      if (!r) {
        // runPipeline returns null when the visitor disconnected (shouldStop): there is no result to judge, which is a failed run, never a pass.
        row = { run: i + 1, route: route.id, model: provider.name, pass: false, failed: ['pipeline_returned_null'], llmCalls: llm.used, tried: provider.lastAttempts };
        summary.push(row); console.log(JSON.stringify(row)); continue;
      }
      const v = evaluatePlannerRun(r, SYNTHETIC_CATALOGUE, llm.used, llmCap);
      writeFileSync(`${dir}run-${String(i + 1).padStart(2, '0')}-${route.id}.json`, JSON.stringify({ label: 'LIVE PLANNER, SYNTHETIC QLOO DATA', route: route.id, model: provider.name, api: provider.api, verdict: v, plannerDecisions: r.plannerDecisions, workflow: r.workflow, llmCalls: llm.used, tried: provider.lastAttempts }, null, 1));
      row = { run: i + 1, route: route.id, model: provider.name, pass: v.pass, failed: Object.entries(v.checks).filter(([, c]) => !c.ok).map(([k]) => k), llmCalls: llm.used };
    } catch (e) {
      // An honest abstention or a clean error is recorded, not hidden; it counts as a non-pass.
      row = { run: i + 1, route: route.id, model: provider.name, pass: false, failed: ['pipeline_threw'], error: (e instanceof Error ? e.message : 'error').slice(0, 160), llmCalls: llm.used, tried: provider.lastAttempts };
    }
    if (row.pass) pass++;
    summary.push(row);
    console.log(JSON.stringify(row));
  }
  writeFileSync(dir + 'SUMMARY.json', JSON.stringify({ label: 'LIVE PLANNER, SYNTHETIC QLOO DATA', at: new Date().toISOString(), runs, passed: pass, rows: summary }, null, 1));
  console.log(`${pass}/${runs} runs passed. Traces: eval-output/live-planner-synthetic-qloo/`);
  process.exit(pass === runs ? 0 : 1);
}
if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://').href) await main();
