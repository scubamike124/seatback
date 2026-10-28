/**
 * Evidence ledger. Every Qloo call the run makes becomes an evidence record (E1, E2, ...)
 * with its endpoint, exact parameters (never the key), source (live or synthetic) and the
 * specific values the run read from it. Every claim in a slate must cite at least one record.
 */
import type { QlooResult } from '../qloo/types.ts';

export interface EvidenceRecord {
  id: string;
  step: string;
  path: string;
  params: Record<string, string>;
  source: 'qloo-live' | 'synthetic-fixture';
  cached: boolean;
  ms: number;
  resultCount: number;
  /** Human-readable facts read from this call, e.g. "Paper Comets affinity 0.81 at MSP". */
  facts: string[];
  /** Who chose this call: the LLM planner, or the scripted workflow (default). */
  by?: 'llm-planner' | 'scripted';
}

export interface Claim {
  text: string;
  evidence: string[];
  /** 'qloo' = a fact read from Qloo; 'computed' = arithmetic on Qloo facts; 'interpretation' = ours. */
  kind: 'qloo' | 'computed' | 'interpretation';
}

export class EvidenceLedger {
  readonly records: EvidenceRecord[] = [];

  add(step: string, r: QlooResult<unknown[]>, facts: string[] = []): EvidenceRecord {
    const rec: EvidenceRecord = {
      id: `E${this.records.length + 1}`,
      step,
      path: r.request.path,
      params: { ...r.request.params },
      source: r.source,
      cached: r.cached,
      ms: r.ms,
      resultCount: Array.isArray(r.data) ? r.data.length : 0,
      facts: facts.slice(0, 40),
    };
    this.records.push(rec);
    return rec;
  }

  addFacts(id: string, facts: string[]): void {
    const rec = this.records.find((r) => r.id === id);
    if (rec) rec.facts.push(...facts.slice(0, Math.max(0, 40 - rec.facts.length)));
  }

  has(id: string): boolean {
    return this.records.some((r) => r.id === id);
  }
}

export interface GroundingReport {
  total: number;
  grounded: number;
  interpretation: number;
  rate: number;
  ungrounded: string[];
}

/**
 * Validator: a 'qloo' or 'computed' claim is grounded only if every cited ID exists in the
 * ledger and it cites at least one. Interpretation claims are counted separately and must be
 * labelled as such in the UI.
 */
export function checkGrounding(claims: Claim[], ledger: EvidenceLedger): GroundingReport {
  let grounded = 0;
  let interpretation = 0;
  const ungrounded: string[] = [];
  for (const c of claims) {
    if (c.kind === 'interpretation') {
      interpretation++;
      continue;
    }
    if (c.evidence.length > 0 && c.evidence.every((id) => ledger.has(id))) grounded++;
    else ungrounded.push(c.text);
  }
  const factual = claims.length - interpretation;
  return { total: claims.length, grounded, interpretation, rate: factual === 0 ? 1 : grounded / factual, ungrounded };
}
