// Deterministic FAKE LLM for the planner loop tests. It is NOT a model: it is a function of the prompt.
// These tests prove the loop mechanics and guards, not the quality of any real model's choices.
import type { LlmProvider } from '../../src/llm/provider.ts';

export interface FakeCtx {
  step: number;
  last: string;
  callsLeft: number;
  data: { route: any; catalogue_titles: any[]; user_choices: Record<string, string>; history: { n: number; action: string; args: string; reason: string; result: string }[] };
  prompt: string;
  /** ids ("ID | name | affinity" rows) in the most recent history result */
  idsInLast: string[];
}
export type Policy = (c: FakeCtx) => string | Error;

export class FakeLlm implements LlmProvider {
  readonly name = 'fake-llm:deterministic';
  readonly prompts: string[] = [];
  readonly #policy: Policy;
  constructor(policy: Policy) { this.#policy = policy; }
  async completeJson(prompt: string): Promise<string> {
    this.prompts.push(prompt);
    const m = /STEP (\d+) of (\d+)\. QLOO_CALLS_LEFT: (\d+)\. LAST_RESULT_STATUS: (\w+)\./.exec(prompt)!;
    const block = /<<<DATA\n([\s\S]*)\nDATA>>>/.exec(prompt)!;
    const data = JSON.parse(block[1]!);
    const lastRes: string = data.history.at(-1)?.result ?? '';
    const idsInLast = [...lastRes.matchAll(/(?:^|[:;] )([A-Za-z0-9:_-]+) \| /g)].map((x) => x[1]!);
    const out = this.#policy({ step: Number(m[1]), callsLeft: Number(m[3]), last: m[4]!, data, prompt, idsInLast });
    if (out instanceof Error) throw out;
    return out;
  }
}
export const act = (action: string, args: unknown = {}, reason = 'because') => JSON.stringify({ action, args, reason });
