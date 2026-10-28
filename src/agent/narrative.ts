/**
 * The programmer's note: 2 to 4 sentences summarising the slate. Written by the LLM when one is
 * configured, then validated; written by a deterministic template otherwise.
 *
 * Validation rejects any sentence that cites an unknown evidence ID, quotes a title that is not
 * in the computed facts, or contains a number that does not appear in the facts.
 */
import { parseJsonLoose, type LlmProvider } from '../llm/provider.ts';
import type { EvidenceLedger } from './evidence.ts';
import type { DomainSlate, EndSummary, SlateResult, TraceEvent } from './types.ts';

type Note = SlateResult['programmerNote'];

export function factsFor(domains: DomainSlate[], ends: EndSummary[]) {
  return {
    route: ends.map((e) => e.label),
    domains: domains.map((d) => ({
      domain: d.label,
      abstained: d.abstained,
      endsAgreeTau: d.separationTau === null ? null : Number(d.separationTau.toFixed(2)),
      picks: d.picks.slice(0, 4).map((p) => ({ title: p.title, side: p.side, fit: Math.round(p.fit * 100), evidence: p.evidence.slice(1, 3) })),
    })),
  };
}

export function templateNote(domains: DomainSlate[], ends: EndSummary[]): Note {
  const [o, d] = [ends[0]!.label, ends[1]!.label];
  const out: Note = [];
  const all = domains.flatMap((x) => x.picks);
  // Single-end picks are scored on one city only, so they never headline a route note.
  const top = [...all].filter((p) => p.side !== 'single-end').sort((a, b) => b.fit - a.fit)[0];
  const single = all.filter((p) => p.side === 'single-end');
  if (top) out.push({ text: `Strongest route fit: "${top.title}" (fit ${Math.round(top.fit * 100)}).`, evidence: top.evidence.slice(1, 3), by: 'template' });
  const dFav = all.filter((p) => p.side === 'destination');
  const oFav = all.filter((p) => p.side === 'origin');
  if (dFav.length) out.push({ text: `${dFav.length} pick(s) are ${d} favourites, led by "${dFav[0]!.title}".`, evidence: dFav[0]!.evidence.slice(1, 3), by: 'template' });
  if (oFav.length) out.push({ text: `${oFav.length} pick(s) are ${o} favourites, led by "${oFav[0]!.title}".`, evidence: oFav[0]!.evidence.slice(1, 3), by: 'template' });
  if (single.length) out.push({ text: `${single.length} pick(s) are single-end: only one city could be read reliably for them, so they are not route comparisons.`, evidence: single[0]!.evidence.slice(1, 3), by: 'template' });
  const agree = domains.filter((x) => x.separationTau !== null && x.separationTau >= 0.85).map((x) => x.label.toLowerCase());
  if (agree.length) out.push({ text: `For ${agree.join(' and ')}, both ends rank your catalogue almost identically, so those picks work network-wide.`, evidence: [], by: 'template' });
  return out;
}

const INSTRUCTION_LIKE = /\b(ignore|disregard|forget|override)\b[^.]{0,60}\b(rules?|instructions?|data|facts?|above|previous)\b|\b(you must|you should|always|never)\b[^.]{0,40}\b(buy|license|purchase|ignore)\b|\b(buy|license|purchase)\b[^.]{0,20}\b(whole|entire|all|every)\b/i;

/**
 * Accepts an LLM sentence only if ALL hold: it cites 1 to 4 evidence ids that exist in the ledger; every
 * quoted string is a title from the facts and at least one cited id belongs to a quoted title's own
 * evidence; every number is a WHOLE-TOKEN number that appears in the facts (no substring matches, so
 * "8" is not accepted just because "81" exists); it names something real (a quoted title or a route
 * end) so an unquoted free-standing sentence is rejected; it has no markup, link or address; and it
 * does not read like an instruction. Anything else is dropped and the template note is used.
 */
export function validateNote(sentences: unknown, facts: ReturnType<typeof factsFor>, ledger: EvidenceLedger): Note {
  if (!Array.isArray(sentences)) return [];
  // Only real numeric values count (not digits inside ids like "E1"); matched as whole tokens.
  const factNumbers = new Set<string>();
  JSON.stringify(facts, (_k, v) => { if (typeof v === 'number') factNumbers.add(String(v)); return v; });
  const titleEvidence = new Map<string, Set<string>>();
  for (const d of facts.domains) for (const p of d.picks) titleEvidence.set(p.title.toLowerCase(), new Set(p.evidence));
  const ends = facts.route.map((r) => r.toLowerCase().split(',')[0]!.trim()).filter(Boolean);
  const out: Note = [];
  for (const s of sentences.slice(0, 4)) {
    const text = typeof (s as any)?.text === 'string' ? (s as any).text.trim().slice(0, 300) : '';
    const evidence = Array.isArray((s as any)?.evidence) ? (s as any).evidence.map(String).slice(0, 4) : [];
    if (!text) continue;
    if (/[<>]|https?:|www\.|[^\s@]+@[^\s@]+\.[a-z]{2,}/i.test(text) || INSTRUCTION_LIKE.test(text)) continue;
    if (!evidence.length || !evidence.every((id: string) => ledger.has(id))) continue;
    const quoted = [...text.matchAll(/"([^"]+)"/g)].map((m) => m[1]!.toLowerCase());
    if (quoted.some((q) => !titleEvidence.has(q))) continue;
    if (quoted.length && !quoted.some((q) => evidence.some((id: string) => titleEvidence.get(q)!.has(id)))) continue;
    const lower = text.toLowerCase();
    if (!quoted.length && !ends.some((e) => lower.includes(e))) continue;
    const nums = text.match(/\d+(?:\.\d+)?/g) ?? [];
    if (nums.some((n: string) => !factNumbers.has(n))) continue;
    out.push({ text, evidence, by: 'llm' });
  }
  return out;
}

export async function writeProgrammerNote(
  llm: LlmProvider | null,
  domains: DomainSlate[],
  ends: EndSummary[],
  ledger: EvidenceLedger,
  emit: (e: TraceEvent) => void,
): Promise<Note> {
  const facts = factsFor(domains, ends);
  if (llm) {
    try {
      const prompt = [
        'Write a short note for an airline content programmer about this route slate.',
        'Use ONLY the facts below. Put every title in double quotes exactly as given. Do not add numbers that are not in the facts.',
        'Cite evidence IDs from the facts for every sentence. 2 to 4 sentences.',
        'Return JSON: {"sentences": [{"text": string, "evidence": [string]}]}',
        `FACTS: ${JSON.stringify(facts)}`,
      ].join('\n');
      const raw = parseJsonLoose(await llm.completeJson(prompt, { temperature: 0.3, maxTokens: 1024 })) as { sentences?: unknown };
      const ok = validateNote(raw.sentences, facts, ledger);
      const dropped = Array.isArray(raw.sentences) ? raw.sentences.length - ok.length : 0;
      emit({ type: 'step', id: 'note', label: `Write programmer's note (${llm.name})`, status: ok.length ? 'ok' : 'warn', detail: `${ok.length} sentence(s) passed validation${dropped ? `, ${dropped} rejected` : ''}` });
      if (ok.length) return ok;
    } catch (e) {
      emit({ type: 'step', id: 'note', label: "Write programmer's note", status: 'warn', detail: `LLM unavailable (${(e as Error).message}); using template` });
    }
  }
  const t = templateNote(domains, ends);
  if (!llm) emit({ type: 'step', id: 'note', label: "Write programmer's note (template, no LLM)", status: 'ok' });
  return t;
}
