/**
 * The Seatback slate pipeline. Two modes, always labelled in the result (`workflow`):
 *  - LLM planner (planner.ts): a model chooses Qloo tool calls under a step cap, a call cap and schema
 *    validation, then picks anchors/theme tag; this file scores.
 *  - scripted workflow (no LLM, or planner failed): the fixed sequence below. It is NOT an agent.
 * Explicit, logged decisions:
 *   resolve route ends (stop if unknown, ask if ambiguous) -> open reads per end -> rank local
 *   anchors -> resolve catalogue -> score each domain with anchors from OTHER domains (two
 *   readings per end; optional pinned mode with collapse detection) -> consensus, withholding,
 *   abstention -> recovery retry with spare anchors -> slate balancing -> demographics, momentum,
 *   taste split -> arrival spotlight (taste tag -> filter.tags) -> optional theme (/v2/tags) ->
 *   network fit (cross-domain destinations, two readings) -> validated note -> baseline comparison.
 * Every number in the output points to an evidence record (a Qloo call). The LLM never ranks.
 */
import { runPlanner, type PlannerOutcome, type PlannerPlan, DEFAULT_MAX_STEPS, DEFAULT_MAX_PLANNER_CALLS } from './planner.ts';
import { decide, rankCandidates } from '../qloo/resolve.ts';
import { CallCounter } from '../qloo/client.ts';
import { AGE_BANDS, DOMAIN_LABEL, type Domain, type LocationSignal, type QlooClient, type QlooEntity, QlooError, tagIdOf } from '../qloo/types.ts';
import type { LlmProvider } from '../llm/provider.ts';
import { type Claim, EvidenceLedger, checkGrounding } from './evidence.ts';
import { normalizeTitle, parseCatalogue, capStratified, type CatalogueItem } from './catalogue.ts';
import { type ConsensusResult, type ReadMode, consensus, tauNote, endsSeparation, ENDS_AGREE_TAU, looksCollapsed, MIN_SCORED } from './market.ts';
import { buildSlate, routeFit, sideOf, type ScoredTitle } from './scoring.ts';
import { type AnchorDomain, type AnchorSet, anchorSetsFor, openReadRequest, rankedAnchors } from './anchors.ts';
import type { Ambiguity, QlooStatus, DomainSlate, EndSummary, NetworkFit, RailItem, SlateRequest, SlateResult, Spotlight, SwapTest, ThemeResult, TraceEvent } from './types.ts';
import { DEFAULT_NETWORK, isRouteEndName, matchCity, networkFit, splitSeeds } from './network.ts';
import { countChanged, endToSwap, incomparable, swapCandidates, swapText } from './swap.ts';
import { qlooUsage } from './usage.ts';
import { runComparison } from './baseline.ts';
import { writeProgrammerNote } from './narrative.ts';

export const DEFAULT_SLOTS: Record<Domain, number> = { movie: 6, tv_show: 3, podcast: 3, artist: 2 };
export const MAX_CATALOGUE = 40;
const DOMAINS: Domain[] = ['movie', 'tv_show', 'podcast', 'artist'];
const ANCHOR_DOMAINS: AnchorDomain[] = ['artist', 'tv_show', 'movie'];
type End = 'origin' | 'destination';
const ENDS: End[] = ['origin', 'destination'];

export interface PipelineOptions {
  qloo: QlooClient;
  llm: LlmProvider | null;
  emit: (e: TraceEvent) => void;
  /** 'anchored' (default) or 'pinned' (tries location+pinned first, falls back on collapse). */
  scoringMode?: 'anchored' | 'pinned';
  now?: () => Date;
  /** Internal (swap test): stop once the screen and audio slates are built; skips everything after. */
  /** Enable the LLM planner loop (needs `llm`). Without it, or without an LLM, the scripted workflow runs. */
  planner?: { enabled: boolean; maxSteps?: number; maxCalls?: number };
  /** Polled before each Qloo call; true stops the run (client disconnected). */
  shouldStop?: () => boolean;
  stopAfterSlate?: { onSlate: (domains: DomainSlate[], calls: number, kind: 'scripted' | 'llm-planner' | 'planner-fallback') => void };
}

/** Thrown for problems the user must fix (shown verbatim). */
export class UserFacingError extends Error {}

/** Mode and call counter, when the client is the guarded one (tests with scripted clients have none). */
function statusOf(qloo: QlooClient): { qlooStatus?: QlooStatus } {
  const g = qloo as unknown as { counter?: CallCounter; mode?: QlooStatus['mode'] };
  if (!(g.counter instanceof CallCounter) || !g.mode) return {};
  return { qlooStatus: { mode: g.mode, line: g.counter.line(g.mode), used: g.counter.used, budget: g.counter.budget, cached: g.counter.cacheHits } };
}

type CallInfo = NonNullable<ScoredTitle['calls']>[number];

export async function runPipeline(req: SlateRequest, opts: PipelineOptions): Promise<SlateResult | null> {
  const { qloo } = opts;
  const synthetic = qloo.source === 'synthetic-fixture';
  const trace: TraceEvent[] = [];
  const emit = (e: TraceEvent) => {
    if (e.type !== 'result') trace.push(e);
    opts.emit(e);
  };
  const now = opts.now ?? (() => new Date());
  const t0 = Date.now();
  const ledger = new EvidenceLedger();
  const claims: Claim[] = [];
  const originShare = clamp01(req.originShare ?? 0.5);
  const slots = { ...DEFAULT_SLOTS, ...(req.slots ?? {}) };
  let cachedCalls = 0;
  let calls = 0;
  const track = <T>(r: { cached: boolean } & T): T => {
    calls++;
    if (r.cached) cachedCalls++;
    return r;
  };
  const safe = <T>(fn: Parameters<typeof safeFor<T>>[1]) => safeFor<T>(qloo.source, fn);
  // In synthetic mode every user-supplied title is labelled, so a screenshot can never show a
  // real title next to a generated score.
  const label = (t: string) => (synthetic && !/\(synthetic\)$/.test(t) ? `${t} (synthetic)` : t);
  const plannerOn = !!(opts.planner?.enabled && opts.llm);
  const workflowLabel = plannerOn ? `LLM planner (${opts.llm!.name}) choosing Qloo tool calls, scripted scorer` : opts.llm ? `scripted workflow (LLM writes the note only)` : 'scripted workflow (no LLM)';
  emit({ type: 'start', mode: qloo.source, llm: opts.llm?.name ?? null, workflow: plannerOn ? 'workflow starting' : workflowLabel, at: now().toISOString() });
  const budgetLeft = (): number => {
    const c = (qloo as unknown as { counter?: { remaining: number } }).counter;
    return c ? c.remaining : Infinity;
  };
  const skipped: string[] = [];
  const canSpend = (n: number, what: string): boolean => {
    if (opts.shouldStop?.()) throw new UserFacingError('The run was stopped because the visitor disconnected.');
    if (budgetLeft() >= n) return true;
    skipped.push(what);
    emit({ type: 'step', id: `skip-${what.replace(/\W+/g, '-')}`, label: `Skipped: ${what}`, status: 'warn', detail: `Only ${budgetLeft()} Qloo calls left in this run's budget (needs about ${n}). Result continues without it.` });
    return false;
  };

  if (req.droppedPersonalLines) emit({ type: 'step', id: 'pii', label: 'Removed catalogue lines that looked like personal data', status: 'warn', detail: `${req.droppedPersonalLines} line(s) were dropped and never sent to Qloo or an LLM.` });

  // ---------- 1. Parse the catalogue ----------
  const parsed = capStratified(parseCatalogue(req.catalogue ?? '', MAX_CATALOGUE), Math.max(1, Math.min(MAX_CATALOGUE, req.maxTitles ?? MAX_CATALOGUE)));
  emit({ type: 'step', id: 'catalogue', label: 'Read your licensable catalogue', status: parsed.items.length ? 'ok' : 'error', detail: `${parsed.items.length} titles${parsed.rejected.length ? `, ${parsed.rejected.length} lines skipped` : ''}` });
  if (!parsed.items.length) throw new UserFacingError('The catalogue is empty. Paste one title per line.');

  // ---------- 2. Resolve route ends ----------
  const need: { typed: string; candidates: string[]; options?: { name: string; confidence: number; note?: string }[] }[] = [];
  const ambiguities: Ambiguity[] = [];
  const endLoc = {} as Record<End, { signal: LocationSignal; name: string | null; label: string }>;
  for (const end of ENDS) {
    const typed = (end === 'origin' ? req.origin : req.destination).trim();
    if (!typed) throw new UserFacingError(`Enter the ${end} city.`);
    const r = track(await qloo.searchLocality(typed));
    const names = uniq(r.data.map((e) => (e.name ?? '').trim()).filter(Boolean));
    const res = decide(typed, rankCandidates(typed, names.map((n) => { const e = r.data.find((x) => (x.name ?? '').trim() === n); return { id: e?.entity_id ?? n, name: n, type: e?.type, disambiguation: e?.disambiguation, popularity: e?.popularity }; })));
    const options = res.candidates.slice(0, 5).map((c) => ({ name: c.name, confidence: c.confidence, ...(c.disambiguation ? { note: c.disambiguation } : {}) }));
    const ev = ledger.add(`Resolve ${end}`, r, res.candidates.slice(0, 5).map((c) => `locality candidate: ${c.name} (confidence ${c.confidence})`));
    if (!names.length) {
      emit({ type: 'step', id: `resolve-${end}`, label: `Resolve ${end}: "${typed}"`, status: 'error', detail: r.source === 'synthetic-fixture' ? 'No fixture locality matches this name (synthetic run)' : 'No Qloo locality matches this name', evidence: [ev.id] });
      throw new UserFacingError(`${r.source === 'synthetic-fixture' ? 'The synthetic fixture' : 'Qloo'} has no place matching "${typed}". Check the spelling, or try the nearest large city.`);
    }
    let chosen = req.confirmations?.[typed] ?? null;
    let how: Ambiguity['how'] | null = chosen ? 'user-confirmed' : null;
    if (!chosen) {
      const explicit = typed.includes(',');
      if (res.status === 'ambiguous' && res.candidates.length > 1 && !explicit && !req.autoConfirm) need.push({ typed, candidates: res.candidates.slice(0, 5).map((c) => c.name), options });
      chosen = res.chosen?.name ?? res.candidates[0]!.name;
      if (res.status !== 'unique' && !explicit) how = res.candidates.length > 1 ? 'auto-top-candidate' : 'low-confidence-single';
    }
    if (how && res.status !== 'unique') ambiguities.push({ kind: 'place', query: typed, picked: need.some((n) => n.typed === typed) ? null : chosen, how, candidates: options });
    // signal.location.query is the documented fuzzy form, reported to work for open reads.
    endLoc[end] = { signal: { query: chosen }, name: chosen, label: shortCity(chosen) };
    emit({ type: 'step', id: `resolve-${end}`, label: `Resolve ${end}: "${typed}"`, status: 'ok', detail: `Qloo locality: ${chosen}${how && how !== 'user-confirmed' && res.status !== 'unique' ? ` (not a confident match; ${how === 'auto-top-candidate' ? 'top of ' + res.candidates.length + ' candidates, auto-confirmed' : 'only candidate'})` : ''}`, evidence: [ev.id] });
  }
  if (need.length) {
    emit({ type: 'needs_confirmation', items: need });
    return null;
  }

  const recencyYear = Math.max(1900, Math.min(2100, Math.floor(req.recencyYear ?? now().getUTCFullYear() - 3)));

  // ---------- 2b. Optional LLM planner: chooses Qloo tool calls, then the anchors and theme tag ----------
  let plan: PlannerPlan | undefined;
  let plannerOutcome: PlannerOutcome | undefined;
  if (plannerOn) {
    plannerOutcome = await runPlanner({
      llm: opts.llm!, qloo, ledger, ends: { origin: { signal: endLoc.origin.signal, label: endLoc.origin.label }, destination: { signal: endLoc.destination.signal, label: endLoc.destination.label } },
      titles: parsed.items.slice(0, 20).map((i) => ({ title: i.title, domain: i.domain })), userChoices: req.confirmations, familySafeOnly: req.familySafeOnly, recencyYear,
      hasTheme: !!(req.theme ?? '').trim(), maxSteps: opts.planner?.maxSteps ?? DEFAULT_MAX_STEPS, maxCalls: opts.planner?.maxCalls ?? DEFAULT_MAX_PLANNER_CALLS,
      onDecision: (d) => emit({ type: 'planner', step: d.step, action: d.action, reason: d.reason, args: d.args, result: d.result, status: d.status, ...(d.evidence ? { evidence: d.evidence } : {}) }),
    });
    emit({ type: 'step', id: 'llm-model', label: 'Language model', status: plannerOutcome.status === 'llm_error' || plannerOutcome.status === 'llm_budget' ? 'warn' : 'ok', detail: plannerOutcome.status === 'llm_error' || plannerOutcome.status === 'llm_budget' ? `no answer (${plannerOutcome.reason ?? plannerOutcome.status}); the scripted workflow runs instead` : `answered by ${opts.llm!.name}` });
    if (plannerOutcome.status === 'abstained') throw new UserFacingError(`The planner abstained instead of guessing (${plannerOutcome.reason}). See the decision trace for what it read.`);
    if (plannerOutcome.status === 'needs_user' && plannerOutcome.ask) {
      emit({ type: 'needs_confirmation', items: [{ typed: plannerOutcome.ask.query, candidates: plannerOutcome.ask.candidates.map((c) => c.name) }] });
      return null;
    }
    if (plannerOutcome.status === 'finished') plan = plannerOutcome.plan;
    else emit({ type: 'step', id: 'planner', label: 'LLM planner stopped early', status: 'warn', detail: `${plannerOutcome.status}${plannerOutcome.reason ? `: ${plannerOutcome.reason}` : ''}. Continuing with the scripted anchor rule.` });
  }

  // ---------- 3. Open reads per end: what each city favours (all in parallel) ----------
  const open = { origin: {}, destination: {} } as Record<End, Record<Domain, QlooEntity[]>>;
  const openEv = { origin: {}, destination: {} } as Record<End, Record<Domain, string>>;
  const openJobs = ENDS.flatMap((end) =>
    DOMAINS.map(async (d) => ({ end, d, r: await safe(() => qloo.insights(openReadRequest(d, endLoc[end].signal, { familySafeOnly: req.familySafeOnly, recencyYear }))) })),
  );
  for (const { end, d, r } of await Promise.all(openJobs)) {
    track(r);
    open[end][d] = r.data;
    openEv[end][d] = ledger.add(`Open read: ${DOMAIN_LABEL[d]} at ${endLoc[end].label}`, r, r.data.slice(0, 8).map((e) => `${e.name ?? '?'}: affinity ${fmt(e.query?.affinity)}`)).id;
  }
  for (const end of ENDS) {
    const thin = DOMAINS.filter((d) => open[end][d].length === 0);
    emit({
      type: 'step',
      id: `open-${end}`,
      label: `What ${endLoc[end].label} favours (open location read)`,
      status: thin.length ? 'warn' : 'ok',
      detail: DOMAINS.map((d) => `${DOMAIN_LABEL[d]} ${open[end][d].length}`).join(', ') + (thin.length ? `. No Qloo data here for ${thin.map((d) => DOMAIN_LABEL[d]).join(', ')}` : ''),
      evidence: DOMAINS.map((d) => openEv[end][d]),
    });
  }

  // ---------- 4. Rank local anchor candidates (Qloo's own picks, distinctive first) ----------
  const ranked = {} as Record<End, Record<AnchorDomain, QlooEntity[]>>;
  for (const end of ENDS) {
    const other: End = end === 'origin' ? 'destination' : 'origin';
    ranked[end] = Object.fromEntries(ANCHOR_DOMAINS.map((ad) => {
      const chosen = plan?.anchors[end][ad];
      return [ad, chosen && chosen.length ? chosen : rankedAnchors(open[end][ad] ?? [], open[other][ad] ?? [])];
    })) as Record<AnchorDomain, QlooEntity[]>;
    emit({
      type: 'decision',
      text: `${endLoc[end].label} local anchors, chosen by ${synthetic ? 'the synthetic fixture\'s open read (not Qloo)' : 'Qloo\'s open read'} (preferring ones not also top at the other end). Music: ${names3(ranked[end].artist)}. TV: ${names3(ranked[end].tv_show)}. Films: ${names3(ranked[end].movie)}. Each domain is scored with anchors from other domains, so no anchor can rank itself.`,
      evidence: [openEv[end].artist, openEv[end].tv_show, openEv[end].movie],
    });
  }

  // ---------- 5. Resolve catalogue titles ----------
  const resolved: (CatalogueItem & { entity: QlooEntity; ev: string; flag?: string })[] = [];
  const unresolved: { title: string; reason: string }[] = parsed.rejected.map((r) => ({ title: r.text, reason: r.reason }));
  await mapLimit(parsed.items, 4, async (item) => {
    const r = track(await safe(() => qloo.searchTitle(item.title, item.domain)));
    const cands = r.data.filter((e) => e.entity_id);
    const rc = rankCandidates(item.title, cands.map((e) => ({ id: e.entity_id, name: e.name, type: e.type, popularity: e.popularity })));
    const dec = decide(item.title, rc);
    let pick = cands.find((e) => e.entity_id === rc[0]?.id) ?? cands[0];
    let byYearPick = false;
    let flag: string | undefined;
    if (item.year && cands.length) {
      const byYear = cands.find((e) => e.properties?.release_year === item.year);
      if (byYear) { pick = byYear; byYearPick = true; }
      else if (cands.some((e) => typeof e.properties?.release_year === 'number')) flag = `no ${item.year} release found; using the ${pick?.properties?.release_year ?? 'undated'} match`;
    }
    if (pick && normalizeTitle(pick.name ?? '') !== normalizeTitle(item.title)) flag = `${flag ? flag + '; ' : ''}matched as "${pick.name ?? ''}"`;
    if (pick && dec.status === 'ambiguous' && !byYearPick && rc.length > 1) {
      ambiguities.push({ kind: 'title', query: label(item.title), picked: pick.name ?? null, how: 'provisional-top-candidate', candidates: rc.slice(0, 4).map((c) => ({ name: c.name, confidence: c.confidence })) });
      flag = `${flag ? flag + '; ' : ''}ambiguous: ${rc.slice(0, 3).map((c) => `${c.name} ${c.confidence}`).join(' / ')}`;
    }
    const ev = ledger.add(`Resolve title: ${label(item.title)}`, r, pick ? [`${label(item.title)} -> ${pick.name ?? ''} (${pick.entity_id})`] : ['no match']);
    if (!pick) unresolved.push({ title: label(item.title), reason: `no Qloo ${DOMAIN_LABEL[item.domain].toLowerCase()} match` });
    else resolved.push({ ...item, title: label(item.title), entity: pick, ev: ev.id, ...(flag ? { flag } : {}) });
  });
  resolved.sort((a, b) => a.line - b.line);
  emit({
    type: 'step',
    id: 'resolve-titles',
    label: 'Match catalogue titles to Qloo entities',
    status: unresolved.length ? 'warn' : 'ok',
    detail: `${resolved.length} matched, ${unresolved.length} not matched${resolved.some((r) => r.flag) ? `, ${resolved.filter((r) => r.flag).length} need a check` : ''}`,
  });

  // ---------- 6. Score each domain at each end ----------
  const domainSlates: DomainSlate[] = [];
  const allScored: ScoredTitle[] = [];

  for (const d of DOMAINS) {
    const items = resolved.filter((r) => r.domain === d);
    if (!items.length) continue;
    const ids = uniq(items.map((i) => i.entity.entity_id!));
    if (ids.length < MIN_SCORED) {
      // A catalogue problem, not a city problem: no Qloo calls are spent on it.
      const msg = `Your catalogue has only ${ids.length} ${NOUN[d].replace(/s$/, '')}${ids.length === 1 ? '' : 's'}; add at least ${MIN_SCORED} to rank them for this route.`;
      emit({ type: 'decision', text: `${DOMAIN_LABEL[d]}: ${msg}` });
      const unranked: ScoredTitle[] = items.map((it) => ({
        key: it.entity.entity_id!, title: it.title, domain: d, entityId: it.entity.entity_id!, tags: [], affOrigin: null, affDest: null,
        pctOrigin: null, pctDest: null, fit: 0, side: 'no-signal', evidence: [it.ev],
      }));
      allScored.push(...unranked);
      domainSlates.push({ domain: d, label: DOMAIN_LABEL[d], mode: 'anchored', readings: 0, slots: slots[d], scale: 'route', picks: [], bench: [], cut: [], familyRemoved: [], withheld: [], abstained: msg, separationTau: null, notes: [] });
      continue;
    }
    let mode: ReadMode = 'anchored';
    const readingsByEnd = { origin: 0, destination: 0 } as Record<End, number>;
    const notes: string[] = [];
    const perEnd = {} as Record<End, ConsensusResult>;
    const evByEnd = { origin: [], destination: [] } as Record<End, string[]>;
    const callInfo = new Map<string, CallInfo[]>();
    const affFirst = { origin: new Map(), destination: new Map() } as Record<End, Map<string, number>>;

    for (const end of ENDS) {
      if (opts.scoringMode === 'pinned') {
        const r = track(await safe(() => qloo.insights({ domain: d, location: endLoc[end].signal, onlyEntityIds: ids, take: Math.min(50, ids.length) })));
        const ev = ledger.add(`Pinned read: ${DOMAIN_LABEL[d]} at ${endLoc[end].label}`, r, r.data.map((e) => `${e.name ?? '?'}: affinity ${fmt(e.query?.affinity)}`));
        if (looksCollapsed(ids.length, r.data.length)) {
          emit({ type: 'decision', text: `Pinned location read for ${DOMAIN_LABEL[d]} at ${endLoc[end].label} returned ${r.data.length} of ${ids.length} titles: the location is acting as a filter. Falling back to anchored scoring.`, evidence: [ev.id] });
        } else {
          mode = 'pinned';
          const m = toMap(r.data);
          perEnd[end] = consensus(ids, m);
          readingsByEnd[end] = 1;
          m.forEach((v, k) => affFirst[end].set(k, v));
          evByEnd[end].push(ev.id);
          ids.forEach((id) => pushCall(callInfo, id, { end, reading: 'A', anchorDomain: 'location', anchors: [`location: ${endLoc[end].label}`], affinity: m.get(id) ?? null, evidence: ev.id }));
          continue;
        }
      }
      // Anchored: attempt 0 with ranks 1-3; one recovery attempt with spare anchors or a fallback domain.
      let kept: { c: ConsensusResult; evs: string[]; infos: { set: AnchorSet; ev: string; map: Map<string, number> }[] } | null = null;
      for (const attempt of [0, 1] as const) {
        const sets = anchorSetsFor(d, attempt, ranked[end]);
        if (sets.length < 2) {
          // Two independent readings or nothing: a single reading cannot be checked.
          emit({
            type: 'decision',
            text: attempt === 0
              ? `${DOMAIN_LABEL[d]} at ${endLoc[end].label}: Qloo returned too few local anchors for two independent readings; trying the spare anchors.`
              : `${DOMAIN_LABEL[d]} at ${endLoc[end].label}: no spare anchors for two independent readings, so this end abstains.`,
          });
          continue;
        }
        const reads = await Promise.all(sets.map((s) => safe(() => qloo.insights({ domain: d, anchorEntityIds: s.entities.map((e) => e.entity_id!), onlyEntityIds: ids, take: Math.min(50, ids.length) }))));
        const infos: { set: AnchorSet; ev: string; map: Map<string, number> }[] = [];
        reads.forEach((r, i) => {
          const s = sets[i]!;
          track(r);
          const ev = ledger.add(
            `Anchored read ${s.reading}${attempt ? ' (retry)' : ''}: ${DOMAIN_LABEL[d]} for ${endLoc[end].label}, anchors (${DOMAIN_LABEL[s.domain].toLowerCase()}): ${names3(s.entities)}`,
            r,
            r.data.map((e) => `${e.name ?? '?'}: affinity ${fmt(e.query?.affinity)}`),
          );
          infos.push({ set: s, ev: ev.id, map: toMap(r.data) });
        });
        const c = consensus(ids, infos[0]!.map, infos[1]?.map);
        const evs = infos.map((x) => x.ev);
        const tauTxt = c.tau === null ? 'single reading' : `readings agree (${tauNote(c.tau)})`;
        emit({
          type: 'step',
          id: `score-${d}-${end}-${attempt}`,
          label: `Score ${DOMAIN_LABEL[d]} for ${endLoc[end].label}${attempt ? ' (retry with spare anchors)' : ''}: ${c.readings} anchored reading${c.readings > 1 ? 's' : ''}`,
          status: c.abstain ? 'warn' : 'ok',
          detail: `${Math.round(c.coverage * 100)}% scored, ${tauTxt}${c.withheld.length ? `, ${c.withheld.length} withheld` : ''}${c.abstain ? `. Abstaining: ${c.abstain}` : ''}`,
          evidence: evs,
        });
        kept = { c, evs, infos };
        if (!c.abstain) break;
        if (attempt === 0) emit({ type: 'decision', text: `${DOMAIN_LABEL[d]} at ${endLoc[end].label}: retrying once with the next local anchors before giving up.` });
        else emit({ type: 'decision', text: `${DOMAIN_LABEL[d]} at ${endLoc[end].label}: still unreliable after the retry, so this end abstains.` });
      }
      if (!kept) {
        perEnd[end] = { ...consensus(ids, new Map()), abstain: 'Qloo returned too few local anchors for two independent readings' };
        continue;
      }
      perEnd[end] = kept.c;
      readingsByEnd[end] = kept.c.readings;
      evByEnd[end] = kept.evs;
      kept.infos[0]!.map.forEach((v, k) => affFirst[end].set(k, v));
      for (const info of kept.infos) {
        for (const id of ids) pushCall(callInfo, id, { end, reading: info.set.reading, anchorDomain: info.set.domain, anchors: info.set.entities.map((e) => e.name ?? '?'), affinity: info.map.get(id) ?? null, evidence: info.ev });
      }
    }

    // Ranks over the SAME set of titles at both ends, with no duplicate ranks.
    const o = perEnd.origin;
    const de = perEnd.destination;
    const usable = ENDS.filter((e) => !perEnd[e].abstain);
    const withheldIds = new Set(usable.flatMap((e) => perEnd[e].withheld));
    const common = ids.filter((id) => !withheldIds.has(id) && usable.length > 0 && usable.every((e) => perEnd[e].pct.has(id)));
    const rankAt = (e: End) => {
      const m = new Map<string, number>();
      if (!usable.includes(e)) return m;
      [...common]
        .sort((a, b) => perEnd[e].pct.get(b)! - perEnd[e].pct.get(a)! || titleOf(a).localeCompare(titleOf(b)))
        .forEach((id, i) => m.set(id, i + 1));
      return m;
    };
    function titleOf(id: string) {
      return items.find((i) => i.entity.entity_id === id)?.title ?? id;
    }
    const rO = rankAt('origin');
    const rD = rankAt('destination');
    const n = common.length;
    const pctFromRank = (r: number | undefined) => (r === undefined ? null : n > 1 ? 1 - (r - 1) / (n - 1) : 1);
    // Only compare the cities on enough paired titles, each from two consistent readings.
    const MIN_PAIRED = 5;
    const sep = usable.length === 2 && n >= MIN_PAIRED && usable.every((e) => readingsByEnd[e] === 2) ? endsSeparation(new Map(common.map((id) => [id, pctFromRank(rO.get(id))!])), new Map(common.map((id) => [id, pctFromRank(rD.get(id))!]))) : null;
    if (sep !== null && sep >= ENDS_AGREE_TAU) {
      notes.push(`The two cities rank these ${DOMAIN_LABEL[d].toLowerCase()} almost the same way (${tauNote(sep)}): treat them as a network-wide list.`);
      emit({ type: 'decision', text: `${DOMAIN_LABEL[d]}: the cities agree (${tauNote(sep)}); route-specific programming adds little here.` });
    }

    const scored: ScoredTitle[] = items.map((it) => {
      const id = it.entity.entity_id!;
      const inCommon = common.includes(id);
      const pO = inCommon ? pctFromRank(rO.get(id)) : null;
      const pD = inCommon ? pctFromRank(rD.get(id)) : null;
      let side: ScoredTitle['side'] = withheldIds.has(id) ? 'withheld' : !inCommon ? 'no-signal' : sideOf(pO, pD);
      if (usable.length === 1 && inCommon) side = 'single-end';
      const evidence = [it.ev, ...usable.flatMap((e) => evByEnd[e])];
      return {
        key: id,
        title: it.title,
        domain: d,
        entityId: id,
        ...(it.year ? { year: it.year } : it.entity.properties?.release_year ? { year: it.entity.properties.release_year } : {}),
        ...(it.entity.properties?.content_rating ? { contentRating: String(it.entity.properties.content_rating) } : {}),
        tags: (it.entity.tags ?? []).filter((t) => t.id).slice(0, 8).map((t) => ({ id: t.id!, name: t.name ?? t.id! })),
        affOrigin: affFirst.origin.get(id) ?? null,
        affDest: affFirst.destination.get(id) ?? null,
        pctOrigin: pO,
        pctDest: pD,
        rankOrigin: rO.get(id) ?? null,
        rankDest: rD.get(id) ?? null,
        rankN: n,
        fit: routeFit(pO, pD, originShare),
        side,
        evidence,
        calls: (callInfo.get(id) ?? []).filter((c) => usable.includes(c.end)),
      };
    });
    allScored.push(...scored);
    for (const e of ENDS) if (perEnd[e].abstain) notes.push(`${endLoc[e].label} abstained: ${perEnd[e].abstain}.`);
    if (usable.length === 1) notes.push(`Only ${endLoc[usable[0]!].label} could be read, so these picks reflect one end of the route.`);
    const abstained = usable.length === 0 ? `Neither city could be read reliably for ${DOMAIN_LABEL[d].toLowerCase()}, so Seatback does not rank them.` : null;
    const slate = abstained
      ? { picked: [] as ScoredTitle[], bench: [] as ScoredTitle[], belowFloor: [] as ScoredTitle[], familyRemoved: [] as ScoredTitle[], notes: [] as string[] }
      : buildSlate(scored, { size: slots[d], familySafeOnly: !!req.familySafeOnly });
    slate.notes.forEach((x) => emit({ type: 'decision', text: `${DOMAIN_LABEL[d]}: ${x}` }));
    const cut = slate.belowFloor;
    const withheld = scored
      .filter((s) => s.side === 'withheld' || s.side === 'no-signal')
      .map((s) => ({ title: s.title, reason: s.side === 'withheld' ? 'the two independent readings disagree about this title' : 'Qloo returned no score for it at one or both ends' }));
    domainSlates.push({
      domain: d,
      label: DOMAIN_LABEL[d],
      mode,
      readings: Math.min(...(usable.length ? usable.map((e) => readingsByEnd[e]) : [0])),
      slots: slots[d],
      scale: usable.length === 1 ? 'single-end' : 'route',
      picks: slate.picked.map((p) => ({ ...p, why: whyClaims(p, endLoc, originShare, resolved.find((r) => r.entity.entity_id === p.key)?.flag) })),
      bench: slate.bench.slice(0, 8),
      cut,
      familyRemoved: slate.familyRemoved,
      withheld,
      abstained,
      separationTau: sep,
      notes: [...notes, ...slate.notes],
    });
  }
  for (const ds of domainSlates) for (const p of ds.picks) claims.push(...p.why);

  if (opts.stopAfterSlate) {
    opts.stopAfterSlate.onSlate(domainSlates, calls, !plannerOn ? 'scripted' : plan ? 'llm-planner' : 'planner-fallback');
    return null;
  }

  // ---------- 7. Popular on this route (open reads, not in the catalogue) ----------
  const catalogueIds = new Set(resolved.map((r) => r.entity.entity_id));
  const seenTitles = new Set(parsed.items.map((i) => normalizeTitle(i.title)));
  const rail: RailItem[] = [];
  for (const end of ['destination', 'origin'] as const) {
    for (const d of ['movie', 'tv_show', 'podcast'] as Domain[]) {
      const fresh = open[end][d].filter((x) => {
        const key = normalizeTitle(x.name ?? '');
        if (catalogueIds.has(x.entity_id) || seenTitles.has(key)) return false;
        seenTitles.add(key);
        return true;
      });
      for (const e of fresh.slice(0, end === 'destination' ? 3 : 2)) rail.push({ title: e.name ?? '?', domain: d, end, affinity: e.query?.affinity ?? null, evidence: [openEv[end][d]] });
    }
  }
  emit({ type: 'step', id: 'rail', label: 'Build "popular on this route" leads (not in your catalogue)', status: 'ok', detail: `${rail.length} titles to ask distributors about` });

  // ---------- 8. Demographics of the screen slate ----------
  let demographics: SlateResult['demographics'] = null;
  const screenPicks = domainSlates.filter((s) => s.domain === 'movie' || s.domain === 'tv_show').flatMap((s) => s.picks);
  if (screenPicks.length && canSpend(4, 'audience demographics')) {
    const r = track(await safe(() => qloo.demographics(screenPicks.slice(0, 12).map((p) => p.entityId))));
    const sums: Record<string, number> = {};
    let k = 0;
    for (const b of r.data) {
      const age = b.query?.age;
      if (!age) continue;
      k++;
      for (const band of AGE_BANDS) sums[band] = (sums[band] ?? 0) + (age[band] ?? 0);
    }
    if (k) {
      const avg = AGE_BANDS.map((band) => ({ band, v: (sums[band] ?? 0) / k }));
      const hi = [...avg].sort((a, b) => b.v - a.v)[0]!;
      const lo = [...avg].sort((a, b) => a.v - b.v)[0]!;
      const ev = ledger.add('Demographics of the screen slate', r, avg.map((x) => `${x.band.replace(/_/g, ' ')}: ${signed(x.v)}`));
      demographics = {
        summary: `Across ${k} screen picks the slate leans toward ${hi.band.replace(/_/g, ' ')} (${signed(hi.v)}) and away from ${lo.band.replace(/_/g, ' ')} (${signed(lo.v)}). Relative affinities, not audience shares.`,
        evidence: [ev.id],
      };
      claims.push({ text: demographics.summary, evidence: [ev.id], kind: 'computed' });
      if (lo.v < -0.15) emit({ type: 'decision', text: `The screen slate under-serves ${lo.band.replace(/_/g, ' ')}; consider a bench title for that group.`, evidence: [ev.id] });
      emit({ type: 'step', id: 'demographics', label: 'Check who the screen slate appeals to', status: 'ok', detail: demographics.summary, evidence: [ev.id] });
    } else {
      ledger.add('Demographics of the screen slate', r, ['no demographic data returned']);
      emit({ type: 'step', id: 'demographics', label: 'Check who the screen slate appeals to', status: 'warn', detail: 'No demographic data returned' });
    }
  }

  // ---------- 9. Momentum for the top screen picks ----------
  const endDate = now();
  const startDate = new Date(endDate.getTime() - 84 * 86_400_000);
  const topScreen = canSpend(6, 'momentum (trending)') ? [...screenPicks].sort((a, b) => b.fit - a.fit).slice(0, 3) : [];
  const trends = await Promise.all(topScreen.map((p) => safe(() => qloo.trending({ domain: p.domain, entityId: p.entityId, startDate: iso(startDate), endDate: iso(endDate) }))));
  topScreen.forEach((p, i) => {
    const r = track(trends[i]!);
    const pts = r.data.filter((x) => typeof x.population_percentile === 'number');
    let momentum = 'no trend data';
    if (pts.length >= 2) {
      const latest = pts[0]!.population_percentile!;
      const oldest = pts[pts.length - 1]!.population_percentile!;
      momentum = latest - oldest > 3 ? 'rising' : latest - oldest < -3 ? 'cooling' : 'steady';
      const ev = ledger.add(`Momentum: ${p.title}`, r, [`population percentile ${fmt(oldest)} -> ${fmt(latest)} over ${pts.length} weeks`]);
      p.evidence.push(ev.id);
      p.why.push({ text: `Momentum over the last ${pts.length} weeks: ${momentum} (popularity percentile ${oldest.toFixed(1)} to ${latest.toFixed(1)}).`, evidence: [ev.id], kind: 'qloo' });
      claims.push(p.why[p.why.length - 1]!);
    } else {
      ledger.add(`Momentum: ${p.title}`, r, ['no trend data']);
    }
    (p as { momentum?: string }).momentum = momentum;
  });
  if (screenPicks.length) emit({ type: 'step', id: 'momentum', label: 'Check momentum of the top screen picks (trending)', status: 'ok' });

  // ---------- 10. Taste split (taste analysis per end) ----------
  const topTags = { origin: [], destination: [] } as Record<End, { name: string; affinity: number | null; id?: string }[]>;
  const tasteEv = {} as Record<End, string>;
  const tastes = await Promise.all(ENDS.map((e) => safe(() => qloo.tasteAnalysis({ location: endLoc[e].signal, parentTypes: ['urn:entity:movie', 'urn:entity:tv_show'], take: 12 }))));
  ENDS.forEach((e, i) => {
    const r = track(tastes[i]!);
    topTags[e] = r.data.map((t) => ({ name: t.name ?? '?', affinity: typeof t.query?.affinity === 'number' ? t.query.affinity : null, ...(tagIdOf(t) ? { id: tagIdOf(t)! } : {}) }));
    tasteEv[e] = ledger.add(`Taste analysis: ${endLoc[e].label}`, r, topTags[e].slice(0, 10).map((t) => `${t.name}${t.affinity !== null ? ` (${fmt(t.affinity)})` : ''}`)).id;
  });
  const oNames = new Set(topTags.origin.slice(0, 8).map((t) => t.name));
  const sharedTags = topTags.destination.slice(0, 8).map((t) => t.name).filter((x) => oNames.has(x));
  emit({ type: 'step', id: 'taste', label: 'Compare what defines each city (taste analysis)', status: 'ok', detail: sharedTags.length ? `Shared: ${sharedTags.slice(0, 4).join(', ')}` : 'No shared top tags' });

  // ---------- 10b. Arrival spotlight: the destination's distinctive taste tag drives filter.tags ----------
  let spotlight: Spotlight | null = null;
  {
    const oIds = new Set(topTags.origin.slice(0, 8).map((t) => t.id ?? t.name));
    const tag = topTags.destination.slice(0, 8).find((t) => t.id && !oIds.has(t.id));
    if (!tag?.id) {
      emit({ type: 'decision', text: `Arrival spotlight skipped: ${endLoc.destination.label} has no top taste tag that ${endLoc.origin.label} lacks.`, evidence: [tasteEv.destination, tasteEv.origin].filter(Boolean) });
    } else {
      const r = track(await safe(() => qloo.insights({ ...openReadRequest('movie', endLoc.destination.signal, { familySafeOnly: req.familySafeOnly, recencyYear }), tagIds: [tag.id!], take: 8 })));
      const fresh = r.data.filter((x) => !catalogueIdsOf(resolved).has(x.entity_id) && !parsed.items.some((i) => normalizeTitle(i.title) === normalizeTitle(x.name ?? '')));
      const ev = ledger.add(`Arrival spotlight: films tagged "${tag.name}" favoured in ${endLoc.destination.label}`, r, fresh.slice(0, 6).map((x) => `${x.name ?? '?'}: affinity ${fmt(x.query?.affinity)}`));
      const items = fresh.slice(0, 4).map((x) => ({ title: x.name ?? '?', domain: 'movie' as Domain, end: 'destination' as const, affinity: x.query?.affinity ?? null, evidence: [ev.id, tasteEv.destination] }));
      spotlight = { end: 'destination', city: endLoc.destination.label, tag: { id: tag.id, name: tag.name }, items, evidence: [tasteEv.destination, ev.id] };
      emit({ type: 'step', id: 'spotlight', label: `Arrival spotlight: "${tag.name}" is distinctive to ${endLoc.destination.label}; read films with that tag there (filter.tags)`, status: items.length ? 'ok' : 'warn', detail: items.length ? `${items.length} leads: ${items.map((i) => i.title).join(', ')}` : 'No titles returned for this tag here', evidence: [tasteEv.destination, ev.id] });
    }
  }

  // ---------- 10c. Optional programming theme: /v2/tags discovery, then a themed read per end ----------
  let theme: ThemeResult | null = null;
  const themeQuery = (req.theme ?? '').trim().slice(0, 40);
  if (themeQuery && canSpend(8, 'programming theme')) {
    const r = track(await safe(() => qloo.searchTags({ query: themeQuery, parentTypes: ['urn:entity:movie', 'urn:entity:tv_show'], take: 5 })));
    const tags = r.data.filter((x) => tagIdOf(x));
    const ev = ledger.add(`Tag discovery: "${themeQuery}"`, r, tags.slice(0, 5).map((x) => `${x.name ?? '?'} (${tagIdOf(x)})`));
    const trk = rankCandidates(themeQuery, tags.map((x) => ({ id: tagIdOf(x), name: x.name })));
    const tdec = decide(themeQuery, trk);
    const top = (plan?.themeTag && tags.find((x) => tagIdOf(x) === plan!.themeTag!.id)) || tags.find((x) => tagIdOf(x) === trk[0]?.id) || tags[0];
    if (top && tdec.status === 'ambiguous') ambiguities.push({ kind: 'theme', query: themeQuery, picked: top.name ?? null, how: 'provisional-top-candidate', candidates: trk.slice(0, 5).map((c) => ({ name: c.name, confidence: c.confidence })) });
    if (!top) {
      theme = { query: themeQuery, tag: null, catalogueMatches: [], items: [], note: `Qloo has no film or TV tag matching "${themeQuery}". Try a broader word.`, evidence: [ev.id] };
      emit({ type: 'step', id: 'theme', label: `Resolve theme "${themeQuery}" to a Qloo tag (/v2/tags)`, status: 'warn', detail: 'No matching tag', evidence: [ev.id] });
    } else {
      const tagId = tagIdOf(top)!;
      const tagName = top.name ?? tagId;
      const matches = resolved.filter((x) => (x.entity.tags ?? []).some((t) => (t.id ?? t.tag_id) === tagId)).map((x) => x.title);
      const reads = await Promise.all(ENDS.map((e) => safe(() => qloo.insights({ ...openReadRequest('movie', endLoc[e].signal, { familySafeOnly: req.familySafeOnly, recencyYear }), tagIds: [tagId], take: 6 }))));
      const items: RailItem[] = [];
      const evs = [ev.id];
      const seen = new Set<string>([...parsed.items.map((i) => normalizeTitle(i.title)), ...(spotlight?.items ?? []).map((i) => normalizeTitle(i.title))]);
      ENDS.forEach((e, i) => {
        const rr = track(reads[i]!);
        const rev = ledger.add(`Theme "${tagName}": films favoured in ${endLoc[e].label}`, rr, rr.data.slice(0, 6).map((x) => `${x.name ?? '?'}: affinity ${fmt(x.query?.affinity)}`));
        evs.push(rev.id);
        for (const x of rr.data) {
          const k = normalizeTitle(x.name ?? '');
          if (seen.has(k) || items.filter((it) => it.end === e).length >= 3) continue;
          seen.add(k);
          items.push({ title: x.name ?? '?', domain: 'movie', end: e, affinity: x.query?.affinity ?? null, evidence: [rev.id, ev.id] });
        }
      });
      const note = `Theme "${themeQuery}" resolved to Qloo tag "${tagName}". ${matches.length ? `${matches.length} of your titles carry it: ${matches.slice(0, 4).join(', ')}.` : 'None of your matched titles carry it, so the themed leads below are all new.'}`;
      theme = { query: themeQuery, tag: { id: tagId, name: tagName }, catalogueMatches: matches, items, note, evidence: evs };
      emit({ type: 'step', id: 'theme', label: `Resolve theme "${themeQuery}" to a Qloo tag (/v2/tags), then read it at both ends`, status: 'ok', detail: note, evidence: evs });
    }
  }

  // ---------- 10d. Network fit: cross-domain destinations from the slate's consistency-checked picks ----------
  let network: NetworkFit | null = null;
  {
    const seeds = domainSlates
      .flatMap((ds) => ds.picks)
      .filter((p) => p.side === 'both' || p.side === 'origin' || p.side === 'destination')
      .sort((a, b) => b.fit - a.fit)
      .slice(0, 8);
    if (seeds.length >= 4 && !canSpend(6, 'network fit')) {
      // skipped to protect the call budget (warning emitted)
    } else if (seeds.length < 4) {
      emit({ type: 'decision', text: `Network fit skipped: only ${seeds.length} consistency-checked picks; 4 are needed for two independent destination readings.` });
    } else {
      const [sa, sb] = splitSeeds(seeds);
      const reads = await Promise.all([sa, sb].map((half) => safe(() => qloo.destinations({ seedEntityIds: half.map((p) => p.entityId), countryCode: 'US', take: 50 }))));
      const evIds = reads.map((r, i) => {
        track(r);
        const half = i === 0 ? sa : sb;
        return ledger.add(`Network fit reading ${i === 0 ? 'A' : 'B'}: US destinations favoured by fans of ${half.map((p) => p.title).slice(0, 4).join(', ')}`, r, r.data.slice(0, 12).map((x) => `${x.name ?? '?'}: affinity ${fmt(x.query?.affinity)}`)).id;
      });
      const routeEnds = [endLoc.origin.name ?? endLoc.origin.label, endLoc.destination.name ?? endLoc.destination.label, req.origin, req.destination];
      const fit = networkFit(reads[0]!.data, reads[1]!.data, DEFAULT_NETWORK, routeEnds);
      network = {
        seeds: { a: sa.map((p) => p.title), b: sb.map((p) => p.title) },
        rows: fit.rows,
        tau: fit.tau,
        paired: fit.paired,
        abstain: fit.abstain,
        topDestinations: reads[0]!.data.filter((x) => !isRouteEndName(x, DEFAULT_NETWORK, routeEnds)).slice(0, 6).map((x) => ({ name: x.name ?? '?', affinity: x.query?.affinity ?? null, code: matchCity(x, DEFAULT_NETWORK)?.code ?? null })),
        evidence: evIds,
      };
      const ranked = fit.rows.filter((x) => x.status === 'ranked');
      const detail = fit.abstain
        ? `Withheld: ${fit.abstain}.`
        : `Readings agree (${fit.tau === null ? 'tau n/a' : tauNote(fit.tau)}) over ${fit.paired} network cities. Best other fits: ${ranked.slice(0, 3).map((x) => `${x.code} (${Math.round((x.pct ?? 0) * 100)})`).join(', ')}`;
      emit({ type: 'step', id: 'network', label: "Network fit: where else this slate's audience goes (Qloo destinations, two readings)", status: fit.abstain ? 'warn' : 'ok', detail, evidence: evIds });
      if (!fit.abstain && ranked[0]) {
        const claim = { text: `Beyond this route, the slate's audience most favours ${ranked.slice(0, 3).map((x) => x.city).join(', ')} on your network (two destination readings agree: ${tauNote(fit.tau!)}).`, evidence: evIds, kind: 'computed' as const };
        claims.push(claim);
      }
    }
  }

  // ---------- 11. Grounding, programmer's note, comparison ----------
  const grounding = checkGrounding(claims, ledger);
  emit({ type: 'step', id: 'grounding', label: 'Validate every claim against the evidence ledger', status: grounding.rate === 1 ? 'ok' : 'warn', detail: `${grounding.grounded}/${grounding.total - grounding.interpretation} factual claims grounded` });

  const toRef = (l: QlooEntity[]) => l.slice(0, 3).map((x) => ({ id: x.entity_id!, name: x.name ?? '' }));
  const routeSummary: EndSummary[] = ENDS.map((e) => ({
    label: endLoc[e].label,
    typed: e === 'origin' ? req.origin : req.destination,
    localityName: endLoc[e].name,
    coverage: Object.fromEntries(DOMAINS.map((d) => [d, open[e][d].length])) as Record<Domain, number>,
    anchors: { artist: toRef(ranked[e].artist), tv_show: toRef(ranked[e].tv_show), movie: toRef(ranked[e].movie) },
    topTags: topTags[e],
  }));

  const programmerNote = await writeProgrammerNote(opts.llm, domainSlates, routeSummary, ledger, emit);
  const swap = req.swap === false || !canSpend(45, 'swap test') ? null : await runSwapTest(req, opts, { network, domainSlates, endLoc, originShare, synthetic, plannerUsed: !!plan });
  const comparison = req.compare === false ? null : await runComparison({ llm: opts.llm, req, domainSlates, allScored, resolved, slots, origin: endLoc.origin.label, destination: endLoc.destination.label, emit, synthetic });

  const result: SlateResult = {
    version: 1,
    source: qloo.source,
    generatedAt: now().toISOString(),
    route: { origin: routeSummary[0]!, destination: routeSummary[1]!, originShare },
    sharedTags,
    domains: domainSlates,
    rail,
    network,
    spotlight,
    theme,
    usage: qlooUsage(ledger.records),
    unresolved,
    demographics,
    programmerNote,
    claims,
    grounding,
    comparison,
    swap,
    evidence: ledger.records,
    metrics: { qlooCalls: calls, cachedCalls, ms: Date.now() - t0 },
    limits: [...LIMITS(qloo.source), ...(ledger.records.some((e) => e.path === 'error') ? ['DEGRADED RUN: some Qloo calls failed (server error, missing endpoint or similar), so data is MISSING where it says so; it is not evidence of "no result". Do not record or cite this run as a complete live result.'] : []), ...(skipped.length ? [`Skipped to protect the call budget: ${skipped.join(', ')}.`] : [])],
    ambiguities,
    workflow: {
      kind: !plannerOn ? 'scripted' : plan ? 'llm-planner' : 'planner-fallback',
      label: !plannerOn ? workflowLabel : plan ? `LLM planner (${opts.llm!.name})` : plannerOutcome?.status === 'llm_budget' ? 'scripted workflow (LLM budget reached)' : `scripted workflow (planner stopped: ${plannerOutcome?.status}${plannerOutcome?.status === 'llm_error' && plannerOutcome.reason ? ': ' + plannerOutcome.reason : ''})`,
      ...(plannerOutcome ? { planner: { status: plannerOutcome.status, steps: plannerOutcome.steps, qlooCalls: plannerOutcome.qlooCalls, llm: opts.llm!.name } } : {}),
    },
    ...(plannerOutcome ? { plannerDecisions: plannerOutcome.decisions } : {}),
    degraded: ledger.records.filter((e) => e.path === 'error').map((e) => ({ step: e.step, reason: e.params.error ?? 'failed' })),
    skipped,
    ...statusOf(qloo),
    trace,
  };
  emit({ type: 'result', result });
  return result;
}

/**
 * Swap test: re-run the slate with one end of the route replaced by a network city and count how
 * many of this route's picks change. Slate-only (no network, note or comparison), no LLM. Any
 * failure or incomparable result is reported as "not run" with the reason, never as a number.
 */
async function runSwapTest(
  req: SlateRequest,
  opts: PipelineOptions,
  ctx: { network: NetworkFit | null; domainSlates: DomainSlate[]; endLoc: Record<End, { label: string; name: string | null }>; originShare: number; synthetic: boolean; plannerUsed: boolean },
): Promise<SwapTest> {
  const { network, domainSlates, endLoc, originShare, synthetic, plannerUsed } = ctx;
  const notRun = (reason: string): SwapTest => {
    opts.emit({ type: 'decision', text: `Swap test not run: ${reason}.` });
    return { ran: false, reason };
  };
  if (!domainSlates.some((d) => d.picks.length)) return notRun('there are no picks to compare');
  const cands = swapCandidates(network);
  if (!cands.length) return notRun(network?.abstain ? 'the network ranking was withheld, so there is no principled comparison route' : 'no network ranking to choose a comparison route from');
  const swapEnd = endToSwap(originShare);
  const keptEnd: End = swapEnd === 'origin' ? 'destination' : 'origin';
  let swapCalls = 0;
  const skipped: string[] = [];
  for (const pick of cands) {
    let swapped: DomainSlate[] | null = null;
    let swappedKind = 'scripted';
    try {
      await runPipeline(
        { ...req, [swapEnd]: pick.city, autoConfirm: true, compare: false, swap: false, theme: undefined },
        // Same planning method as the main run, so "picks changed" measures only the route (N1): the planner runs
        // on the comparison route iff it produced the main slate. If it cannot, the comparison is refused below.
        { ...opts, llm: plannerUsed ? opts.llm : null, planner: plannerUsed ? opts.planner : undefined, emit: () => {}, stopAfterSlate: { onSlate: (d, c, k) => { swapped = d; swapCalls += c; swappedKind = k; } } },
      );
    } catch (e) {
      skipped.push(`${pick.city}: could not be built (${(e as Error).message})`);
      continue;
    }
    const bad = swapped ? (plannerUsed && swappedKind !== 'llm-planner' ? 'the planner did not run on the comparison route, so the two slates were built differently' : incomparable(domainSlates, swapped)) : 'it produced no slate';
    if (bad || !swapped) {
      skipped.push(`${pick.city}: ${bad}`);
      continue;
    }
    const counts = countChanged(domainSlates, swapped);
    const kept = endLoc[keptEnd].label;
    const replaced = endLoc[swapEnd].label;
    const cmpCity = synthetic && !/\(synthetic\)$/.test(pick.city) ? `${pick.city} (synthetic)` : pick.city;
    const against = swapEnd === 'destination' ? `${kept} to ${cmpCity}` : `${cmpCity} to ${kept}`;
    const text = swapText({ changed: counts.changed, total: counts.total, against });
    const basis =
      `Comparison route: ${kept} kept, ${replaced} replaced by ${pick.city}, ` +
      (skipped.length ? `the lowest-ranked of your network's ${pick.rankedCount} ranked cities that gave a comparable slate (skipped: ${skipped.join('; ')}). ` : `the network city (of ${pick.rankedCount} ranked) whose audience Qloo says favours this slate least. `) +
      'That is a large contrast on your network: a nearer route would change fewer picks. Same catalogue, same passenger mix.';
    opts.emit({ type: 'decision', text: `${text} ${basis}` });
    return { ran: true, against, kept, replaced, ...counts, qlooCalls: swapCalls, synthetic, text, basis };
  }
  return notRun(`no comparison route gave a comparable slate (${skipped.join('; ')})`);
}

export function LIMITS(source: string): string[] {
  return [
    ...(source === 'synthetic-fixture' ? ['THIS RUN USES SYNTHETIC FIXTURE DATA. No number on this page came from Qloo, and every title is labelled "(synthetic)".'] : []),
    'Qloo measures the taste of audiences associated with a place or with anchor entities. It does not know who is on a given flight.',
    'The passenger mix (origin share) is your assumption. Change it and the fit scores change.',
    'Qloo does not know licence availability, cost or windows. Seatback ranks the catalogue you can license; "popular on this route" titles are leads to check.',
    'Content ratings are US-style (MPAA and TV Parental Guidelines), as documented by Qloo. Airlines may apply their own edits and standards.',
    'Ranks are relative within your catalogue. They are not viewing forecasts, and no in-flight viewing data was used.',
    'Titles where two independent readings disagree are withheld, and a city whose readings disagree overall abstains rather than guessing.',
  ];
}

function whyClaims(p: ScoredTitle, endLoc: Record<End, { label: string }>, w: number, flag?: string): Claim[] {
  const out: Claim[] = [];
  const evScore = p.evidence.slice(1);
  const noun = NOUN[p.domain];
  const n = p.rankN ?? 0;
  const parts: string[] = [];
  if (p.rankOrigin) parts.push(`#${p.rankOrigin} of ${n} for ${endLoc.origin.label}`);
  if (p.rankDest) parts.push(`#${p.rankDest} of ${n} for ${endLoc.destination.label}`);
  if (parts.length) out.push({ text: `Ranks ${parts.join(' and ')} among your ${noun}.`, evidence: evScore, kind: 'computed' });
  if (p.side === 'single-end') {
    const which = p.rankOrigin ? endLoc.destination.label : endLoc.origin.label;
    out.push({ text: `Single-end pick: ${which} could not be read reliably, so this says nothing about how the two cities compare.`, evidence: evScore, kind: 'computed' });
  }
  if (p.side === 'single-end') out.push({ text: `One-city rank score ${Math.round(p.fit * 100)} (a rank within your catalogue at one city; not a route fit, so it is not comparable with route-fit scores).`, evidence: evScore, kind: 'computed' });
  else out.push({ text: `Route fit ${Math.round(p.fit * 100)} at a ${Math.round(w * 100)}/${Math.round((1 - w) * 100)} origin/destination passenger mix.`, evidence: evScore, kind: 'computed' });
  if (p.side === 'origin') out.push({ text: `An origin favourite: ${endLoc.origin.label} ranks it well above ${endLoc.destination.label} does.`, evidence: evScore, kind: 'computed' });
  if (p.side === 'destination') out.push({ text: `A destination favourite: ${endLoc.destination.label} ranks it well above ${endLoc.origin.label} does.`, evidence: evScore, kind: 'computed' });
  if (flag) out.push({ text: `Check the match: ${flag}.`, evidence: [p.evidence[0]!], kind: 'qloo' });
  return out;
}

async function safeFor<T>(source: 'qloo-live' | 'synthetic-fixture', fn: () => Promise<{ data: T[]; request: { path: string; params: Record<string, string> }; source: 'qloo-live' | 'synthetic-fixture'; cached: boolean; ms: number }>) {
  try {
    return await fn();
  } catch (e) {
    // Auth, budget, rate-limit and network problems stop the run with a clear message; data gaps do not.
    if (!(e instanceof QlooError) || ['auth', 'budget', 'rate_limited', 'network', 'timeout'].includes(e.kind)) throw e;
    return { data: [] as T[], request: { path: 'error', params: { error: e.message } }, source, cached: false, ms: 0 };
  }
}

async function mapLimit<T>(items: T[], n: number, fn: (t: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]!);
    }),
  );
}

function toMap(list: QlooEntity[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const e of list) if (e.entity_id && typeof e.query?.affinity === 'number') m.set(e.entity_id, e.query.affinity);
  return m;
}

function pushCall(m: Map<string, CallInfo[]>, id: string, c: CallInfo) {
  const l = m.get(id) ?? [];
  l.push(c);
  m.set(id, l);
}

function catalogueIdsOf(resolved: { entity: QlooEntity }[]): Set<string | undefined> {
  return new Set(resolved.map((r) => r.entity.entity_id));
}

const NOUN: Record<Domain, string> = { movie: 'films', tv_show: 'TV shows', podcast: 'podcasts', artist: 'music artists' };
const uniq = <T>(l: T[]) => [...new Set(l)];
const clamp01 = (x: number) => (Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0.5);
const fmt = (x: number | undefined | null) => (typeof x === 'number' ? (Math.round(x * 1000) / 1000).toString() : 'n/a');
const signed = (x: number) => `${x >= 0 ? '+' : ''}${x.toFixed(2)}`;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const names3 = (l: QlooEntity[]) => l.slice(0, 3).map((e) => e.name ?? '?').join(', ') || 'none';
/** "Portland, Oregon (synthetic)" -> "Portland (synthetic)": the synthetic label is never dropped. */
export function shortCity(s: string) {
  const syn = / \(synthetic\)$/.test(s);
  const base = s.replace(/ \(synthetic\)$/, '').split(',')[0]!.trim();
  return syn ? `${base} (synthetic)` : base;
}
