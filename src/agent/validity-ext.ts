/**
 * EXTENDED validity harness ("validity-ext"). A second, separate harness: the original check in
 * validity.ts and the probe's GO rule are untouched, so the owner can choose which one to run.
 *
 * What it adds (all offline-testable, nothing here needs live data):
 *  - a pre-registered item file (12 city clusters, 3 items per city, decoys, filler, a seeded or fixed
 *    null, the decision rule and a call budget), refused unless its SHA-256 matches a hash given in advance;
 *  - a call-budget wrapper that stops BEFORE the call that would exceed the limit;
 *  - one decision rule with three outcomes (GO, NO-GO, INCONCLUSIVE), written here in code and written
 *    again in the file; the run refuses if the two differ;
 *  - one entry sentence per outcome, each saying no more than the data supports.
 * Rationale, power analysis and the call budget belong to the pre-registration plan (not published in this repository). The items themselves are
 * chosen by two independent raters (a rater protocol that is not published here), never by the code or by whoever runs it.
 */
import { createHash } from 'node:crypto';
import type { Domain, InsightsRequest, QlooEntity, QlooResult } from '../qloo/types.ts';
import { type AnchorDomain, anchorSetsFor, openReadRequest, rankedAnchors } from './anchors.ts';
import { consensus } from './market.ts';
import { clusterPermutationP } from './validity.ts';

// ---------------------------------------------------------------- the decision rule (written here AND in the file)
export const RULE = {
  /** A cluster is usable when at least this many of its items were scored in both city readings. */
  clusterUsableMinItems: 2,
  /** Fewer usable clusters than this: INCONCLUSIVE. */
  minUsableClusters: 10,
  /** One-sided exact cluster sign-flip permutation p must be BELOW this. */
  maxP: 0.05,
  /** Pooled item success rate, in percent, must be AT LEAST this (integer arithmetic, no rounding). */
  minPooledRatePct: 65,
  /** Null rate, in percent, must be AT MOST this. */
  maxNullRatePct: 60,
  /** Two-sided exact binomial p on non-tied decoy comparisons below this: INCONCLUSIVE (end-preference). */
  decoyAlpha: 0.05,
} as const;
export type Rule = { -readonly [K in keyof typeof RULE]: number };

/** Stated in the entry text for NO-GO. From the pre-registration plan (simulation under assumed cluster variation). */
export const POWER_NOTE = 'In our pre-registration simulation (assumed cluster variation), a true per-title rate of 75% would have passed this rule about 82 to 85% of the time';

export type Outcome = 'GO' | 'NO-GO' | 'INCONCLUSIVE';
export type Reason = 'go' | 'conditions_failed' | 'too_few_clusters' | 'decoy_flag' | 'no_null_data' | 'budget';

export interface ClusterTally {
  id: string;
  k: number;
  n: number;
  /** Set by the runner from RULE.clusterUsableMinItems; `decide` trusts it. */
  usable: boolean;
}
export interface DecisionInput {
  clusters: ClusterTally[];
  /** Non-tied decoy comparisons: k = origin end ranked the decoy higher. */
  decoy: { k: number; n: number };
  nullK: number;
  nullN: number;
  budgetStopped?: boolean;
}
export interface Decision {
  outcome: Outcome;
  reason: Reason;
  /** Which GO conditions failed (NO-GO only). */
  failed: string[];
  totalClusters: number;
  usableClusters: number;
  k: number;
  n: number;
  ratePct: number | null;
  p: number | null;
  nullRatePct: number | null;
  decoy: { k: number; n: number; p: number | null };
}

/** Two-sided exact binomial p at 0.5 (doubling the smaller tail). */
export function twoSidedBinomial(k: number, n: number): number | null {
  if (n <= 0) return null;
  let lower = 0;
  let upper = 0;
  for (let i = 0; i <= n; i++) {
    const pr = choose(n, i) / 2 ** n;
    if (i <= k) lower += pr;
    if (i >= k) upper += pr;
  }
  return Math.min(1, 2 * Math.min(lower, upper));
}
function choose(n: number, k: number): number {
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - i + 1)) / i;
  return r;
}

/** The decision rule. Pure: the same input always gives the same outcome. */
export function decide(input: DecisionInput, rule: Rule = RULE): Decision {
  const used = input.clusters.filter((c) => c.usable && c.n > 0);
  const k = used.reduce((s, c) => s + c.k, 0);
  const n = used.reduce((s, c) => s + c.n, 0);
  const dp = twoSidedBinomial(input.decoy.k, input.decoy.n);
  const base = {
    totalClusters: input.clusters.length,
    usableClusters: used.length,
    k,
    n,
    ratePct: n ? (100 * k) / n : null,
    p: null as number | null,
    nullRatePct: input.nullN ? (100 * input.nullK) / input.nullN : null,
    decoy: { k: input.decoy.k, n: input.decoy.n, p: dp },
  };
  const out = (outcome: Outcome, reason: Reason, failed: string[] = []): Decision => ({ outcome, reason, failed, ...base });
  if (input.budgetStopped) return out('INCONCLUSIVE', 'budget');
  if (used.length < rule.minUsableClusters) return out('INCONCLUSIVE', 'too_few_clusters');
  if (dp !== null && dp < rule.decoyAlpha) return out('INCONCLUSIVE', 'decoy_flag');
  if (input.nullN <= 0) return out('INCONCLUSIVE', 'no_null_data');
  base.p = clusterPermutationP(used.map((c) => ({ k: c.k, n: c.n })));
  const failed: string[] = [];
  if (!(base.p < rule.maxP)) failed.push(`cluster permutation p ${fmtP(base.p)} is not below ${rule.maxP}`);
  if (!(100 * k >= rule.minPooledRatePct * n)) failed.push(`pooled success ${fmtPct(base.ratePct)} is below ${rule.minPooledRatePct}%`);
  if (!(100 * input.nullK <= rule.maxNullRatePct * input.nullN)) failed.push(`null rate ${fmtPct(base.nullRatePct)} is above ${rule.maxNullRatePct}%`);
  return failed.length ? out('NO-GO', 'conditions_failed', failed) : out('GO', 'go');
}

// ---------------------------------------------------------------- pre-registration file
export const DOMAINS3 = ['movie', 'tv_show', 'artist'] as const;
export type Domain3 = (typeof DOMAINS3)[number];
export type NullSpec = { mode: 'seeded'; count: number; seed: number } | { mode: 'fixed'; perRoute: Record<string, string[]> } | { mode: 'full' };
export interface Prereg {
  schemaVersion: 1;
  /** Only SEALED can be run. TEMPLATE is the blank form; CANDIDATE-UNSEALED is a filled draft awaiting human review and sealing. */
  status: 'TEMPLATE' | 'CANDIDATE-UNSEALED' | 'SEALED';
  /** A test file made of invented titles: usable only with --synthetic. */
  syntheticTestFile?: boolean;
  registeredAt: string | null;
  raters: { rater1: string; rater2: string; reconciliation: string };
  routes: [string, string][];
  items: { city: string; domain: Domain3; title: string; source?: string }[];
  decoys: { route: string; domain: Domain3; title: string }[];
  filler: Record<Domain3, string[]>;
  null: NullSpec;
  rule: Rule;
  budget: { maxCalls: number };
  recencyYear: number;
  notes: string[];
}

export const routeKey = (r: readonly [string, string]) => `${r[0]}|${r[1]}`;
export const isPlaceholder = (s: unknown) => typeof s !== 'string' || !s.trim() || /<<.*>>/.test(s);

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function parsePrereg(raw: string): Prereg {
  const p = JSON.parse(raw) as Prereg;
  if (!p || p.schemaVersion !== 1) throw new Error('not a validity-ext pre-registration file (schemaVersion 1 expected)');
  return p;
}

/** Everything that must be true before a run. `forRun` also demands a sealed, fully filled file. */
export function validatePrereg(p: Prereg, forRun: boolean): string[] {
  const e: string[] = [];
  if (forRun && p.status !== 'SEALED') e.push(`status is ${p.status}, a run needs SEALED`);
  if (forRun && !p.registeredAt) e.push('registeredAt is empty');
  if (forRun && (isPlaceholder(p.raters?.rater1) || isPlaceholder(p.raters?.rater2))) e.push('both raters must be named');
  const cities = p.routes.flat();
  if (p.routes.length !== 6) e.push(`6 routes are required, found ${p.routes.length}`);
  if (new Set(cities).size !== cities.length || cities.length !== 12) e.push('the routes must use 12 distinct cities (no city twice)');
  if (forRun && cities.some(isPlaceholder)) e.push('a city is still a placeholder');
  for (const c of cities) {
    for (const d of DOMAINS3) {
      const mine = p.items.filter((i) => i.city === c && i.domain === d);
      if (mine.length !== 1) e.push(`city ${c}: exactly one ${d} item is required, found ${mine.length}`);
      else if (forRun && isPlaceholder(mine[0]!.title)) e.push(`city ${c}: the ${d} title is empty`);
    }
  }
  const rk = new Set(p.routes.map(routeKey));
  for (const r of rk) if (p.decoys.filter((d) => d.route === r).length !== 2) e.push(`route ${r}: exactly 2 decoys are required`);
  for (const d of p.decoys) if (!rk.has(d.route)) e.push(`decoy for unknown route ${d.route}`);
  if (forRun) for (const d of p.decoys) if (isPlaceholder(d.title)) e.push(`decoy for ${d.route} has an empty title`);
  const all = [...p.items.map((i) => i.title), ...p.decoys.map((d) => d.title), ...DOMAINS3.flatMap((d) => p.filler[d] ?? [])].filter((t) => !isPlaceholder(t)).map((t) => t.trim().toLowerCase());
  if (new Set(all).size !== all.length) e.push('a title appears twice (items, decoys and filler must all differ)');
  if (forRun) for (const d of DOMAINS3) if ((p.filler[d] ?? []).length < 3) e.push(`filler for ${d} needs at least 3 titles`);
  const nl = p.null;
  if (nl.mode === 'seeded') {
    if (!Number.isInteger(nl.seed)) e.push('null.seed must be an integer fixed before the key arrives');
    if (!(nl.count >= 1 && nl.count <= 10)) e.push('null.count must be 1 to 10');
  } else if (nl.mode === 'fixed') {
    for (const r of rk) {
      const l = nl.perRoute[r];
      const ends = r.split('|');
      if (!l || !l.length) e.push(`fixed null: no cities for route ${r}`);
      else if (l.some((c) => ends.includes(c) || !cities.includes(c))) e.push(`fixed null for ${r} must be study cities that are not the route's own ends`);
    }
  } else if (nl.mode !== 'full') e.push('null.mode must be seeded, fixed or full');
  for (const key of Object.keys(RULE) as (keyof Rule)[]) if (p.rule?.[key] !== RULE[key]) e.push(`rule.${key} in the file (${String(p.rule?.[key])}) differs from the rule in code (${RULE[key]})`);
  const plan = planCalls(p);
  if (!(p.budget?.maxCalls >= plan.total)) e.push(`budget.maxCalls (${p.budget?.maxCalls}) is below the planned ${plan.total} calls`);
  return e;
}

// ---------------------------------------------------------------- seeded null and call planning
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/** The null cities for one route: deterministic from the file alone (same file, same list, every time). */
export function nullCitiesFor(p: Prereg, route: readonly [string, string]): string[] {
  const others = p.routes.flat().filter((c) => c !== route[0] && c !== route[1]).sort();
  const nl = p.null;
  if (nl.mode === 'full') return others;
  if (nl.mode === 'fixed') return [...(nl.perRoute[routeKey(route)] ?? [])];
  const rnd = mulberry32((nl.seed ^ fnv1a(routeKey(route))) >>> 0);
  const pool = [...others];
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [pool[i], pool[j]] = [pool[j]!, pool[i]!]; }
  return pool.slice(0, Math.min(nl.count, pool.length)).sort();
}

export interface CallPlan { open: number; resolves: number; scoring: number; total: number; fullNullTotal: number; assumedFiller: boolean }
/** Planned number of API calls. Matches the original check's formula, which reproduced the measured 176 calls. */
export function planCalls(p: Prereg, assumeFiller = 28): CallPlan {
  const cities = new Set(p.routes.flat());
  const key = (d: string, t: string, fb: string) => `${d}|${isPlaceholder(t) ? fb : t.trim().toLowerCase()}`;
  const titles = new Set<string>();
  let scoring = 0;
  let scoringFull = 0;
  let fillerCount = 0;
  for (const d of DOMAINS3) for (const t of p.filler?.[d] ?? []) if (!isPlaceholder(t)) fillerCount++;
  const assumed = fillerCount === 0;
  for (const i of p.items) titles.add(key(i.domain, i.title, `slot:${i.city}:${i.domain}`));
  p.decoys.forEach((d, n) => titles.add(key(d.domain, d.title, `decoy:${n}`)));
  for (const d of DOMAINS3) (p.filler?.[d] ?? []).forEach((t, n) => { if (!isPlaceholder(t)) titles.add(key(d, t, `filler:${d}:${n}`)); });
  for (const r of p.routes) {
    const others = cities.size - 2;
    const nullN = nullCitiesFor(p, r).length;
    for (const d of DOMAINS3) {
      const home = p.items.filter((i) => i.domain === d && (i.city === r[0] || i.city === r[1])).length + p.decoys.filter((x) => x.route === routeKey(r) && x.domain === d).length;
      if (!home) continue;
      scoring += 2 * (2 + nullN);
      scoringFull += 2 * (2 + others);
    }
  }
  const resolves = titles.size + (assumed ? assumeFiller : 0);
  const open = 3 * cities.size;
  return { open, resolves, scoring, total: open + resolves + scoring, fullNullTotal: open + resolves + scoringFull, assumedFiller: assumed };
}

// ---------------------------------------------------------------- budgeted client
export class BudgetExceeded extends Error {
  readonly used: number;
  readonly max: number;
  constructor(used: number, max: number) {
    super(`call budget of ${max} reached after ${used} calls; the next call was not made`);
    this.used = used;
    this.max = max;
  }
}
export interface ValidityClient {
  readonly source: 'qloo-live' | 'synthetic-fixture';
  searchTitle(query: string, domain: Domain): Promise<QlooResult<QlooEntity[]>>;
  insights(req: InsightsRequest): Promise<QlooResult<QlooEntity[]>>;
}
/** Counts every call and refuses the one that would exceed `max`, so the underlying client never sees it. */
export class BudgetedClient implements ValidityClient {
  readonly source: 'qloo-live' | 'synthetic-fixture';
  used = 0;
  readonly #inner: ValidityClient;
  readonly #max: number;
  constructor(inner: ValidityClient, max: number) { this.#inner = inner; this.#max = max; this.source = inner.source; }
  #take() { if (this.used + 1 > this.#max) throw new BudgetExceeded(this.used, this.#max); this.used++; }
  searchTitle(q: string, d: Domain) { this.#take(); return this.#inner.searchTitle(q, d); }
  insights(r: InsightsRequest) { this.#take(); return this.#inner.insights(r); }
}

// ---------------------------------------------------------------- the run
export interface ItemDetail { cluster: string; city: string; domain: Domain3; title: string; pctHome: number | null; pctAway: number | null; success: boolean | null; nullRate: number | null }
export interface ExtResult {
  harness: 'validity-ext v1';
  at: string;
  source: 'qloo-live' | 'synthetic-fixture';
  preregSha256: string;
  expectedSha256: string;
  registeredAt: string | null;
  decision: Decision;
  clusters: ClusterTally[];
  decoy: { k: number; n: number; ties: number };
  null: { k: number; n: number; cities: Record<string, string[]> };
  secondary: { artist: { k: number; n: number; p: number | null }; screen: { k: number; n: number; p: number | null } };
  calls: { used: number; max: number; planned: number };
  items: ItemDetail[];
  entrySentence: string;
}

export async function runExtendedValidity(client: ValidityClient, p: Prereg, opts: { sha256: string; expectedSha256: string; maxCalls?: number; now?: () => Date }): Promise<ExtResult> {
  const max = Math.min(p.budget.maxCalls, opts.maxCalls ?? Infinity);
  const bc = new BudgetedClient(client, max);
  const cities = [...new Set(p.routes.flat())];
  const open: Record<string, Record<AnchorDomain, QlooEntity[]>> = {};
  const ids = new Map<string, string | undefined>();
  const items: ItemDetail[] = [];
  const tally = new Map<string, ClusterTally>();
  const bySub = new Map<string, { k: number; n: number }>(); // `${view}|${cluster}`
  for (const r of p.routes) for (const c of r) tally.set(`${routeKey(r)}#${c}`, { id: `${routeKey(r)}#${c}`, k: 0, n: 0, usable: false });
  let decoyK = 0, decoyN = 0, decoyTies = 0, nullK = 0, nullN = 0;
  let budgetStopped = false;
  const nullUsed: Record<string, string[]> = {};
  try {
    for (const c of cities) {
      open[c] = {} as Record<AnchorDomain, QlooEntity[]>;
      for (const d of ['artist', 'tv_show', 'movie'] as AnchorDomain[]) open[c]![d] = (await bc.insights(openReadRequest(d, { query: c }, { recencyYear: p.recencyYear }))).data;
    }
    const resolve = async (title: string, d: Domain) => {
      const k = `${d}|${title}`;
      if (ids.has(k)) return ids.get(k);
      const r = await bc.searchTitle(title, d);
      const id = r.data[0]?.entity_id;
      ids.set(k, id);
      return id;
    };
    for (const r of p.routes) {
      const [x, y] = r;
      const rk = routeKey(r);
      const nullCities = nullCitiesFor(p, r);
      nullUsed[rk] = nullCities;
      const rankedFor = (c: string, other: string) =>
        Object.fromEntries((['artist', 'tv_show', 'movie'] as AnchorDomain[]).map((d) => [d, rankedAnchors(open[c]![d], open[other]![d])])) as Record<AnchorDomain, QlooEntity[]>;
      for (const d of DOMAINS3) {
        const home = p.items.filter((i) => i.domain === d && (i.city === x || i.city === y));
        const decoys = p.decoys.filter((q) => q.route === rk && q.domain === d);
        if (!home.length && !decoys.length) continue;
        const pinned: string[] = [];
        const idOf = new Map<string, string>();
        for (const t of [...home.map((i) => i.title), ...decoys.map((q) => q.title), ...(p.filler[d] ?? [])]) {
          const id = await resolve(t, d);
          if (id && !pinned.includes(id)) { pinned.push(id); idOf.set(t, id); }
        }
        if (pinned.length < 3) continue;
        const scoreWith = async (ranked: Record<AnchorDomain, QlooEntity[]>) => {
          const sets = anchorSetsFor(d, 0, ranked);
          const maps: Map<string, number>[] = [];
          for (const s of sets) {
            const res = await bc.insights({ domain: d, anchorEntityIds: s.entities.map((e) => e.entity_id!), onlyEntityIds: pinned, take: Math.min(50, pinned.length) });
            maps.push(new Map(res.data.filter((e) => typeof e.query?.affinity === 'number').map((e) => [e.entity_id!, e.query!.affinity!])));
          }
          return maps.length ? consensus(pinned, maps[0]!, maps[1]).pct : new Map<string, number>();
        };
        const px = await scoreWith(rankedFor(x, y));
        const py = await scoreWith(rankedFor(y, x));
        const pz: Map<string, number>[] = [];
        for (const z of nullCities) pz.push(await scoreWith(rankedFor(z, x)));
        for (const it of home) {
          const id = idOf.get(it.title);
          if (!id) continue;
          const a = (it.city === x ? px : py).get(id) ?? null;
          const b = (it.city === x ? py : px).get(id) ?? null;
          const cl = tally.get(`${rk}#${it.city}`)!;
          let success: boolean | null = null;
          if (a !== null && b !== null) {
            success = a > b; // strict: a tie is a failure, as in the original check
            cl.n++; if (success) cl.k++;
            const view = d === 'artist' ? 'artist' : 'screen';
            const s = bySub.get(`${view}|${cl.id}`) ?? { k: 0, n: 0 };
            s.n++; if (success) s.k++;
            bySub.set(`${view}|${cl.id}`, s);
          }
          let zw = 0, zn = 0;
          if (b !== null) for (const m of pz) { const z = m.get(id); if (z === undefined) continue; zn++; if (z > b) zw++; }
          nullK += zw; nullN += zn;
          items.push({ cluster: cl.id, city: it.city, domain: d, title: it.title, pctHome: a, pctAway: b, success, nullRate: zn ? zw / zn : null });
        }
        for (const q of decoys) {
          const id = idOf.get(q.title);
          const a = id ? px.get(id) : undefined;
          const b = id ? py.get(id) : undefined;
          if (a === undefined || b === undefined) continue;
          if (a > b) { decoyK++; decoyN++; } else if (a < b) decoyN++; else decoyTies++;
        }
      }
    }
  } catch (e) {
    if (e instanceof BudgetExceeded) budgetStopped = true;
    else throw e;
  }
  const clusters = [...tally.values()].map((c) => ({ ...c, usable: c.n >= p.rule.clusterUsableMinItems }));
  const decision = decide({ clusters, decoy: { k: decoyK, n: decoyN }, nullK, nullN, budgetStopped }, p.rule);
  const view = (v: 'artist' | 'screen') => {
    const cl = [...bySub.entries()].filter(([k]) => k.startsWith(`${v}|`)).map(([, s]) => s);
    const k = cl.reduce((s, c) => s + c.k, 0), n = cl.reduce((s, c) => s + c.n, 0);
    return { k, n, p: cl.length >= 2 && cl.length <= 16 ? clusterPermutationP(cl) : null };
  };
  const result: ExtResult = {
    harness: 'validity-ext v1', at: (opts.now ?? (() => new Date()))().toISOString(), source: client.source,
    preregSha256: opts.sha256, expectedSha256: opts.expectedSha256, registeredAt: p.registeredAt, decision, clusters,
    decoy: { k: decoyK, n: decoyN, ties: decoyTies }, null: { k: nullK, n: nullN, cities: nullUsed },
    secondary: { artist: view('artist'), screen: view('screen') }, calls: { used: bc.used, max, planned: planCalls(p).total }, items, entrySentence: '',
  };
  result.entrySentence = entrySentence(result);
  return result;
}

// ---------------------------------------------------------------- entry sentences (one per outcome)
const fmtP = (p: number | null) => (p === null ? 'n/a' : p < 0.001 ? 'p < 0.001' : `p = ${p.toFixed(3)}`);
const fmtPct = (x: number | null) => (x === null ? 'n/a' : `${x.toFixed(1)}%`);

/** Text for the Devpost entry. Says what the pre-registered rule produced and no more. */
export function entrySentence(r: Pick<ExtResult, 'source' | 'preregSha256' | 'registeredAt' | 'decision' | 'decoy' | 'secondary' | 'calls'>): string {
  const d = r.decision;
  const hash = r.preregSha256.slice(0, 12);
  const intro = `We fixed a test and its decision rule before any Qloo call (pre-registration file SHA-256 ${hash}${r.registeredAt ? `, registered ${r.registeredAt}` : ''}).`;
  const secondary = `Secondary views, which did not decide the outcome: artist items ${r.secondary.artist.k} of ${r.secondary.artist.n}, screen items ${r.secondary.screen.k} of ${r.secondary.screen.n}.`;
  let body: string;
  if (d.outcome === 'GO') {
    body = `${intro} On ${d.usableClusters} city clusters and ${d.n} hometown titles, ${d.k} of ${d.n} (${fmtPct(d.ratePct)}) ranked higher with their own city's anchors than with the other end's. Exact cluster permutation ${fmtP(d.p)}; null rate ${fmtPct(d.nullRatePct)}; decoy titles favoured the origin end in ${r.decoy.k} of ${r.decoy.n} non-tied comparisons. This shows that Qloo's affinities separate these cities for these titles. It does not show that a slate earns more viewing, that the method holds outside the US, or that route-level programming helps. ${secondary}`;
  } else if (d.outcome === 'NO-GO') {
    body = `${intro} The test did not pass: ${d.k} of ${d.n} (${fmtPct(d.ratePct)}) hometown titles ranked higher with their own city's anchors; exact cluster permutation ${fmtP(d.p)}; null rate ${fmtPct(d.nullRatePct)}. Not met: ${d.failed.join('; ')}. We therefore do not claim that Seatback reads cities correctly. ${POWER_NOTE}, so we cannot rule out a smaller effect. ${secondary}`;
  } else {
    const why: Record<Reason, string> = {
      too_few_clusters: `only ${d.usableClusters} of ${d.totalClusters} city clusters had enough titles scored (at least ${RULE.minUsableClusters} were required)`,
      decoy_flag: `the decoy titles, which belong to neither city, favoured one route end in ${d.decoy.k} of ${d.decoy.n} non-tied comparisons (two-sided p = ${d.decoy.p === null ? 'n/a' : d.decoy.p.toFixed(4)}), which indicates an end-preference unrelated to hometowns`,
      no_null_data: 'the null control produced no comparisons',
      budget: `the run reached its pre-registered limit of ${r.calls.max} calls before the analysis was complete (${r.calls.used} calls used)`,
      go: '',
      conditions_failed: '',
    };
    body = `${intro} The test could not be evaluated: ${why[d.reason]}. We make no claim either way about whether Seatback reads cities correctly.`;
  }
  return r.source === 'synthetic-fixture' ? `NOT FOR SUBMISSION: this run used synthetic fixtures, not Qloo data, and says nothing about Qloo. ${body}` : body;
}
