/**
 * Anchor selection and the open-read request, shared by the agent (pipeline.ts), the live probe
 * and the evaluation, so all three test exactly the same method.
 *
 * Rules:
 * 1. Anchors are Qloo's own top local entities from an open location read. Never an LLM.
 * 2. A domain is never scored with anchors from the same domain, so an anchor can never be
 *    ranked as a pick (it would score itself near the top). Plan below.
 * 3. Entities also in the other end's top 10 are global hits that cannot tell two cities apart;
 *    distinctive anchors are preferred when at least two remain.
 * 4. Each reading uses 3 anchors. Ranks 4 to 6 are kept as spares for the recovery retry.
 */
import type { Domain, InsightsRequest, LocationSignal, QlooEntity } from '../qloo/types.ts';
import { FAMILY_SAFE_MOVIE, FAMILY_SAFE_TV } from './scoring.ts';

export type AnchorDomain = 'artist' | 'tv_show' | 'movie';

/** For each target domain: [reading A anchor domain, reading B anchor domain, fallback domain]. */
export const ANCHOR_PLAN: Record<Domain, [AnchorDomain, AnchorDomain, AnchorDomain | null]> = {
  movie: ['artist', 'tv_show', null],
  tv_show: ['artist', 'movie', null],
  podcast: ['artist', 'tv_show', 'movie'],
  artist: ['tv_show', 'movie', null],
};

export const ANCHORS_PER_READING = 3;

export function openReadRequest(d: Domain, location: LocationSignal, opts: { familySafeOnly?: boolean; recencyYear: number }): InsightsRequest {
  return {
    domain: d,
    location,
    take: 12,
    ...(d === 'movie' ? { releaseYearMin: opts.recencyYear, ...(opts.familySafeOnly ? { contentRating: FAMILY_SAFE_MOVIE.join(',') } : {}) } : {}),
    ...(d === 'tv_show' && opts.familySafeOnly ? { contentRating: FAMILY_SAFE_TV.join(',') } : {}),
  };
}

/** Ranked anchor candidates for one end in one anchor domain (distinctive first). */
export function rankedAnchors(own: QlooEntity[], other: QlooEntity[]): QlooEntity[] {
  const ok = own.filter((e) => e.entity_id && typeof e.query?.affinity === 'number');
  const theirs = new Set(other.slice(0, 10).map((e) => e.entity_id));
  const distinct = ok.filter((e) => !theirs.has(e.entity_id));
  if (distinct.length >= 2) return [...distinct, ...ok.filter((e) => theirs.has(e.entity_id))];
  return ok;
}

export interface AnchorSet {
  reading: 'A' | 'B';
  domain: AnchorDomain;
  entities: QlooEntity[];
}

/**
 * The anchor sets to try for a target domain. Every attempt must provide TWO independent sets
 * (readings A and B), otherwise it returns [] and the caller abstains: a single reading cannot be
 * checked for consistency. Attempt 0 uses ranks 1-3 of the two planned domains. The recovery
 * attempt 1 uses ranks 4-6 of those domains, filling a missing one from the fallback domain.
 */
export function anchorSetsFor(target: Domain, attempt: 0 | 1, ranked: Record<AnchorDomain, QlooEntity[]>): AnchorSet[] {
  const [a, b, fallback] = ANCHOR_PLAN[target];
  const slice = (d: AnchorDomain, i: number) => ranked[d].slice(i * ANCHORS_PER_READING, (i + 1) * ANCHORS_PER_READING);
  const candidates: { domain: AnchorDomain; entities: QlooEntity[] }[] =
    attempt === 0
      ? [
          { domain: a, entities: slice(a, 0) },
          { domain: b, entities: slice(b, 0) },
        ]
      : [
          { domain: a, entities: slice(a, 1) },
          { domain: b, entities: slice(b, 1) },
          ...(fallback ? [{ domain: fallback, entities: slice(fallback, 0) }] : []),
        ];
  const usable = candidates.filter((c) => c.entities.length > 0).slice(0, 2);
  if (usable.length < 2) return [];
  return usable.map((c, i) => ({ reading: i === 0 ? ('A' as const) : ('B' as const), domain: c.domain, entities: c.entities }));
}
