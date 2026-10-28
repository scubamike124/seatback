/**
 * Baselines: the same task, the same catalogue, without the route.
 *
 * What always runs (no key of any kind needed):
 *   - newest-first:     the newest releases per type (catalogue years only);
 *   - popularity-first: the titles with the highest Qloo popularity per type (a global figure
 *                       returned by the title lookup the run already made, no extra call);
 *   - generic taste:    the titles whose genre tags are most typical of the whole catalogue,
 *                       the choice a one-size-fits-all audience would make.
 * All three are ROUTE-BLIND: they cannot see the route, so they choose the same titles for every
 * route. That is a fact about how they are built, and it is the one comparison that is not
 * circular.
 *
 * What runs only when an LLM provider is configured (a key): an LLM-only baseline, which also
 * reports titles it invents (picks that are not in the licensable catalogue). With no key it does
 * not run, the page says so, and nothing in the UI or the text may claim it did.
 *
 * Honest framing (shown in the UI): "mean route fit" is measured on Qloo's scale, which Seatback
 * optimises, so a higher Seatback number is expected by construction and is NOT proof of
 * anything. It is shown, labelled circular, because the programmer should see the gap; the claim
 * that holds without circularity is route sensitivity, and whether a route-specific slate earns
 * more viewing has not been tested (a pilot would test it; see the README).
 */
import { DOMAIN_LABEL, type Domain, type QlooEntity } from '../qloo/types.ts';
import { parseJsonLoose, type LlmProvider } from '../llm/provider.ts';
import { normalizeTitle, type CatalogueItem } from './catalogue.ts';
import type { ScoredTitle } from './scoring.ts';
import type { BaselineResult, Comparison, DomainSlate, SlateRequest, TraceEvent, WorkedExample } from './types.ts';

export type ResolvedItem = CatalogueItem & { entity?: QlooEntity };

export interface ComparisonInput {
  llm: LlmProvider | null;
  req: SlateRequest;
  domainSlates: DomainSlate[];
  allScored: ScoredTitle[];
  resolved: ResolvedItem[];
  slots: Record<Domain, number>;
  origin: string;
  destination: string;
  /** True when scores came from the synthetic fixture (labels the worked example). */
  synthetic?: boolean;
  emit: (e: TraceEvent) => void;
}

export const CIRCULAR_NOTE =
  'Mean route fit is measured on Qloo\'s own scale, which Seatback maximises, so a higher Seatback number is expected by construction. It is NOT evidence that Seatback is right. ' +
  'What is not circular: the baselines cannot see the route, so they choose the same titles on every route, while Seatback\'s slate changes with the route. ' +
  'Whether a route-specific slate earns more viewing has not been tested, and no in-flight viewing data was used.';

export const NAIVE_CAVEAT =
  'Compared with route-blind baselines (newest-first, popularity-first, generic taste). No LLM baseline ran on this deployment (no LLM key), so nothing here says how an LLM would do. ' + CIRCULAR_NOTE;

export const COMPARISON_CAVEAT =
  'Compared with route-blind baselines and an LLM-only baseline (the LLM saw only city names and the catalogue, not Qloo data). ' +
  'The LLM rows show where its unaided judgement diverges from Qloo\'s taste data, and whether it invents titles you cannot license. ' + CIRCULAR_NOTE;

export function baselinePrompt(origin: string, destination: string, items: CatalogueItem[], slots: Record<Domain, number>): string {
  const byDomain = (d: Domain) => items.filter((i) => i.domain === d).map((i) => `- ${i.title}${i.year ? ` (${i.year})` : ''}`).join('\n');
  const domains = (['movie', 'tv_show', 'podcast', 'artist'] as Domain[]).filter((d) => items.some((i) => i.domain === d));
  return [
    'You are an airline in-flight entertainment programmer.',
    `Route: ${origin} to ${destination}. Passengers are a mix of people from both cities.`,
    'Choose the titles from the licensable catalogue below that best suit this specific route.',
    ...domains.map((d) => `\n${DOMAIN_LABEL[d]} (choose ${slots[d]}):\n${byDomain(d)}`),
    '\nReturn JSON only: {"movie": [titles], "tv_show": [titles], "podcast": [titles], "artist": [titles]}. Use the exact titles.',
  ].join('\n');
}

const DOMAINS: Domain[] = ['movie', 'tv_show', 'podcast', 'artist'];
const ROUTE_SIDES = new Set<ScoredTitle['side']>(['both', 'origin', 'destination']);

/** Mean Jaccard overlap of a title's genre tags with every other same-type title in the catalogue. */
export function tagTypicality(items: ResolvedItem[]): Map<ResolvedItem, number> {
  const tagIds = (it: ResolvedItem) => new Set((it.entity?.tags ?? []).map((t) => t.id).filter((x): x is string => !!x));
  const out = new Map<ResolvedItem, number>();
  for (const it of items) {
    const a = tagIds(it);
    const others = items.filter((o) => o !== it && o.domain === it.domain);
    const sims = others.map((o) => {
      const b = tagIds(o);
      const inter = [...a].filter((x) => b.has(x)).length;
      const union = a.size + b.size - inter;
      return union ? inter / union : 0;
    });
    out.set(it, sims.length ? sims.reduce((s, x) => s + x, 0) / sims.length : 0);
  }
  return out;
}

/** The route-blind baselines. Pure: the same catalogue gives the same picks whatever the route. */
export function routeBlindPicks(resolved: ResolvedItem[], slots: Record<Domain, number>): { id: BaselineResult['id']; label: string; description: string; picks: Record<string, string[]> }[] {
  const domains = DOMAINS.filter((d) => resolved.some((r) => r.domain === d));
  const top = (score: (it: ResolvedItem) => number) => {
    const picks: Record<string, string[]> = {};
    for (const d of domains) {
      picks[d] = resolved
        .filter((r) => r.domain === d)
        .sort((a, b) => score(b) - score(a) || a.line - b.line)
        .slice(0, slots[d])
        .map((r) => r.title);
    }
    return picks;
  };
  const year = (it: ResolvedItem) => it.year ?? it.entity?.properties?.release_year ?? 0;
  const out: ReturnType<typeof routeBlindPicks> = [
    { id: 'newest', label: 'Newest-first', description: 'The newest releases of each type, using the years in your catalogue. No Qloo data, no route.', picks: top(year) },
  ];
  const withPop = resolved.filter((r) => typeof r.entity?.popularity === 'number').length;
  if (withPop > 0 && withPop >= Math.ceil(resolved.length / 2)) {
    out.push({ id: 'popularity', label: 'Popularity-first', description: 'The titles with the highest Qloo popularity of each type: a global figure from the title lookup, the same for every route.', picks: top((it) => it.entity?.popularity ?? -1) });
  }
  const typ = tagTypicality(resolved);
  if (resolved.some((r) => (r.entity?.tags ?? []).length > 0)) {
    out.push({ id: 'generic-taste', label: 'Generic taste', description: 'The titles whose genre tags are most typical of your whole catalogue: what one-size-fits-all programming would pick. No route data.', picks: top((it) => typ.get(it) ?? 0) });
  }
  return out;
}

export async function runComparison(input: ComparisonInput): Promise<Comparison | null> {
  const { llm, emit, resolved, slots } = input;
  const domains = DOMAINS.filter((d) => resolved.some((r) => r.domain === d));
  const results: BaselineResult[] = [];
  for (const b of routeBlindPicks(resolved, slots)) results.push(score(b.picks, { id: b.id, label: b.label, description: b.description, routeBlind: true }, input));

  let llmRan = false;
  let llmNote = '';
  if (llm) {
    try {
      const raw = parseJsonLoose(await llm.completeJson(baselinePrompt(input.origin, input.destination, resolved, slots), { temperature: 0.2 })) as Record<string, unknown>;
      const picks: Record<string, string[]> = {};
      for (const d of domains) picks[d] = Array.isArray(raw[d]) ? (raw[d] as unknown[]).map(String).slice(0, 20) : [];
      results.unshift(score(picks, { id: 'llm', label: `LLM-only (${llm.name})`, description: 'An LLM given only the two city names and your catalogue, with no Qloo data.', routeBlind: false }, input));
      llmRan = true;
    } catch (e) {
      llmNote = ` The LLM baseline failed (${(e as Error).message}), so it did not run.`;
      emit({ type: 'step', id: 'compare', label: 'LLM-only baseline', status: 'warn', detail: `LLM call failed (${(e as Error).message}); the LLM baseline did not run` });
    }
  }
  const primary = results[0]!;
  const ran = `Ran: ${results.map((r) => r.label).join(', ')}. ${llmRan ? 'The LLM baseline ran because an LLM key is configured.' : 'No LLM baseline ran: no LLM key is configured on this deployment.'}${llmNote}`;
  const seatbackRoute = input.domainSlates.flatMap((d) => d.picks).filter((p) => ROUTE_SIDES.has(p.side));
  const meanFitSeatback = seatbackRoute.length ? seatbackRoute.reduce((s, x) => s + x.fit, 0) / seatbackRoute.length : null;
  const c: Comparison = {
    provider: llmRan ? llm!.name : 'route-blind baselines: newest-first, popularity-first, generic taste (no LLM)',
    kind: llmRan ? 'llm' : 'naive',
    baselines: results,
    ran,
    llmRan,
    workedExample: workedExample(results, input),
    picks: primary.picks,
    inventedTitles: primary.inventedTitles,
    agreement: primary.agreement,
    meanFitBaseline: primary.meanFit,
    meanFitSeatback,
    disagreements: primary.disagreements,
    caveat: llmRan ? COMPARISON_CAVEAT : NAIVE_CAVEAT,
  };
  emit({
    type: 'step',
    id: 'compare',
    label: llmRan ? `Baseline comparison (route-blind baselines and ${llm!.name})` : 'Baseline comparison (route-blind baselines; no LLM baseline ran)',
    status: 'ok',
    detail: results.map((r) => `${r.label}: ${Math.round(r.agreement * 100)}% overlap${r.id === 'llm' ? `, ${r.inventedTitles.length} invented` : ''}`).join('; '),
  });
  return c;
}

function score(picks: Record<string, string[]>, meta: Pick<BaselineResult, 'id' | 'label' | 'description' | 'routeBlind'>, input: Pick<ComparisonInput, 'domainSlates' | 'allScored'>): BaselineResult {
  const byNorm = new Map(input.allScored.map((s) => [normalizeTitle(s.title), s]));
  const inventedTitles: string[] = [];
  const baselineScored: ScoredTitle[] = [];
  for (const list of Object.values(picks)) {
    for (const t of list) {
      const s = byNorm.get(normalizeTitle(t));
      if (s) baselineScored.push(s);
      else inventedTitles.push(t);
    }
  }
  const seatbackPicks = input.domainSlates.flatMap((d) => d.picks);
  const seatIds = new Set(seatbackPicks.map((p) => p.key));
  const baseIds = new Set(baselineScored.map((s) => s.key));
  const agreement = seatbackPicks.length ? seatbackPicks.filter((p) => baseIds.has(p.key)).length / seatbackPicks.length : 0;
  const withFit = baselineScored.filter((s) => ROUTE_SIDES.has(s.side));
  const meanFit = withFit.length ? withFit.reduce((s, x) => s + x.fit, 0) / withFit.length : null;
  const disagreements: BaselineResult['disagreements'] = [];
  for (const s of baselineScored.filter((b) => !seatIds.has(b.key)).sort((a, b) => a.fit - b.fit).slice(0, 4)) {
    disagreements.push({
      title: s.title,
      domain: s.domain,
      note:
        s.side === 'no-signal' || s.side === 'withheld'
          ? 'Baseline picked it; Qloo evidence was missing or the readings disagreed, so Seatback did not rank it.'
          : s.side === 'single-end'
            ? 'Baseline picked it; only one city could be read for it, so Seatback has no route fit for it.'
            : `Baseline picked it; Qloo ranks it low for this route (fit ${Math.round(s.fit * 100)}).`,
      evidence: s.evidence.slice(1),
    });
  }
  for (const p of seatbackPicks.filter((p) => !baseIds.has(p.key) && (p.side === 'origin' || p.side === 'destination')).slice(0, 4)) {
    disagreements.push({
      title: p.title,
      domain: p.domain,
      note: `Baseline skipped it; Qloo marks it ${article(p.side)} ${p.side} favourite (fit ${Math.round(p.fit * 100)}).`,
      evidence: p.evidence.slice(1),
    });
  }
  return { ...meta, picks, inventedTitles, agreement, meanFit, scored: withFit.length, unscored: baselineScored.length - withFit.length, disagreements };
}

/**
 * One route, one decision: a title a baseline would programme that Qloo ranks poorly for this
 * route, swapped for a title Qloo marks as a city favourite. Computed from the run itself, never
 * written by hand, and labelled "synthetic example" until the run is live.
 */
export function workedExample(results: BaselineResult[], input: Pick<ComparisonInput, 'domainSlates' | 'allScored' | 'origin' | 'destination' | 'synthetic'>): WorkedExample | null {
  const byNorm = new Map(input.allScored.map((s) => [normalizeTitle(s.title), s]));
  const order: BaselineResult['id'][] = ['llm', 'popularity', 'generic-taste', 'newest'];
  const route = `${short(input.origin)} to ${short(input.destination)}`;
  let best: { gap: number; ex: WorkedExample } | null = null;
  for (const id of order) {
    const b = results.find((r) => r.id === id);
    if (!b) continue;
    for (const ds of input.domainSlates) {
      const seat = ds.picks.filter((p) => p.side === 'origin' || p.side === 'destination');
      const seatKeys = new Set(ds.picks.map((p) => p.key));
      const baseScored = (b.picks[ds.domain] ?? []).map((t) => byNorm.get(normalizeTitle(t))).filter((s): s is ScoredTitle => !!s && ROUTE_SIDES.has(s.side));
      const baseKeys = new Set(baseScored.map((s) => s.key));
      const drop = baseScored.filter((s) => !seatKeys.has(s.key)).sort((x, y) => x.fit - y.fit)[0];
      const add = seat.filter((p) => !baseKeys.has(p.key)).sort((x, y) => y.fit - x.fit)[0];
      if (!drop || !add) continue;
      const gap = add.fit - drop.fit;
      if (gap < 0.2 || (best && best.gap >= gap && best.ex.baselineId === id)) continue;
      const rk = (s: ScoredTitle) => ({ rankOrigin: s.rankOrigin ?? null, rankDest: s.rankDest ?? null, rankN: s.rankN ?? null });
      const ranks = (s: ScoredTitle) => [s.rankOrigin ? `#${s.rankOrigin} of ${s.rankN} for ${short(input.origin)}` : '', s.rankDest ? `#${s.rankDest} of ${s.rankN} for ${short(input.destination)}` : ''].filter(Boolean).join(' and ');
      const favoured = add.side === 'origin' ? short(input.origin) : short(input.destination);
      const label = input.synthetic ? 'Synthetic example: generated by the fixture, not a Qloo result' : 'From this live run; a computed difference, not a measured outcome';
      const ex: WorkedExample = {
        baselineId: id,
        baselineLabel: b.label,
        route,
        domain: ds.domain,
        drop: { title: drop.title, ...rk(drop), fit: drop.fit },
        add: { title: add.title, ...rk(add), fit: add.fit, side: add.side },
        label,
        text:
          `On ${route}, a ${b.label.toLowerCase()} slate would programme "${drop.title}" (${ranks(drop)}; route fit ${Math.round(drop.fit * 100)}). ` +
          `Seatback programmes "${add.title}" instead (${ranks(add)}; ${article(favoured)} ${favoured} favourite; route fit ${Math.round(add.fit * 100)}). ` +
          (b.routeBlind ? `${b.label} cannot see the route, so it makes the same choice on every route. ` : 'The LLM baseline had no Qloo data for either city. ') +
          'This is a difference on Qloo\'s own scale, not a measured gain: whether the swap earns more viewing is what a pilot would test.',
      };
      if (!best || gap > best.gap) best = { gap, ex };
    }
    if (best) break; // prefer the first baseline in the order that yields a decision
  }
  return best?.ex ?? null;
}

/** "a" or "an" for the word that follows ("an origin favourite", "an Orlando favourite"). */
export const article = (w: string) => (/^[aeiou]/i.test(w.trim()) ? 'an' : 'a');

/** "Portland, Maine (synthetic)" -> "Portland (synthetic)": the synthetic label is never dropped. */
const short = (s: string) => {
  const base = s.replace(/ \(synthetic\)$/, '').split(',')[0]!.trim();
  return / \(synthetic\)$/.test(s) ? `${base} (synthetic)` : base;
};
