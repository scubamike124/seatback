/** Caps LLM calls per run (always) and per visitor / per day (when a ledger is given), in EVERY data mode.
 *  Over budget it throws LlmError('budget'); callers fall back to the scripted workflow, labelled. */
import { LlmError, type LlmProvider } from './provider.ts';
import type { CallBudgetLedger } from '../ratelimit.ts';

export const DEFAULT_LLM_CALLS_PER_RUN = 12; // planner (<=10 steps) + note + baseline; env LLM_CALLS_PER_RUN
export const DEFAULT_EXAMPLE_LLM_CALLS = 40; // owner warm-up: planner + swap planner + note + baseline
export const DEFAULT_DAILY_LLM_CALLS = 150; // env DAILY_LLM_CALL_CAP
export const DEFAULT_VISITOR_LLM_CALLS = 24; // env PER_VISITOR_LLM_CALL_CAP

export class BudgetedLlm implements LlmProvider {
  get name(): string { return this.#inner.name; }
  used = 0;
  readonly #inner: LlmProvider;
  readonly #perRun: number;
  readonly #ledger?: CallBudgetLedger;
  readonly #visitor: string;
  readonly #skipVisitor: boolean;
  constructor(inner: LlmProvider, perRun: number, opts: { ledger?: CallBudgetLedger; visitor?: string; skipVisitor?: boolean } = {}) {
    this.#inner = inner; this.#perRun = perRun; this.#ledger = opts.ledger; this.#visitor = opts.visitor ?? 'anon'; this.#skipVisitor = opts.skipVisitor ?? false;
  }
  async completeJson(prompt: string, o?: { temperature?: number; maxTokens?: number }): Promise<string> {
    if (this.used >= this.#perRun) throw new LlmError('budget', 'LLM budget reached for this run');
    if (this.#ledger) {
      const r = await this.#ledger.reserve(this.#visitor, 1, this.#skipVisitor);
      if (!r.ok) throw new LlmError('budget', r.reason === 'visitor' ? "LLM allowance for this visitor is used up today" : "Today's LLM budget is used up");
    }
    this.used++; // charged per attempt, success or not
    return this.#inner.completeJson(prompt, o);
  }
}
