// Records the three judge-mode examples on THIS machine and saves each result as the exact text the Worker
// serves from KV, so a deployment never needs to run the agent (the Workers free plan allows 10 ms CPU and
// 50 subrequests per request; one run takes more of both).
//
//   node scripts/export-examples.ts --live [--dry-run]       needs QLOO_API_KEY (environment or .dev.vars)
//   node scripts/export-examples.ts --synthetic [--dry-run]  fixtures only; for testing the path
//   add --data-dir <DATA_DIR> to also store each recorded example in the Node host's private file store
//   (npm run record:examples = --live; needs QLOO_API_KEY, and GEMINI_API_KEY if you want the planner recorded)
//
// Output: .private/examples/example-<live|synthetic>-<id>.json (gitignored). The live files contain
// Qloo-derived data: they go only into the owner's private KV namespace, never into a repository.
// The script prints the upload commands; it runs none of them.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordable, trimForRecording } from '../src/export.ts';
import { BudgetedLlm, DEFAULT_EXAMPLE_LLM_CALLS } from '../src/llm/budget.ts';
import { privateExamplePath } from './private-paths.ts';
import { FileStore } from '../src/storage/file-store.ts';
import { runPipeline } from '../src/agent/pipeline.ts';
import { EXAMPLE_ROUTES, LIVE_SAMPLE_CATALOGUE, SYNTHETIC_CATALOGUE } from '../src/examples.ts';
import { makeQloo, type Env } from '../src/worker.ts';
import { providerFromEnv } from '../src/llm/provider.ts';
import { blockNetwork, dryRunLines, findKey, isDryRun, requireKey } from './live-guard.ts';

const live = process.argv.includes('--live');
const synthetic = process.argv.includes('--synthetic');
if (live === synthetic) {
  console.error('Choose exactly one of --live or --synthetic (add --dry-run to see the plan only).');
  process.exit(1);
}
const mode = live ? 'live' : 'synthetic';
const varsPath = new URL('../.dev.vars', import.meta.url);
const root = fileURLToPath(new URL('..', import.meta.url));
const fileFor = (id: string) => `example-${mode}-${id}.json`;

if (isDryRun(process.argv)) {
  blockNetwork();
  const gi = new URL('../.gitignore', import.meta.url);
  for (const l of dryRunLines({
    script: `scripts/export-examples.ts --${mode}`,
    keyPresent: !!findKey(process.env, varsPath),
    plan: [`run the ${EXAMPLE_ROUTES.length} judge-mode examples (${EXAMPLE_ROUTES.map((r) => r.id).join(', ')}) ${live ? 'against the live Qloo API' : 'on synthetic fixtures'}`, 'save each result as the text the Worker serves from KV', 'print (not run) the wrangler commands that upload them'],
    outputFiles: EXAMPLE_ROUTES.map((r) => `.private/examples/${fileFor(r.id)}`),
    gitignoreText: existsSync(gi) ? readFileSync(gi, 'utf8') : '',
  })) console.log(l);
  process.exit(0);
}

const env: Env = live ? { QLOO_API_KEY: requireKey(process.env, varsPath) } : { FORCE_SYNTHETIC: '1' };
env.SCORING_MODE = process.env.SCORING_MODE;
env.GEMINI_API_KEY = process.env.GEMINI_API_KEY;
env.LLM_PROVIDER = process.env.LLM_PROVIDER;
env.GEMINI_MODEL = process.env.GEMINI_MODEL;

const inner = providerFromEnv(env);
const plannerEnabled = process.env.PLANNER_ENABLED !== '0';
const cmds: string[] = [];
for (const r of EXAMPLE_ROUTES) {
  const result = await runPipeline(
    { ...r.request, catalogue: live ? LIVE_SAMPLE_CATALOGUE : SYNTHETIC_CATALOGUE, autoConfirm: true },
    { qloo: makeQloo(env, 200), llm: inner ? new BudgetedLlm(inner, Number(process.env.EXAMPLE_LLM_CALLS) || DEFAULT_EXAMPLE_LLM_CALLS) : null, planner: { enabled: plannerEnabled }, emit: () => {}, scoringMode: env.SCORING_MODE === 'pinned' ? 'pinned' : 'anchored' },
  );
  if (!result) { console.log(`${r.id}: needs confirmation, not saved`); continue; }
  // Same gate as the Worker's recorder: complete, and made by the method the example claims. Then trim, then write under .private/ only.
  const gate = recordable(result, { llmConfigured: !!inner, plannerEnabled });
  if (!gate.ok) { console.log(`${r.id}: NOT SAVED: ${gate.why}`); continue; }
  const file = privateExamplePath(root, mode, r.id);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(trimForRecording(result)));
  console.log(`${r.id}: saved ${fileFor(r.id)} (${result.metrics.qlooCalls} Qloo calls)`);
  const dd = process.argv.indexOf('--data-dir');
  if (dd >= 0 && process.argv[dd + 1]) {
    // Node/Railway host: write straight into the host's file store so the app replays it as provenance "stored-recording".
    await new FileStore(process.argv[dd + 1]!).put(`example:${mode}:${r.id}`, JSON.stringify(trimForRecording(result)));
    console.log(`${r.id}: stored in the file store at ${process.argv[dd + 1]}`);
  }
  cmds.push(`npx wrangler kv key put --binding CACHE_KV --remote "example:${mode}:${r.id}" --path .private/examples/${fileFor(r.id)}`);
}
console.log(`\nUpload (owner, after the KV id is in wrangler.toml). Not run by this script:\n${cmds.join('\n')}`);
