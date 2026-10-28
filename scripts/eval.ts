// Evaluation. Headline: the home-direction validity check (src/agent/validity.ts): do titles
// hand-coded to a city rank higher with that city's anchors than with the other end's, against a
// shuffled-anchor null? Secondary: route sensitivity (does the slate change when the route
// changes?) for Seatback vs the baseline, and invented titles by the baseline.
// On synthetic fixtures the direction check is EXPECTED to be near chance: the fixture world has
// no real hometowns. Only the --live numbers mean anything.
//
// Usage: node scripts/eval.ts            (synthetic fixtures; numbers are labelled synthetic)
//        node scripts/eval.ts --live     (key from QLOO_API_KEY or .dev.vars; refuses with exit 2 if there is none)
//        add --dry-run to either to see the plan without any network call or file write
// Output: eval-output/ (gitignored, because live output contains Qloo-derived data).
import { mkdirSync, writeFileSync } from 'node:fs';
import { FixtureQlooClient } from '../src/qloo/fixture-client.ts';
import { HttpQlooClient } from '../src/qloo/http-client.ts';
import { MemoryCache } from '../src/qloo/cache.ts';
import { runPipeline } from '../src/agent/pipeline.ts';
import { slateOverlap } from '../src/agent/scoring.ts';
import { providerFromEnv } from '../src/llm/provider.ts';
import { LIVE_SAMPLE_CATALOGUE, SYNTHETIC_CATALOGUE } from '../src/examples.ts';
import { normalizeTitle } from '../src/agent/catalogue.ts';
import type { SlateResult } from '../src/agent/types.ts';
import { directionCheck, directionPasses } from '../src/agent/validity.ts';
import { parseCatalogue } from '../src/agent/catalogue.ts';
import { blockNetwork, dryRunLines, findKey, isDryRun, requireKey } from './live-guard.ts';
import { existsSync, readFileSync } from 'node:fs';

const live = process.argv.includes('--live');
const varsPath = new URL('../.dev.vars', import.meta.url);
if (isDryRun(process.argv)) {
  blockNetwork();
  const gi = new URL('../.gitignore', import.meta.url);
  for (const l of dryRunLines({
    script: `scripts/eval.ts${live ? ' --live' : ''}`,
    keyPresent: !!findKey(process.env, varsPath),
    plan: live
      ? ['run the pipeline on 6 routes against the live Qloo API, then the home-direction validity check', 'print the report and write it to the private folder']
      : ['run the pipeline on 6 routes against the SYNTHETIC fixtures (no Qloo call), labelled as synthetic'],
    outputFiles: [`eval-output/eval-${live ? 'live' : 'synthetic'}.json`],
    gitignoreText: existsSync(gi) ? readFileSync(gi, 'utf8') : '',
  })) console.log(l);
  process.exit(0);
}
const liveKey = live ? requireKey(process.env, varsPath) : undefined;
const ROUTES: [string, string, number][] = [
  ['Minneapolis', 'Orlando', 0.6],
  ['Atlanta', 'Seattle', 0.5],
  ['Miami', 'Denver', 0.4],
  ['Boston', 'Las Vegas', 0.5],
  ['Chicago', 'Honolulu', 0.5],
  ['Dallas', 'New York', 0.5],
];
const cache = new MemoryCache(5000);
const llm = providerFromEnv({ ...(process.env as Record<string, string | undefined>) } as Parameters<typeof providerFromEnv>[0]);
const results: { route: string; r: SlateResult }[] = [];
for (const [o, d, w] of ROUTES) {
  const qloo = live ? new HttpQlooClient({ apiKey: liveKey!, cache }) : new FixtureQlooClient();
  const r = await runPipeline(
    { origin: o, destination: d, originShare: w, catalogue: live ? LIVE_SAMPLE_CATALOGUE : SYNTHETIC_CATALOGUE, autoConfirm: true },
    { qloo, llm, emit: () => {} },
  );
  if (r) results.push({ route: `${o}-${d}`, r });
}
const mean = (l: (number | null)[]) => { const x = l.filter((v): v is number => v !== null); return x.length ? x.reduce((a, b) => a + b, 0) / x.length : null; };
const seatIds = (r: SlateResult) => r.domains.flatMap((d) => d.picks.map((p) => normalizeTitle(p.title)));
const baseIds = (r: SlateResult) => Object.values(r.comparison?.picks ?? {}).flat().map(normalizeTitle);
let sOverlap = 0;
let bOverlap = 0;
let n = 0;
for (let i = 0; i < results.length; i++) {
  for (let j = i + 1; j < results.length; j++) {
    sOverlap += slateOverlap(seatIds(results[i]!.r), seatIds(results[j]!.r));
    bOverlap += slateOverlap(baseIds(results[i]!.r), baseIds(results[j]!.r));
    n++;
  }
}
function pairOverlap(ids: (r: SlateResult) => string[]): number | null {
  let t = 0, c = 0;
  for (let i = 0; i < results.length; i++) for (let j = i + 1; j < results.length; j++) { const a = ids(results[i]!.r), b = ids(results[j]!.r); if (a.length && b.length) { t += slateOverlap(a, b); c++; } }
  return c ? t / c : null;
}
const dirClient = live ? new HttpQlooClient({ apiKey: liveKey!, cache }) : new FixtureQlooClient();
const filler: Record<string, string[]> = {};
for (const it of parseCatalogue(live ? LIVE_SAMPLE_CATALOGUE : SYNTHETIC_CATALOGUE, 40).items) (filler[it.domain] ??= []).push(it.title);
const dir = await directionCheck(dirClient, [['Minneapolis', 'Orlando'], ['Atlanta', 'Seattle'], ['Miami', 'Denver']], { recencyYear: new Date().getUTCFullYear() - 3, filler });
const report = {
  source: live ? 'qloo-live' : 'SYNTHETIC FIXTURES (not evidence of anything about Qloo)',
  headline_directionCheck: { homeWins: dir.k, comparisons: dir.n, clusters: dir.clusters, permutationP: dir.p, binomialP_optimistic: dir.pBinomial, nullAllOtherCities: `${dir.nullK}/${dir.nullN}`, passes: directionPasses(dir) },
  baselines_ran: results[0]?.r.comparison?.ran ?? 'none',
  // Mean route fit is on Qloo's own scale, which Seatback optimises: circular, not evidence.
  meanRouteFit_CIRCULAR: {
    seatback: mean(results.map((x) => x.r.comparison?.meanFitSeatback ?? null)),
    ...Object.fromEntries(['newest', 'popularity', 'generic-taste', 'llm'].map((id) => [id, mean(results.map((x) => x.r.comparison?.baselines.find((b) => b.id === id)?.meanFit ?? null))])),
  },
  // Route sensitivity is the comparison that is not circular: route-blind baselines are 1 by construction.
  meanSlateOverlapByBaseline: Object.fromEntries(['newest', 'popularity', 'generic-taste', 'llm'].map((id) => [id, pairOverlap((r) => Object.values(r.comparison?.baselines.find((b) => b.id === id)?.picks ?? {}).flat().map(normalizeTitle))])),
  routes: results.length,
  meanSlateOverlapAcrossRoutes: { seatback: sOverlap / n, primaryBaseline: bOverlap / n },
  inventedTitlesByLlmBaseline: llm ? results.reduce((s, x) => s + (x.r.comparison?.baselines.find((b) => b.id === 'llm')?.inventedTitles.length ?? 0), 0) : 'no LLM baseline ran (no key)',
  groundingRate: results.map((x) => x.r.grounding.rate),
  qlooCallsPerRun: results.map((x) => x.r.metrics.qlooCalls),
  abstentions: results.map((x) => x.r.domains.filter((d) => d.abstained).map((d) => d.label)),
};
console.log(JSON.stringify(report, null, 2));
mkdirSync(new URL('../eval-output/', import.meta.url), { recursive: true });
writeFileSync(new URL(`../eval-output/eval-${live ? 'live' : 'synthetic'}.json`, import.meta.url), JSON.stringify(report, null, 2));
