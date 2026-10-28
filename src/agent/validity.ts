/**
 * Home-direction validity check: the headline test of whether Seatback's method reads cities
 * correctly, and the core of the live probe's GO rule.
 *
 * Hypothesis: a title strongly associated with a city (hometown-coded, chosen by hand BEFORE any
 * Qloo call and listed below) ranks higher when the catalogue is scored with that city's anchors
 * than with the other route end's anchors.
 *
 * Statistics (pre-registered 2026-10-24, before any live call):
 * - Comparisons that share an anchor set are not independent, so p is NOT a per-title binomial.
 *   It is an exact sign-flip permutation test over clusters (route x home city): within a cluster
 *   every title shares the same two anchor sets, so the whole cluster's home/away labels flip
 *   together. With 6 clusters the smallest possible p is 1/64.
 * - Null rate: the same comparison with EVERY other demo city's anchors standing in for "home",
 *   averaged over all of them (not one hand-picked third city). It should be near 50%.
 * - The per-title binomial p is still reported, labelled as optimistic.
 *
 * It uses exactly the product's method: openReadRequest -> rankedAnchors -> anchorSetsFor ->
 * consensus. Nothing here is tuned on the results.
 */
import type { Domain, QlooClient, QlooEntity } from '../qloo/types.ts';
import { type AnchorDomain, anchorSetsFor, openReadRequest, rankedAnchors } from './anchors.ts';
import { consensus } from './market.ts';

export interface HometownItem {
  city: string;
  domain: Domain;
  title: string;
}

/** Hand-coded before any Qloo call. Public cultural associations, not Qloo data. */
export const HOMETOWN: HometownItem[] = [
  { city: 'Minneapolis', domain: 'artist', title: 'Prince' },
  { city: 'Minneapolis', domain: 'movie', title: 'Purple Rain' },
  { city: 'Minneapolis', domain: 'movie', title: 'Fargo' },
  { city: 'Minneapolis', domain: 'tv_show', title: 'The Mary Tyler Moore Show' },
  { city: 'Orlando', domain: 'artist', title: 'Backstreet Boys' },
  { city: 'Orlando', domain: 'artist', title: '*NSYNC' },
  { city: 'Orlando', domain: 'movie', title: 'The Florida Project' },
  { city: 'Atlanta', domain: 'artist', title: 'OutKast' },
  { city: 'Atlanta', domain: 'artist', title: 'Ludacris' },
  { city: 'Atlanta', domain: 'tv_show', title: 'Atlanta' },
  { city: 'Atlanta', domain: 'movie', title: 'Drumline' },
  { city: 'Seattle', domain: 'artist', title: 'Nirvana' },
  { city: 'Seattle', domain: 'artist', title: 'Pearl Jam' },
  { city: 'Seattle', domain: 'tv_show', title: 'Frasier' },
  { city: 'Seattle', domain: 'movie', title: 'Sleepless in Seattle' },
  { city: 'Miami', domain: 'artist', title: 'Gloria Estefan' },
  { city: 'Miami', domain: 'artist', title: 'Pitbull' },
  { city: 'Miami', domain: 'tv_show', title: 'Miami Vice' },
  { city: 'Miami', domain: 'movie', title: 'Moonlight' },
  { city: 'Denver', domain: 'artist', title: 'The Lumineers' },
  { city: 'Denver', domain: 'artist', title: 'Nathaniel Rateliff & The Night Sweats' },
  { city: 'Denver', domain: 'tv_show', title: 'South Park' },
];

export interface DirectionResult {
  k: number;
  n: number;
  /** Cluster sign-flip permutation p (the one the GO rule uses). */
  p: number;
  /** Per-title binomial p: optimistic because titles in a cluster share anchors. Reported only. */
  pBinomial: number;
  clusters: number;
  nullK: number;
  nullN: number;
  details: { route: string; title: string; home: string; pctHome: number | null; pctAway: number | null; nullRate: number | null; success: boolean | null }[];
  calls: number;
}

/** One-sided exact binomial p-value P(X >= k | n, 0.5). */
export function binomialP(k: number, n: number): number {
  let p = 0;
  for (let i = k; i <= n; i++) p += choose(n, i) / 2 ** n;
  return Math.min(1, p);
}
/**
 * Exact one-sided sign-flip permutation p over clusters: P(sum >= observed) when each cluster's
 * (successes, trials) may flip to (trials - successes, trials) with probability 1/2.
 */
export function clusterPermutationP(clusters: { k: number; n: number }[]): number {
  const used = clusters.filter((c) => c.n > 0);
  const observed = used.reduce((s, c) => s + c.k, 0);
  const total = 2 ** used.length;
  if (used.length > 16) throw new Error('too many clusters for exact enumeration');
  let atLeast = 0;
  for (let mask = 0; mask < total; mask++) {
    let s = 0;
    used.forEach((c, i) => (s += mask & (1 << i) ? c.n - c.k : c.k));
    if (s >= observed) atLeast++;
  }
  return used.length ? atLeast / total : 1;
}

function choose(n: number, k: number): number {
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - i + 1)) / i;
  return r;
}

export async function directionCheck(
  qloo: QlooClient,
  routes: [string, string][],
  opts: { recencyYear: number; filler?: Partial<Record<Domain, string[]>>; items?: HometownItem[] } = { recencyYear: 2023 },
): Promise<DirectionResult> {
  const items = opts.items ?? HOMETOWN;
  let calls = 0;
  const cities = [...new Set(routes.flat())];
  // Open reads (anchor domains only) per city.
  const open: Record<string, Record<AnchorDomain, QlooEntity[]>> = {};
  for (const c of cities) {
    open[c] = {} as Record<AnchorDomain, QlooEntity[]>;
    for (const d of ['artist', 'tv_show', 'movie'] as AnchorDomain[]) {
      const r = await qloo.insights(openReadRequest(d, { query: c }, { recencyYear: opts.recencyYear }));
      calls++;
      open[c]![d] = r.data;
    }
  }
  // Resolve hometown items and filler titles.
  const ids = new Map<string, string>();
  const resolve = async (title: string, d: Domain) => {
    const key = `${d}|${title}`;
    if (ids.has(key)) return ids.get(key);
    const r = await qloo.searchTitle(title, d);
    calls++;
    const id = r.data[0]?.entity_id;
    if (id) ids.set(key, id);
    return id;
  };
  const details: DirectionResult['details'] = [];
  const clusters = new Map<string, { k: number; n: number }>();
  let k = 0;
  let n = 0;
  let nullK = 0;
  let nullN = 0;
  for (const [x, y] of routes) {
    const rankedFor = (c: string, other: string) =>
      Object.fromEntries((['artist', 'tv_show', 'movie'] as AnchorDomain[]).map((d) => [d, rankedAnchors(open[c]![d], open[other]![d])])) as Record<AnchorDomain, QlooEntity[]>;
    const nullCities = cities.filter((c) => c !== x && c !== y);
    for (const d of ['movie', 'tv_show', 'artist'] as Domain[]) {
      const homeItems = items.filter((i) => i.domain === d && (i.city === x || i.city === y));
      if (!homeItems.length) continue;
      const pinned: string[] = [];
      for (const it of homeItems) {
        const id = await resolve(it.title, d);
        if (id) pinned.push(id);
      }
      for (const t of opts.filler?.[d] ?? []) {
        const id = await resolve(t, d);
        if (id && !pinned.includes(id)) pinned.push(id);
      }
      if (pinned.length < 3) continue;
      const scoreWith = async (ranked: Record<AnchorDomain, QlooEntity[]>) => {
        const sets = anchorSetsFor(d, 0, ranked);
        const maps: Map<string, number>[] = [];
        for (const s of sets) {
          const r = await qloo.insights({ domain: d, anchorEntityIds: s.entities.map((e) => e.entity_id!), onlyEntityIds: pinned, take: Math.min(50, pinned.length) });
          calls++;
          maps.push(new Map(r.data.filter((e) => typeof e.query?.affinity === 'number').map((e) => [e.entity_id!, e.query!.affinity!])));
        }
        return maps.length ? consensus(pinned, maps[0]!, maps[1]).pct : new Map<string, number>();
      };
      const px = await scoreWith(rankedFor(x, y));
      const py = await scoreWith(rankedFor(y, x));
      const pz: Map<string, number>[] = [];
      for (const z of nullCities) pz.push(await scoreWith(rankedFor(z, x)));
      for (const it of homeItems) {
        const id = ids.get(`${d}|${it.title}`);
        if (!id) continue;
        const home = it.city === x ? px : py;
        const away = it.city === x ? py : px;
        const a = home.get(id) ?? null;
        const b = away.get(id) ?? null;
        let success: boolean | null = null;
        if (a !== null && b !== null) {
          success = a > b;
          n++;
          if (success) k++;
          const key = `${x}-${y}|${it.city}`;
          const c = clusters.get(key) ?? { k: 0, n: 0 };
          c.n++;
          if (success) c.k++;
          clusters.set(key, c);
        }
        let zWins = 0;
        let zN = 0;
        if (b !== null) {
          for (const m of pz) {
            const z = m.get(id);
            if (z === undefined) continue;
            zN++;
            if (z > b) zWins++;
          }
        }
        nullK += zWins;
        nullN += zN;
        details.push({ route: `${x}-${y}`, title: it.title, home: it.city, pctHome: a, pctAway: b, nullRate: zN ? zWins / zN : null, success });
      }
    }
  }
  const cl = [...clusters.values()];
  return { k, n, p: n ? clusterPermutationP(cl) : 1, pBinomial: n ? binomialP(k, n) : 1, clusters: cl.length, nullK, nullN, details, calls };
}

/** The GO rule's direction component, shared by the probe and the eval. */
export function directionPasses(r: Pick<DirectionResult, 'k' | 'n' | 'p' | 'nullK' | 'nullN'>): boolean {
  // p here is the cluster permutation p; with 6 clusters it can reach 1/64.
  if (r.n < 6) return false;
  const rate = r.k / r.n;
  const nullRate = r.nullN ? r.nullK / r.nullN : 0.5;
  return rate >= 0.7 && r.p < 0.05 && nullRate <= 0.6;
}
