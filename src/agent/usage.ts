/**
 * "How Qloo is used": a judge-facing summary computed from the run's evidence ledger, so it can
 * never claim a call that did not happen. Each row is one kind of Qloo request, mapped to the
 * Qloo capability it exercises (capability names as Qloo describes them at
 * https://www.qloo.com/capabilities) and to the decision it drives in Seatback.
 */
import type { EvidenceRecord } from './evidence.ts';

export interface QlooUsageRow {
  key: string;
  /** What Seatback does with it, in one line. */
  purpose: string;
  /** The request shape, e.g. "GET /v2/insights filter.type=urn:entity:movie + signal.location.query". */
  request: string;
  capability: string;
  /** The decision this call drives. */
  decides: string;
  calls: number;
  cached: number;
  results: number;
  evidence: string[];
}

interface Kind {
  key: string;
  purpose: string;
  capability: string;
  decides: string;
  match: (r: EvidenceRecord) => boolean;
}

const t = (r: EvidenceRecord) => r.params['filter.type'] ?? '';
const has = (r: EvidenceRecord, p: string) => p in r.params;
const isEntityRead = (r: EvidenceRecord) => r.path === '/v2/insights' && /^urn:entity:(movie|tv_show|podcast|artist)$/.test(t(r));

const KINDS: Kind[] = [
  {
    key: 'resolve-place',
    purpose: 'Resolve each route end to a Qloo locality (asks you to confirm ambiguous names)',
    capability: 'Locality Intelligence',
    decides: 'Which place the run reads; stops on unknown places instead of guessing',
    match: (r) => r.path === '/search' && r.params.types === 'urn:entity:locality',
  },
  {
    key: 'resolve-catalogue',
    purpose: 'Resolve your licensable catalogue to Qloo entities (title, year, rating)',
    capability: 'Cultural Data Enrichment',
    decides: 'Which of your titles can be ranked; year mismatches are flagged on the card',
    match: (r) => r.path === '/search' && r.params.types !== 'urn:entity:locality',
  },
  {
    key: 'open-read',
    purpose: 'Open location read: what each city favours, per domain',
    capability: 'Locality Intelligence',
    decides: "Each city's own local anchors, coverage chips and the \"popular on this route\" leads",
    match: (r) => isEntityRead(r) && (has(r, 'signal.location.query') || has(r, 'signal.location')) && !has(r, 'filter.results.entities') && !has(r, 'filter.tags'),
  },
  {
    key: 'anchored',
    purpose: "Score your titles with each city's local anchors, twice (readings A and B)",
    capability: 'Recommendations ("rank for the context")',
    decides: 'Ranks per city, withheld titles, abstentions and route fit',
    match: (r) => isEntityRead(r) && has(r, 'signal.interests.entities') && has(r, 'filter.results.entities'),
  },
  {
    key: 'pinned',
    purpose: 'Pinned location read of your titles (only when the probe recommends it)',
    capability: 'Recommendations',
    decides: 'Ranks per city, or a logged fallback to anchored scoring if it collapses',
    match: (r) => isEntityRead(r) && (has(r, 'signal.location.query') || has(r, 'signal.location')) && has(r, 'filter.results.entities'),
  },
  {
    key: 'taste',
    purpose: 'Taste analysis per city (urn:tag): what defines each end',
    capability: 'Taste Intelligence',
    decides: 'The taste split, and the destination tag that drives the arrival spotlight',
    match: (r) => r.path === '/v2/insights' && t(r) === 'urn:tag',
  },
  {
    key: 'tag-search',
    purpose: 'Tag discovery: resolve your programming theme to a real Qloo tag',
    capability: 'Taste Intelligence',
    decides: 'Which tag the theme picks and catalogue marks use',
    match: (r) => r.path === '/v2/tags',
  },
  {
    key: 'tag-filtered',
    purpose: 'Tag-filtered location read (arrival spotlight, theme picks)',
    capability: 'Locality Intelligence + tags',
    decides: 'Destination-flavoured and themed leads to license',
    match: (r) => isEntityRead(r) && has(r, 'filter.tags'),
  },
  {
    key: 'destinations',
    purpose: "Cross-domain: destinations favoured by the slate's audience, read twice from disjoint picks",
    capability: 'Recommendations (cross-domain)',
    decides: 'Network fit: which other cities on your network this slate also suits',
    match: (r) => r.path === '/v2/insights' && t(r) === 'urn:entity:destination',
  },
  {
    key: 'demographics',
    purpose: 'Demographics of the screen slate (urn:demographics)',
    capability: 'Taste Intelligence (audience)',
    decides: 'Age skew warning when the slate under-serves a group',
    match: (r) => r.path === '/v2/insights' && t(r) === 'urn:demographics',
  },
  {
    key: 'trending',
    purpose: 'Momentum of the top screen picks over 12 weeks',
    capability: 'Trends',
    decides: 'Rising, steady or cooling badges on the cards',
    match: (r) => r.path === '/v2/trending',
  },
];

function shape(r: EvidenceRecord): string {
  const keys = Object.keys(r.params).filter((k) => k !== 'filter.type' && k !== 'take').sort();
  return `GET ${r.path}${t(r) ? ` filter.type=${t(r)}` : ''}${keys.length ? ' + ' + keys.join(' + ') : ''}`;
}

export function qlooUsage(records: EvidenceRecord[]): QlooUsageRow[] {
  const rows: QlooUsageRow[] = [];
  for (const k of KINDS) {
    const recs = records.filter((r) => r.path !== 'error' && k.match(r));
    if (!recs.length) continue;
    const shapes = [...new Set(recs.map(shape))];
    rows.push({
      key: k.key,
      purpose: k.purpose,
      request: shapes.slice(0, 2).join('; ') + (shapes.length > 2 ? ` (+${shapes.length - 2} variants)` : ''),
      capability: k.capability,
      decides: k.decides,
      calls: recs.length,
      cached: recs.filter((r) => r.cached).length,
      results: recs.reduce((s, r) => s + r.resultCount, 0),
      evidence: recs.map((r) => r.id),
    });
  }
  return rows;
}
