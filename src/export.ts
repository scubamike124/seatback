/** Trims a finished result before it is RECORDED (private KV) or exported. The evidence ledger keeps
 *  only what a citation needs: id, step, endpoint, request parameters, source, counts, and a few short
 *  fact lines for records the result actually cites. Raw Qloo bodies are never in the ledger; this
 *  also bounds how much derived text from them is stored. */
import type { SlateResult } from './agent/types.ts';

export const MAX_FACTS = 3;
export const MAX_FACT_CHARS = 140;
const ID = /^E\d+$/;

function citedIds(v: unknown, out: Set<string>): void {
  if (typeof v === 'string') { if (ID.test(v)) out.add(v); }
  else if (Array.isArray(v)) v.forEach((x) => citedIds(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => citedIds(x, out));
}

export function trimForRecording(result: SlateResult): SlateResult {
  const { evidence, ...rest } = result;
  const cited = new Set<string>();
  citedIds(rest, cited);
  const trimmed = evidence.map((e) => {
    const keep = cited.has(e.id);
    return { ...e, facts: keep ? e.facts.slice(0, MAX_FACTS).map((f) => f.slice(0, MAX_FACT_CHARS)) : [] };
  });
  const out: SlateResult = { ...rest, evidence: trimmed } as SlateResult;
  if (out.plannerDecisions) out.plannerDecisions = out.plannerDecisions.map((d) => ({ ...d, result: d.result.slice(0, 200), args: d.args.slice(0, 200) }));
  return out;
}

/** Gate for recording a result as a judge example. The stored run must be what the example claims to be:
 *  complete (no failed or skipped steps) and produced by the method this deployment advertises. */
export function recordable(result: SlateResult, cfg: { llmConfigured: boolean; plannerEnabled: boolean }): { ok: true } | { ok: false; why: string } {
  if (result.degraded?.length) return { ok: false, why: 'a Qloo call failed (degraded run)' };
  if (result.skipped?.length) return { ok: false, why: `steps were skipped to protect the call budget: ${result.skipped.join(', ')}` };
  const want = cfg.llmConfigured && cfg.plannerEnabled ? 'llm-planner' : 'scripted';
  const got = result.workflow?.kind ?? 'scripted';
  if (got !== want) return { ok: false, why: `workflow is "${got}" (${result.workflow?.label ?? '?'}) but this example is meant to be "${want}"` };
  if (result.swap && result.swap.ran === false && want === 'llm-planner') return { ok: false, why: `the swap test did not run: ${(result.swap as { reason?: string }).reason ?? ''}` };
  return { ok: true };
}
