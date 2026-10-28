/**
 * Ambiguity resolution: return candidates with a confidence instead of forcing a fuzzy match
 * (the kit's `needs_input` pattern). A caller auto-picks only when status is 'unique'.
 */
import { type Domain, type QlooClient, type QlooEntity, type QlooTag, tagIdOf } from './types.ts';

export interface Candidate {
  id: string;
  name: string;
  type?: string;
  disambiguation?: string;
  /** 0..1, name similarity blended with popularity rank. A heuristic, not a Qloo score. */
  confidence: number;
}
export interface Resolution {
  status: 'unique' | 'ambiguous' | 'none';
  query: string;
  /** Only set when status is 'unique'. */
  chosen?: Candidate;
  candidates: Candidate[];
  note: string;
}

const norm = (s: string) => s.replace(/\s*\(synthetic\)\s*$/i, '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim();

/** Best of the full name and its first comma segment ("Minneapolis, Minnesota" matches "Minneapolis"). */
export function nameSimilarity(query: string, name: string): number {
  const head = name.split(',')[0]!;
  return head !== name ? Math.max(rawSimilarity(query, name), rawSimilarity(query, head)) : rawSimilarity(query, name);
}

function rawSimilarity(query: string, name: string): number {
  const a = norm(query), b = norm(name);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const ta = new Set(a.split(' ')), tb = new Set(b.split(' '));
  const inter = [...ta].filter((t) => tb.has(t)).length;
  const jac = inter / (ta.size + tb.size - inter);
  const prefix = b.startsWith(a) || a.startsWith(b) ? 0.15 : 0;
  return Math.min(0.95, jac * 0.85 + prefix);
}

export const UNIQUE_MIN = 0.85;
export const UNIQUE_GAP = 0.2;

export function rankCandidates(query: string, items: { id?: string; name?: string; type?: string; disambiguation?: string; popularity?: number }[]): Candidate[] {
  const withId = items.filter((i) => i.id && i.name);
  const maxPop = Math.max(0, ...withId.map((i) => i.popularity ?? 0));
  return withId
    .map((i) => {
      const sim = nameSimilarity(query, i.name!);
      const pop = maxPop > 0 ? (i.popularity ?? 0) / maxPop : 0;
      return { id: i.id!, name: i.name!, type: i.type, disambiguation: i.disambiguation, confidence: Math.round((sim * 0.9 + pop * 0.1) * 100) / 100 };
    })
    .sort((x, y) => y.confidence - x.confidence);
}

export function decide(query: string, candidates: Candidate[]): Resolution {
  if (!candidates.length) return { status: 'none', query, candidates, note: 'Qloo returned no match. Ask for a different spelling.' };
  const [top, second] = candidates;
  const gap = top!.confidence - (second?.confidence ?? 0);
  if (top!.confidence >= UNIQUE_MIN && gap >= UNIQUE_GAP) return { status: 'unique', query, chosen: top, candidates, note: 'One clear match.' };
  return { status: 'ambiguous', query, candidates, note: 'Several plausible matches; ask the user to pick. Nothing was chosen automatically.' };
}

const fromEntity = (e: QlooEntity) => ({ id: e.entity_id, name: e.name, type: e.type ?? e.subtype, disambiguation: e.disambiguation, popularity: e.popularity });

export async function resolveLocality(client: QlooClient, query: string): Promise<Resolution> {
  const r = await client.searchLocality(query);
  return decide(query, rankCandidates(query, r.data.map(fromEntity)));
}
export async function resolveTitle(client: QlooClient, query: string, domain: Domain): Promise<Resolution> {
  const r = await client.searchTitle(query, domain);
  return decide(query, rankCandidates(query, r.data.map(fromEntity)));
}
export async function resolveTag(client: QlooClient, query: string, parentTypes?: string[]): Promise<Resolution> {
  const r = await client.searchTags({ query, parentTypes, take: 8 });
  return decide(query, rankCandidates(query, r.data.map((t: QlooTag) => ({ id: tagIdOf(t), name: t.name, type: t.subtype }))));
}
