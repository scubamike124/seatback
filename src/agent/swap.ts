/**
 * Swap test: does the slate actually depend on the route?
 *
 * Seatback re-runs the same catalogue, the same passenger mix and the same city at one end of the
 * route, with the other end replaced by a different network city, and counts how many of this
 * route's picks are no longer picked. Route-blind baselines change none by construction, so this
 * is the one comparison that is not circular: it needs no Qloo-scale "fit", only a count of picks.
 *
 * It is a count of changed picks, not a measure of better picks. Whether the changes earn more
 * viewing is what a pilot would test (a pilot with real route-level viewing data, described in the README). The comparison route is chosen by a
 * fixed rule (see pickSwapCity) and stated next to the number, never tuned to make it larger.
 */
import type { DomainSlate, NetworkFit, SwapTest } from './types.ts';

/** Fewer ranked network cities than this and the choice of comparison route would be arbitrary. */
export const MIN_SWAP_CANDIDATES = 3;

export const MAX_SWAP_TRIES = 3;

/**
 * Comparison cities, in order of preference: the network cities Qloo ranks LAST among those both
 * readings agree on, i.e. the audiences that favour this slate least. A fixed rule, stated next to
 * the number. The first is the largest contrast the network offers: a nearer route would change
 * fewer picks, so the number reads as "how far the slate moves for a very different audience",
 * not as a typical change. Later entries are used only if an earlier city gives no comparable slate.
 */
export function swapCandidates(network: NetworkFit | null): { city: string; code: string; rankedCount: number }[] {
  if (!network || network.abstain) return [];
  const ranked = network.rows.filter((r) => r.status === 'ranked' && r.pct !== null);
  if (ranked.length < MIN_SWAP_CANDIDATES) return [];
  return [...ranked]
    .sort((a, b) => (a.pct! - b.pct!) || a.code.localeCompare(b.code))
    .slice(0, MAX_SWAP_TRIES)
    .map((r) => ({ city: r.city, code: r.code, rankedCount: ranked.length }));
}

/** Which end to replace: the end carrying at least half of the passenger mix, so the swap bites. */
export function endToSwap(originShare: number): 'origin' | 'destination' {
  return originShare > 0.5 ? 'origin' : 'destination';
}

export interface SwapCounts {
  changed: number;
  total: number;
  byDomain: { domain: DomainSlate['domain']; label: string; changed: number; total: number }[];
}

/** Pure: how many of the main slate's picks are missing from the swapped slate (matched by entity). */
export function countChanged(main: DomainSlate[], other: DomainSlate[]): SwapCounts {
  const byDomain: SwapCounts['byDomain'] = [];
  for (const ds of main) {
    if (!ds.picks.length) continue;
    const keep = new Set((other.find((o) => o.domain === ds.domain)?.picks ?? []).map((p) => p.key));
    const changed = ds.picks.filter((p) => !keep.has(p.key)).length;
    byDomain.push({ domain: ds.domain, label: ds.label, changed, total: ds.picks.length });
  }
  return {
    changed: byDomain.reduce((s, d) => s + d.changed, 0),
    total: byDomain.reduce((s, d) => s + d.total, 0),
    byDomain,
  };
}

/**
 * The swapped slate is only comparable if it was built as fully as the main one. If a Qloo call
 * failed or hit the budget, a domain can come back thinner or abstained, which would inflate the
 * change count. Return a reason when it is not comparable.
 */
export function incomparable(main: DomainSlate[], other: DomainSlate[]): string | null {
  for (const ds of main) {
    if (!ds.picks.length) continue;
    const o = other.find((x) => x.domain === ds.domain);
    if (!o || o.abstained) return `${ds.label} could not be ranked on the comparison route`;
    if (o.picks.length < ds.picks.length) return `${ds.label} came back with fewer picks on the comparison route (${o.picks.length} of ${ds.picks.length}), so the counts are not comparable`;
  }
  return null;
}

/** City names passed in already carry "(synthetic)" in fixture mode, so the label is never dropped. */
export function swapText(t: { changed: number; total: number; against: string }): string {
  return `Swap test: changes ${t.changed} of ${t.total} picks versus ${t.against}.`;
}
