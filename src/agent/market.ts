/**
 * How Seatback reads one end of a route ("market") from Qloo, and how it decides whether that
 * reading is trustworthy enough to rank a catalogue.
 *
 * Three modes, one interface (see qloo/types.ts InsightsRequest):
 * - open:     location only. What the city favours. Used for anchors, coverage and the
 *             "popular on this route" rail. Documented location use case.
 * - pinned:   location + the programmer's pinned titles. Documented, but publicly reported by
 *             another entrant (Taste Atlas's public findings) to act as a hard filter for movies:
 *             pinned titles collapse. Seatback detects the collapse and falls back.
 * - anchored: score the pinned titles with `signal.interests.entities` set to Qloo's OWN top
 *             local artists (reading A) and top local TV shows (reading B) for that city. Anchors
 *             are always chosen by Qloo's open read, never by an LLM. Two independent readings
 *             let Seatback withhold titles the readings disagree on and abstain when a market is
 *             incoherent, instead of ranking noise with confidence.
 *
 * Credit: the anchor-and-consensus idea follows public findings published by the Taste Atlas
 * entry (github.com/4KInc/travels-well). Seatback applies it to a different buyer and question.
 */

export type ReadMode = 'open' | 'pinned' | 'anchored';

/** Kendall's tau-a over paired values. Returns null with fewer than 3 pairs. */
export function kendallTau(a: number[], b: number[]): number | null {
  const n = Math.min(a.length, b.length);
  if (n < 3) return null;
  let s = 0;
  let pairs = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const x = Math.sign(a[i]! - a[j]!);
      const y = Math.sign(b[i]! - b[j]!);
      s += x * y;
      pairs++;
    }
  }
  return pairs ? s / pairs : null;
}

/** Rank percentiles in [0,1] (ties averaged) for the entries of a map. */
export function percentileMap(scores: Map<string, number>): Map<string, number> {
  const entries = [...scores.entries()];
  const out = new Map<string, number>();
  if (entries.length === 1) {
    out.set(entries[0]![0], 1);
    return out;
  }
  const sorted = entries.map(([, v]) => v).sort((x, y) => x - y);
  for (const [k, v] of entries) {
    const below = sorted.filter((x) => x < v).length;
    const equal = sorted.filter((x) => x === v).length;
    out.set(k, (below + (equal - 1) / 2) / (entries.length - 1));
  }
  return out;
}

export const WITHHOLD_GAP = 0.25;
/** Shared with scripts/live-probe.ts so the GO rule and the app use the same bar. */
export const MIN_CONSENSUS_TAU = 0.3;

/** Plain words for a Kendall tau between two rankings of the same items (1 = same order, -1 = reversed). */
export function tauWords(t: number): string {
  return t >= 0.85 ? 'almost the same order' : t >= 0.5 ? 'mostly the same order' : t >= 0.2 ? 'only loosely the same order' : t > -0.2 ? 'unrelated orders' : 'largely opposite order';
}

/** "tau 0.62, i.e. ranked in mostly the same order": the number never appears without its meaning. */
export function tauNote(t: number): string {
  return `tau ${t.toFixed(2)}, i.e. ranked in ${tauWords(t)}`;
}
export const MIN_COVERAGE = 0.5;
/** Abstain when the readings disagree on more than this share of titles. */
export const MAX_WITHHELD_SHARE = 0.4;
/** Ranking fewer titles than this is not meaningful. */
export const MIN_SCORED = 3;
export const ENDS_AGREE_TAU = 0.85;

export interface ConsensusResult {
  /** Final percentile per title (mean of the readings that agree). */
  pct: Map<string, number>;
  /** Titles the two readings place more than WITHHOLD_GAP apart. */
  withheld: string[];
  /** Titles Qloo returned no affinity for in any reading. */
  missing: string[];
  tau: number | null;
  coverage: number;
  readings: number;
  abstain: string | null;
}

/**
 * Combine one or two readings of the same pinned catalogue at one route end.
 * `ids` is the full pinned list, so missing titles and coverage are measured honestly.
 */
export function consensus(ids: string[], readA: Map<string, number>, readB?: Map<string, number>): ConsensusResult {
  const pA = percentileMap(readA);
  const pB = readB && readB.size ? percentileMap(readB) : undefined;
  const pct = new Map<string, number>();
  const withheld: string[] = [];
  const missing: string[] = [];
  const xa: number[] = [];
  const xb: number[] = [];
  for (const id of ids) {
    const a = pA.get(id);
    const b = pB?.get(id);
    if (a === undefined && b === undefined) {
      missing.push(id);
      continue;
    }
    if (a !== undefined && b !== undefined) {
      xa.push(a);
      xb.push(b);
      if (Math.abs(a - b) > WITHHOLD_GAP) {
        withheld.push(id);
        continue;
      }
      pct.set(id, (a + b) / 2);
    } else {
      pct.set(id, (a ?? b)!);
    }
  }
  const tau = pB ? kendallTau(xa, xb) : null;
  // Withheld titles are not scored, so they count against coverage.
  const scored = pct.size;
  const coverage = ids.length ? scored / ids.length : 0;
  let abstain: string | null = null;
  if (ids.length < MIN_SCORED) {
    abstain = `the catalogue has only ${ids.length} title${ids.length === 1 ? '' : 's'} of this type; ${MIN_SCORED} or more are needed to rank`;
  } else if (ids.length && withheld.length / ids.length > MAX_WITHHELD_SHARE) {
    abstain = `the two independent readings disagree on ${withheld.length} of ${ids.length} titles`;
  } else if (tau !== null && xa.length >= 4 && tau < MIN_CONSENSUS_TAU) {
    abstain = `the two independent readings disagree overall (${tauNote(tau)}), so this market looks incoherent`;
  } else if (scored < MIN_SCORED) {
    abstain = `only ${scored} of ${ids.length} titles could be scored`;
  } else if (coverage < MIN_COVERAGE) {
    abstain = `only ${scored} of ${ids.length} titles could be scored`;
  }
  return { pct, withheld, missing, tau, coverage, readings: pB ? 2 : 1, abstain };
}

/** True when a pinned read returned far fewer titles than were pinned (the reported collapse). */
export function looksCollapsed(pinnedCount: number, returnedCount: number): boolean {
  return pinnedCount >= 3 && returnedCount < Math.ceil(pinnedCount / 2);
}

/** Do the two ends rank the catalogue differently enough for route-specific programming to matter? */
export function endsSeparation(origin: Map<string, number>, dest: Map<string, number>): number | null {
  const common = [...origin.keys()].filter((k) => dest.has(k));
  return kendallTau(
    common.map((k) => origin.get(k)!),
    common.map((k) => dest.get(k)!),
  );
}
