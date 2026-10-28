/**
 * Network fit: "where else on your network should this slate fly?"
 *
 * A programmer manages a network of routes, not one. Qloo's graph is cross-domain, so the
 * audience behind the slate's top picks can be read as a set of *destinations* it favours
 * (`/v2/insights?filter.type=urn:entity:destination` with `signal.interests.entities`;
 * Destination is on the hackathon key's supported type list). Seatback reads that twice, from
 * two disjoint halves of the picks, and only ranks network cities the two readings agree on:
 * the same rule it applies to catalogue titles.
 *
 * The airport list is static public reference data (IATA code, city and approximate airport
 * coordinates, used only to draw the map). It is not Qloo data.
 */
import type { QlooEntity } from '../qloo/types.ts';
import { kendallTau, MIN_CONSENSUS_TAU, tauNote, WITHHOLD_GAP } from './market.ts';

export interface NetworkCity {
  code: string;
  city: string;
  /** Other names a Qloo destination or locality may use for the same place. */
  aka?: string[];
  lat: number;
  lon: number;
}

/** A default domestic US network. Coordinates are approximate airport locations (public). */
export const DEFAULT_NETWORK: NetworkCity[] = [
  { code: 'ATL', city: 'Atlanta', lat: 33.64, lon: -84.43 },
  { code: 'AUS', city: 'Austin', lat: 30.19, lon: -97.67 },
  { code: 'BNA', city: 'Nashville', lat: 36.12, lon: -86.68 },
  { code: 'BOS', city: 'Boston', lat: 42.36, lon: -71.01 },
  { code: 'CLT', city: 'Charlotte', lat: 35.21, lon: -80.94 },
  { code: 'DCA', city: 'Washington', aka: ['Washington DC', 'Washington D.C.'], lat: 38.85, lon: -77.04 },
  { code: 'DEN', city: 'Denver', lat: 39.86, lon: -104.67 },
  { code: 'DFW', city: 'Dallas', aka: ['Dallas-Fort Worth', 'Fort Worth'], lat: 32.9, lon: -97.04 },
  { code: 'DTW', city: 'Detroit', lat: 42.21, lon: -83.35 },
  { code: 'IAH', city: 'Houston', lat: 29.98, lon: -95.34 },
  { code: 'JFK', city: 'New York', aka: ['New York City', 'NYC', 'Manhattan'], lat: 40.64, lon: -73.78 },
  { code: 'LAS', city: 'Las Vegas', aka: ['Las Vegas Strip'], lat: 36.08, lon: -115.15 },
  { code: 'LAX', city: 'Los Angeles', lat: 33.94, lon: -118.41 },
  { code: 'MCO', city: 'Orlando', lat: 28.43, lon: -81.31 },
  { code: 'MIA', city: 'Miami', aka: ['Miami Beach'], lat: 25.79, lon: -80.29 },
  { code: 'MSP', city: 'Minneapolis', aka: ['Minneapolis-Saint Paul', 'Saint Paul', 'St Paul', 'Twin Cities'], lat: 44.88, lon: -93.22 },
  { code: 'MSY', city: 'New Orleans', lat: 29.99, lon: -90.26 },
  { code: 'ORD', city: 'Chicago', lat: 41.98, lon: -87.9 },
  { code: 'PDX', city: 'Portland', lat: 45.59, lon: -122.6 },
  { code: 'PHL', city: 'Philadelphia', lat: 39.87, lon: -75.24 },
  { code: 'PHX', city: 'Phoenix', lat: 33.43, lon: -112.01 },
  { code: 'SAN', city: 'San Diego', lat: 32.73, lon: -117.19 },
  { code: 'SEA', city: 'Seattle', lat: 47.45, lon: -122.31 },
  { code: 'SFO', city: 'San Francisco', aka: ['San Francisco Bay Area'], lat: 37.62, lon: -122.38 },
  { code: 'SLC', city: 'Salt Lake City', lat: 40.79, lon: -111.98 },
  { code: 'TPA', city: 'Tampa', lat: 27.98, lon: -82.53 },
];

export interface NetworkRow extends NetworkCity {
  /** Rank percentile of this city in reading A and B (1 = Qloo's top destination), or null. */
  pctA: number | null;
  pctB: number | null;
  pct: number | null;
  affinityA: number | null;
  status: 'ranked' | 'withheld' | 'no-data' | 'route-end';
}

export interface NetworkFitResult {
  rows: NetworkRow[];
  tau: number | null;
  paired: number;
  abstain: string | null;
}

/** "Orlando, Florida (synthetic)" -> "orlando". */
export function cityKey(s: string): string {
  return s.replace(/\s*\(synthetic\)\s*$/i, '').split(',')[0]!.trim().toLowerCase().replace(/\./g, '').replace(/[-\u2013]/g, ' ').replace(/\s+/g, ' ');
}

/** Match a Qloo destination entity to a network city by its name or documented geocode name. */
export function matchCity(e: QlooEntity, network: NetworkCity[]): NetworkCity | undefined {
  const keys = [e.name, e.properties?.geocode?.name].filter((x): x is string => !!x).map(cityKey);
  return network.find((c) => [c.city, ...(c.aka ?? [])].some((n) => keys.includes(cityKey(n))));
}

/** True if a Qloo destination entity is one of the route's own ends (by network match or by name). */
export function isRouteEndName(e: QlooEntity, network: NetworkCity[], routeEnds: string[]): boolean {
  const ends = new Set(routeEnds.map(cityKey));
  const c = matchCity(e, network);
  if (c) return [c.city, ...(c.aka ?? [])].some((n) => ends.has(cityKey(n)));
  return [e.name, e.properties?.geocode?.name].filter((x): x is string => !!x).some((n) => ends.has(cityKey(n)));
}

/** Rank percentile per network city within one destinations reading (position-based). */
export function readingPct(list: QlooEntity[], network: NetworkCity[]): Map<string, { pct: number; affinity: number | null }> {
  const out = new Map<string, { pct: number; affinity: number | null }>();
  const n = list.length;
  list.forEach((e, i) => {
    const c = matchCity(e, network);
    if (!c || out.has(c.code)) return;
    out.set(c.code, { pct: n > 1 ? 1 - i / (n - 1) : 1, affinity: typeof e.query?.affinity === 'number' ? e.query.affinity : null });
  });
  return out;
}

export const MIN_NETWORK_PAIRED = 5;

/**
 * Combine two destination readings into a network ranking with the same discipline as the
 * catalogue: cities the readings place far apart are withheld, and if the readings disagree
 * overall the whole ranking is withheld.
 */
export function networkFit(readA: QlooEntity[], readB: QlooEntity[], network: NetworkCity[], routeEnds: string[]): NetworkFitResult {
  const a = readingPct(readA, network);
  const b = readingPct(readB, network);
  const ends = new Set(routeEnds.map(cityKey));
  const isEnd = (c: NetworkCity) => [c.city, ...(c.aka ?? [])].some((n) => ends.has(cityKey(n)));
  const xa: number[] = [];
  const xb: number[] = [];
  const rows: NetworkRow[] = network.map((c) => {
    const ra = a.get(c.code);
    const rb = b.get(c.code);
    const base = { ...c, pctA: ra?.pct ?? null, pctB: rb?.pct ?? null, affinityA: ra?.affinity ?? null };
    if (isEnd(c)) return { ...base, pct: null, status: 'route-end' as const };
    if (!ra || !rb) return { ...base, pct: null, status: 'no-data' as const };
    xa.push(ra.pct);
    xb.push(rb.pct);
    if (Math.abs(ra.pct - rb.pct) > WITHHOLD_GAP) return { ...base, pct: null, status: 'withheld' as const };
    return { ...base, pct: (ra.pct + rb.pct) / 2, status: 'ranked' as const };
  });
  const tau = kendallTau(xa, xb);
  let abstain: string | null = null;
  if (xa.length < MIN_NETWORK_PAIRED) abstain = `Qloo returned only ${xa.length} of your network's cities in both readings; at least ${MIN_NETWORK_PAIRED} are needed to rank the network`;
  else if (tau !== null && tau < MIN_CONSENSUS_TAU) abstain = `the two destination readings disagree (${tauNote(tau)}), so the network ranking is withheld`;
  if (abstain) for (const r of rows) if (r.status === 'ranked') { r.pct = null; r.status = 'withheld'; }
  rows.sort((x, y) => (y.pct ?? -1) - (x.pct ?? -1) || x.code.localeCompare(y.code));
  return { rows, tau, paired: xa.length, abstain };
}

/** Split seeds into two disjoint, interleaved halves so each reading sees strong and weak picks. */
export function splitSeeds<T>(seeds: T[]): [T[], T[]] {
  return [seeds.filter((_, i) => i % 2 === 0), seeds.filter((_, i) => i % 2 === 1)];
}
