/**
 * Pluggable LLM layer. The LLM never ranks titles in Seatback's own slate: Qloo data and the
 * code in agent/scoring.ts do that. The LLM is used for two things only:
 *   1. the "LLM-only" baseline slate (the comparison judges can inspect), and
 *   2. a short programmer's note written strictly from the computed facts, validated afterwards.
 *
 * Providers:
 * - gemini:     Google Gemini API (free tier available). Key from env GEMINI_API_KEY, sent in the
 *               `x-goog-api-key` header. Free-tier prompts may be used by Google to improve its
 *               products, so Seatback sends only route names and title lists, never personal data.
 * - workers-ai: Cloudflare Workers AI binding `AI` (free daily allocation).
 * - none:       no LLM; deterministic templates and a naive baseline are used instead.
 * Keys are read from the environment at runtime and never hard-coded or logged.
 */
export interface LlmProvider {
  readonly name: string;
  /** Returns the model's text (expected to be JSON). Throws on transport failure. */
  completeJson(prompt: string, opts?: { temperature?: number; maxTokens?: number }): Promise<string>;
}

/** A model failure with a SAFE, fixed public reason (never the provider's body, which could echo a key or prompt). */
export class LlmError extends Error {
  readonly kind: 'rate_limited' | 'empty' | 'blocked' | 'truncated' | 'http' | 'budget';
  readonly publicReason: string;
  /** HTTP status when the failure was an HTTP one (404 / 403 / 5xx ...). */
  readonly status?: number;
  constructor(kind: LlmError['kind'], publicReason: string, status?: number) { super(publicReason); this.kind = kind; this.publicReason = publicReason; if (status !== undefined) this.status = status; }
}

export interface AiBinding {
  run(model: string, input: { messages: { role: string; content: string }[]; max_tokens?: number; temperature?: number }): Promise<{ response?: string } | unknown>;
}

export const GEMINI_FALLBACK_MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash'] as const;

/** Gemini REST provider with a model fallback list: GEMINI_MODEL first (if set), then gemini-2.5-flash, then gemini-2.0-flash.
 *  A model that is missing or not allowed for the key (404 / 403), rate limited (429), failing (5xx) or answering with a body that
 *  is not JSON is skipped for that call and the next model is tried. If every model fails the call throws an LlmError with a fixed
 *  reason and the pipeline falls back to the scripted workflow with a visible label. `name` shows the model that last answered. */
export class GeminiProvider implements LlmProvider {
  readonly #key: string;
  readonly #models: string[];
  readonly #fetch: typeof fetch;
  #answered: string | null = null;
  /** model:status pairs of the last call's failed attempts (no key, no body text) */
  lastAttempts: string[] = [];
  constructor(key: string, model?: string, fetchImpl?: typeof fetch) {
    this.#key = key;
    this.#models = [...new Set([...(model ? [model] : []), ...GEMINI_FALLBACK_MODELS])];
    this.#fetch = fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  }
  get name(): string { return `gemini:${this.#answered ?? this.#models[0]}`; }
  get models(): readonly string[] { return this.#models; }

  async #one(model: string, prompt: string, opts: { temperature?: number; maxTokens?: number }): Promise<string> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const res = await this.#fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': this.#key },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: opts.temperature ?? 0.4,
          maxOutputTokens: opts.maxTokens ?? 2048,
          // Gemini 2.5 Flash spends output tokens on hidden "thinking" unless told not to; that starved short JSON replies.
          ...(/2\.5-flash/.test(model) ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
        },
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 429) throw new LlmError('rate_limited', 'Gemini rate limit reached (HTTP 429)', 429);
    if (!res.ok) throw new LlmError('http', `Gemini returned HTTP ${res.status}`, res.status);
    let j: any;
    try { j = await res.json(); } catch { throw new LlmError('http', 'Gemini returned a body that is not JSON', 200); }
    if (j?.promptFeedback?.blockReason) throw new LlmError('blocked', 'Gemini blocked the prompt');
    const cand = j?.candidates?.[0];
    const text = cand?.content?.parts?.map((p: any) => p?.text ?? '').join('') ?? '';
    if (cand?.finishReason === 'SAFETY' || cand?.finishReason === 'RECITATION') throw new LlmError('blocked', 'Gemini blocked the reply');
    if (!text.trim()) throw new LlmError('empty', 'Gemini returned no text');
    if (cand?.finishReason === 'MAX_TOKENS') throw new LlmError('truncated', 'Gemini reply was cut off at the output-token limit');
    return text;
  }

  async completeJson(prompt: string, opts: { temperature?: number; maxTokens?: number } = {}): Promise<string> {
    this.lastAttempts = [];
    let last: LlmError | null = null;
    for (const model of this.#models) {
      try {
        const text = await this.#one(model, prompt, opts);
        this.#answered = model;
        return text;
      } catch (e) {
        if (!(e instanceof LlmError)) { this.lastAttempts.push(`${model}:network`); last = new LlmError('http', 'Gemini could not be reached'); continue; }
        last = e;
        this.lastAttempts.push(`${model}:${e.status ?? e.kind}`);
        // A blocked prompt is blocked everywhere: do not spend the other models on it.
        if (e.kind === 'blocked') throw e;
      }
    }
    throw new LlmError(last?.kind ?? 'http', `Gemini: no model answered (${this.lastAttempts.join(', ')})`, last?.status);
  }
}

export class WorkersAiProvider implements LlmProvider {
  readonly name: string;
  readonly #ai: AiBinding;
  readonly #model: string;
  constructor(ai: AiBinding, model = '@cf/meta/llama-3.1-8b-instruct') {
    this.#ai = ai;
    this.#model = model;
    this.name = `workers-ai:${model}`;
  }
  async completeJson(prompt: string, opts: { temperature?: number; maxTokens?: number } = {}): Promise<string> {
    const out: any = await this.#ai.run(this.#model, {
      messages: [
        { role: 'system', content: 'Reply with a single JSON object and nothing else.' },
        { role: 'user', content: prompt },
      ],
      max_tokens: opts.maxTokens ?? 1200,
      temperature: opts.temperature ?? 0.4,
    });
    const text = typeof out?.response === 'string' ? out.response : JSON.stringify(out?.response ?? '');
    if (!text) throw new Error('Workers AI returned no text');
    return text;
  }
}

/** Extracts the first JSON object from model text (models sometimes wrap it in fences). */
export function parseJsonLoose(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(t);
  } catch {
    const s = t.indexOf('{');
    const e = t.lastIndexOf('}');
    if (s >= 0 && e > s) return JSON.parse(t.slice(s, e + 1));
    throw new Error('model output was not JSON');
  }
}

export interface LlmEnv {
  LLM_PROVIDER?: string;
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
  WORKERS_AI_MODEL?: string;
  AI?: AiBinding;
}

export function providerFromEnv(env: LlmEnv): LlmProvider | null {
  const choice = (env.LLM_PROVIDER ?? 'gemini').toLowerCase();
  if (choice === 'none') return null;
  if (choice === 'workers-ai') return env.AI ? new WorkersAiProvider(env.AI, env.WORKERS_AI_MODEL) : null;
  if (choice === 'gemini') return env.GEMINI_API_KEY ? new GeminiProvider(env.GEMINI_API_KEY, env.GEMINI_MODEL) : env.AI ? new WorkersAiProvider(env.AI, env.WORKERS_AI_MODEL) : null;
  return null;
}
