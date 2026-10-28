// Measured Qloo-call baseline on the MOCK (fixture) client, per example route and per step, before and after
// the call-reduction work. EVERYTHING HERE IS MOCK: fixture calls, synthetic scores. It measures call counts
// and how much the fixture ranking changes, not Qloo's behaviour or quota.
//   node scripts/call-baseline.ts
import { FixtureQlooClient } from '../src/qloo/fixture-client.ts';
import { createQlooClient } from '../src/qloo/client.ts';
import { runPipeline } from '../src/agent/pipeline.ts';
import { EXAMPLE_ROUTES, SYNTHETIC_CATALOGUE } from '../src/examples.ts';
import type { SlateResult } from '../src/agent/types.ts';
import type { QlooClient } from '../src/qloo/types.ts';

const METHODS = ['searchLocality', 'searchTitle', 'insights', 'tasteAnalysis', 'demographics', 'trending', 'destinations', 'searchTags'] as const;

/** The pre-reduction behaviour: raw fixture client, every logical call counted, no memo. */
function rawCounting(): { client: QlooClient; counts: Record<string, number> } {
  const counts: Record<string, number> = {};
  const inner = new FixtureQlooClient({});
  const client = new Proxy(inner, {
    get(t, k, r) {
      const v = Reflect.get(t, k, r);
      if (typeof v === 'function' && (METHODS as readonly string[]).includes(String(k))) return (...a: unknown[]) => { counts[String(k)] = (counts[String(k)] ?? 0) + 1; return (v as Function).apply(t, a); };
      return typeof v === 'function' ? v.bind(t) : v;
    },
  }) as unknown as QlooClient;
  return { client, counts };
}

async function runBefore(ex: (typeof EXAMPLE_ROUTES)[number]) {
  const { client, counts } = rawCounting();
  const r = (await runPipeline({ ...ex.request, catalogue: SYNTHETIC_CATALOGUE, autoConfirm: true }, { qloo: client, llm: null, emit: () => {} }))!;
  return { r, counts, total: Object.values(counts).reduce((a, b) => a + b, 0) };
}
async function runAfter(ex: (typeof EXAMPLE_ROUTES)[number], mode: 'example' | 'noswap' | 'custom') {
  const h = createQlooClient({}, { budget: 1000 });
  const req = { ...ex.request, catalogue: SYNTHETIC_CATALOGUE, autoConfirm: true, ...(mode === 'custom' ? { swap: false, maxTitles: 20 } : mode === 'noswap' ? { swap: false } : {}) };
  const r = (await runPipeline(req, { qloo: h.client, llm: null, emit: () => {} }))!;
  const counts: Record<string, number> = {};
  for (const t of h.client.trace) if (!t.cached && !t.error) counts[t.call] = (counts[t.call] ?? 0) + 1;
  return { r, counts, total: h.counter.used };
}
const picks = (r: SlateResult) => r.domains.map((d) => new Set(d.picks.map((p) => p.title)));
function overlap(a: SlateResult, b: SlateResult): { jaccardPerDomain: string; kept: string } {
  const A = picks(a), B = picks(b);
  const per = A.map((s, i) => { const t = B[i] ?? new Set<string>(); const inter = [...s].filter((x) => t.has(x)).length; const uni = new Set([...s, ...t]).size; return uni ? (inter / uni).toFixed(2) : '1.00'; });
  const all = [...new Set(A.flatMap((s) => [...s]))], kept = all.filter((x) => B.some((t) => t.has(x))).length;
  return { jaccardPerDomain: per.join('/'), kept: `${kept}/${all.length}` };
}

console.log('MOCK DATA (fixture client). Calls = network-equivalent calls; memo hits are excluded in AFTER columns.');
console.log('| example | before (swap on, 34 titles, no memo) | after: examples (memo, swap on) | after: no swap, 34 titles | after: custom (no swap, 20 titles) | picks identical before vs no-swap? | picks kept by 20-title cap (Jaccard movie/tv/podcast/music) |');
console.log('|---|---|---|---|---|---|---|');
const detail: string[] = [];
for (const ex of EXAMPLE_ROUTES) {
  const b = await runBefore(ex), e = await runAfter(ex, 'example'), n = await runAfter(ex, 'noswap'), c = await runAfter(ex, 'custom');
  const same = overlap(b.r, n.r), cap = overlap(n.r, c.r);
  console.log(`| ${ex.id} | ${b.total} | ${e.total} | ${n.total} | ${c.total} | ${same.jaccardPerDomain === '1.00/1.00/1.00/1.00' ? 'yes' : 'NO ' + same.jaccardPerDomain} | ${cap.kept} kept; ${cap.jaccardPerDomain} |`);
  detail.push(`${ex.id} before: ${JSON.stringify(b.counts)}\n${ex.id} after custom: ${JSON.stringify(c.counts)}`);
}
console.log('\nPer-step counts (calls by method):\n' + detail.join('\n'));
