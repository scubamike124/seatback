/**
 * Route-fit scoring and slate balancing. Pure functions, no I/O, fully unit-tested.
 *
 * Inputs are Qloo affinities for each catalogue title at each end of the route. Raw affinities
 * are not guaranteed to be on a comparable scale between two locations, so Seatback ranks
 * titles *within the catalogue* at each end (percentile) and blends the two percentiles by the
 * programmer's stated passenger mix. The raw affinity is kept and shown as evidence.
 */
import type { Domain } from '../qloo/types.ts';

export interface ScoredTitle {
  key: string; // stable key: entity id
  title: string;
  domain: Domain;
  entityId: string;
  year?: number;
  contentRating?: string;
  tags: { id: string; name: string }[];
  affOrigin: number | null;
  affDest: number | null;
  pctOrigin: number | null;
  pctDest: number | null;
  fit: number; // 0..1
  /**
   * both / origin / destination: scored at both ends. single-end: only one end could be read.
   * withheld: the two readings disagreed. no-signal: Qloo returned no score.
   */
  side: 'both' | 'origin' | 'destination' | 'single-end' | 'withheld' | 'no-signal';
  evidence: string[];
  /** Rank within the domain at each end, over the same set of titles (null if not ranked there). */
  rankOrigin?: number | null;
  rankDest?: number | null;
  rankN?: number;
  /** The concrete Qloo readings behind this title, for display on the card. */
  calls?: { end: 'origin' | 'destination'; reading: 'A' | 'B'; anchorDomain: string; anchors: string[]; affinity: number | null; evidence: string }[];
}

/** Percentile rank in [0, 1] of each value within the list (ties share the average rank). */
export function percentiles(values: (number | null)[]): (number | null)[] {
  const present = values.filter((v): v is number => v !== null).sort((a, b) => a - b);
  if (present.length === 0) return values.map(() => null);
  if (present.length === 1) return values.map((v) => (v === null ? null : 1));
  return values.map((v) => {
    if (v === null) return null;
    const below = present.filter((x) => x < v).length;
    const equal = present.filter((x) => x === v).length;
    return (below + (equal - 1) / 2) / (present.length - 1);
  });
}

/** Origin share w in [0,1]: fraction of passengers whose taste is modelled by the origin. */
export function routeFit(pctO: number | null, pctD: number | null, w: number): number {
  if (pctO === null && pctD === null) return 0;
  if (pctO === null) return pctD!;
  if (pctD === null) return pctO;
  return w * pctO + (1 - w) * pctD;
}

export const SPLIT_GAP = 0.35;
/** A one-sided favourite is only swapped in if it is still a reasonable route fit. */
export const MIN_SWAP_FIT = 0.4;
/** A title must reach this route fit to fill a slot; weaker slots stay empty and are reported. */
export const MIN_SLOT_FIT = 0.3;

export function sideOf(pctO: number | null, pctD: number | null): ScoredTitle['side'] {
  if (pctO === null && pctD === null) return 'no-signal';
  // With only one end readable, nothing can be said about how the ends compare.
  if (pctO === null || pctD === null) return 'single-end';
  if (pctO - pctD >= SPLIT_GAP) return 'origin';
  if (pctD - pctO >= SPLIT_GAP) return 'destination';
  return 'both';
}

/** Documented MPAA and TV Parental Guidelines values that Seatback treats as family-safe. */
export const FAMILY_SAFE_MOVIE = ['G', 'PG', 'PG-13'];
export const FAMILY_SAFE_TV = ['TV-Y', 'TV-Y7', 'TV-G', 'TV-PG'];

export function isFamilySafe(t: Pick<ScoredTitle, 'domain' | 'contentRating'>): boolean | null {
  if (t.domain === 'podcast' || t.domain === 'artist') return null; // no documented rating field
  if (!t.contentRating) return null;
  return (t.domain === 'movie' ? FAMILY_SAFE_MOVIE : FAMILY_SAFE_TV).includes(t.contentRating);
}

function jaccard(a: { id: string }[], b: { id: string }[]): number {
  if (!a.length || !b.length) return 0;
  const A = new Set(a.map((t) => t.id));
  const inter = b.filter((t) => A.has(t.id)).length;
  return inter / (A.size + b.length - inter);
}

export interface SlateOptions {
  size: number;
  familySafeOnly: boolean;
  /** Variety weight: 0 = pure fit, 1 = pure novelty. */
  diversity?: number;
}

export interface SlateDecision {
  picked: ScoredTitle[];
  /** Eligible titles (at or above the fit floor) that did not get a slot. */
  bench: ScoredTitle[];
  /** Eligible by rules but below the route-fit floor. */
  belowFloor: ScoredTitle[];
  /** Removed by the family-safe rule. */
  familyRemoved: ScoredTitle[];
  notes: string[];
}

/**
 * Greedy maximal-marginal-relevance selection: fit minus genre overlap with what is already
 * picked, plus a guarantee that each end of the route gets at least one title it clearly
 * favours when the catalogue has one. Every reason a slot stays empty is reported.
 */
export function buildSlate(candidates: ScoredTitle[], opts: SlateOptions): SlateDecision {
  const notes: string[] = [];
  const lambda = opts.diversity ?? 0.25;
  const noSignal = candidates.filter((c) => c.side === 'no-signal').length;
  const withheld = candidates.filter((c) => c.side === 'withheld').length;
  let pool = candidates.filter((c) => c.side !== 'no-signal' && c.side !== 'withheld');
  if (noSignal) notes.push(`${noSignal} title(s) had no Qloo score and were not ranked.`);
  if (withheld) notes.push(`${withheld} title(s) withheld because the two readings disagreed.`);
  const familyRemoved = opts.familySafeOnly ? pool.filter((c) => isFamilySafe(c) === false) : [];
  if (familyRemoved.length) {
    pool = pool.filter((c) => !familyRemoved.includes(c));
    notes.push(`${familyRemoved.length} title(s) removed by the family-safe rule.`);
  }
  const belowFloor = pool.filter((c) => c.fit < MIN_SLOT_FIT).sort((a, b) => a.fit - b.fit);
  pool = pool.filter((c) => c.fit >= MIN_SLOT_FIT);
  const picked: ScoredTitle[] = [];
  const remaining = [...pool].sort((a, b) => b.fit - a.fit);
  while (picked.length < opts.size && remaining.length) {
    let bestI = 0;
    let bestScore = -Infinity;
    remaining.forEach((c, i) => {
      const overlap = picked.length ? Math.max(...picked.map((p) => jaccard(p.tags, c.tags))) : 0;
      const s = (1 - lambda) * c.fit - lambda * overlap;
      if (s > bestScore) {
        bestScore = s;
        bestI = i;
      }
    });
    picked.push(remaining.splice(bestI, 1)[0]!);
  }
  const swappedIn = new Set<string>();
  for (const side of ['origin', 'destination'] as const) {
    if (picked.length && !picked.some((p) => p.side === side)) {
      const cand = remaining.filter((r) => r.side === side).sort((a, b) => b.fit - a.fit)[0];
      if (cand && picked.length >= 3 && cand.fit >= MIN_SWAP_FIT) {
        const out = [...picked].sort((a, b) => a.fit - b.fit).find((p) => p.side === 'both') ?? picked[picked.length - 1]!;
        picked.splice(picked.indexOf(out), 1, cand);
        remaining.splice(remaining.indexOf(cand), 1, out);
        swappedIn.add(cand.key);
        notes.push(`Swapped "${out.title}" for "${cand.title}" so ${side} passengers get a title their city clearly favours.`);
      }
    }
  }
  // Explain when variety (or the both-ends swap) kept a higher-fit title off the slate.
  // (Swapped-in favourites are explained by their own note, so compare against the other picks.)
  const regular = picked.filter((p) => !swappedIn.has(p.key));
  const minPicked = regular.length ? Math.min(...regular.map((p) => p.fit)) : 1;
  for (const benched of remaining.filter((r) => r.fit >= minPicked + 0.02).sort((x, y) => y.fit - x.fit).slice(0, 2)) {
    const b = benched;
    const twin = picked.filter((p) => jaccard(p.tags, b.tags) > 0).sort((x, y) => jaccard(y.tags, b.tags) - jaccard(x.tags, b.tags))[0];
    notes.push(`"${b.title}" (fit ${Math.round(b.fit * 100)}) is on the bench although its fit is higher than the lowest regular pick (${Math.round(minPicked * 100)}): ${twin ? `it shares genre tags with "${twin.title}", so a more varied title took the slot` : 'a title favoured by the other city took the slot'}.`);
  }
  if (picked.length < opts.size && opts.size > 0) {
    const why: string[] = [];
    if (familyRemoved.length) why.push(`${familyRemoved.length} removed by the family-safe rule`);
    if (belowFloor.length) why.push(`${belowFloor.length} below the route-fit floor of ${Math.round(MIN_SLOT_FIT * 100)}`);
    if (withheld) why.push(`${withheld} withheld`);
    if (noSignal) why.push(`${noSignal} without a Qloo score`);
    if (!why.length) why.push('the catalogue has no more titles of this type');
    notes.push(`${picked.length} of ${opts.size} slots filled: ${why.join(', ')}.`);
  }
  picked.sort((a, b) => b.fit - a.fit);
  return { picked, bench: remaining.sort((a, b) => b.fit - a.fit), belowFloor, familyRemoved, notes };
}

/** Overlap of two slates by entity id, as a share of the smaller slate. */
export function slateOverlap(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const A = new Set(a);
  return b.filter((x) => A.has(x)).length / Math.min(a.length, b.length);
}
