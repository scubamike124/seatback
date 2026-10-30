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

// Google's models page (read 2026-10-26): "Gemini 2.0 Flash (Shut down)"; "we are limiting access to the 2.5 models to users who have actively used them in the past ... For any new
// projects, use our latest models: 3.5 Flash-Lite or 3.8 Flash." So the models a NEW project can use come first and the 2.5 model last (it still answers for accounts that used it before).
export const GEMINI_FALLBACK_MODELS = ['gemini-3.5-flash-lite', 'gemini-3.8-flash', 'gemini-2.5-flash'] as const;

/** Gemini REST provider with a model fallback list: GEMINI_MODEL first (if set), then gemini-3.5-flash-lite, gemini-3.8-flash, gemini-2.5-flash. With `strict` (set by providerFromEnv whenever GEMINI_MODEL is set) the named model is the ONLY one tried: an explicit choice is never silently replaced.
 *  A model that is missing or not allowed for the key (404 / 403), rate limited (429), failing (5xx) or answering with a body that
 *  is not JSON is skipped for that call and the next model is tried. If every model fails the call throws an LlmError with a fixed
 *  reason and the pipeline falls back to the scripted workflow with a visible label. `name` shows the model that last answered. */
/** Text of an Interactions API reply: `output_text` when the reply has it, else the text blocks of the model steps (thought, user and function-call steps skipped). `via` says which carried it. */
export function interactionText(j: any): { text: string; via: 'output_text' | 'steps' | 'none' } {
  if (typeof j?.output_text === 'string' && j.output_text.trim()) return { text: j.output_text, via: 'output_text' };
  if (Array.isArray(j?.steps)) {
    const parts: string[] = [];
    const walk = (n: any, skip: boolean) => { if (!n || typeof n !== 'object') return; if (Array.isArray(n)) { n.forEach((x) => walk(x, skip)); return; } const sk = skip || /thought|user|function_call/i.test(String(n.type ?? '')); if (!sk && typeof n.text === 'string') parts.push(n.text); for (const v of Object.values(n)) if (v && typeof v === 'object') walk(v, sk); };
    walk(j.steps, false);
    const text = parts.join('');
    if (text.trim()) return { text, via: 'steps' };
  }
  return { text: '', via: 'none' };
}

export class GeminiProvider implements LlmProvider {
  readonly #key: string;
  readonly #models: string[];
  readonly #fetch: typeof fetch;
  #answered: string | null = null;
  /** model:status pairs of the last call's failed attempts (no key, no body text) */
  lastAttempts: string[] = [];
  readonly #mode: 'generateContent' | 'interactions' | 'auto';
  constructor(key: string, model?: string, fetchImpl?: typeof fetch, apiMode: 'generateContent' | 'interactions' | 'auto' = 'generateContent', opts: { strict?: boolean } = {}) {
    this.#key = key; this.#mode = apiMode;
    this.#models = opts.strict && model ? [model] : [...new Set([...(model ? [model] : []), ...GEMINI_FALLBACK_MODELS])];
    this.#fetch = fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  }
  get name(): string { return `gemini:${this.#answered ?? this.#models[0]}`; }
  get models(): readonly string[] { return this.#models; }

  /** Which Gemini endpoint answered last: 'generateContent' (v1beta/models/{m}:generateContent) or 'interactions' (v1beta/interactions, the API Google's docs lead with as of 2026-10-26). */
  api: 'generateContent' | 'interactions' | null = null;

  /** Interactions API (POST /v1beta/interactions, body {model, input, response_format}). The request is the documented one; the raw JSON reply was only shown through the SDK
   *  (`interaction.output_text`, `interaction.steps[]`), so the text is read from `output_text` when present, else from text fields of non-thought, non-user steps. UNVERIFIED against a live reply. */
  async #interaction(model: string, prompt: string, opts: { maxTokens?: number } = {}): Promise<string> {
    const res = await this.#fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': this.#key },
      // store:false: "Set store=false in your request to opt out of server-side storage" (Gemini docs, text-generation page, 2026-10-26). generation_config carries max_output_tokens and thinking_level
      // (documented there and on the thinking page); 3.x models ignore custom temperature/top_p/top_k, so none is sent. thinking_level "low" is listed as supported by gemini-3.8-flash and gemini-3.5-flash-lite.
      body: JSON.stringify({ model, input: prompt, store: false, response_format: { type: 'text', mime_type: 'application/json' }, generation_config: { max_output_tokens: opts.maxTokens ?? 2048, ...(/gemini-3/.test(model) ? { thinking_level: 'low' } : {}) } }),
      redirect: 'manual', signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 429) throw new LlmError('rate_limited', 'Gemini rate limit reached (HTTP 429)', 429);
    if (!res.ok) throw new LlmError('http', `Gemini returned HTTP ${res.status}`, res.status);
    let j: any;
    try { j = await res.json(); } catch { throw new LlmError('http', 'Gemini returned a body that is not JSON', 200); }
    const text = interactionText(j).text;
    if (!text.trim()) throw new LlmError('empty', 'Gemini returned no text');
    return text;
  }

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
      redirect: 'manual', signal: AbortSignal.timeout(20_000),
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
        let text: string;
        if (this.#mode === 'interactions') { text = await this.#interaction(model, prompt, opts); this.api = 'interactions'; }
        else try { text = await this.#one(model, prompt, opts); this.api = 'generateContent'; }
        catch (e1) {
          if (this.#mode !== 'auto') throw e1;
          // generateContent is not shown in the Gemini docs fetched 2026-10-26 (they show /v1beta/interactions): when it is refused or missing for this model, the same model is tried on the Interactions API before moving on.
          if (!(e1 instanceof LlmError) || e1.kind === 'blocked' || e1.kind === 'rate_limited') throw e1;
          this.lastAttempts.push(`${model}:generateContent:${e1.status ?? e1.kind}`);
          text = await this.#interaction(model, prompt, opts); this.api = 'interactions';
        }
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
  /** generateContent (default), interactions, or auto (generateContent, then interactions for the same model). Set by the owner after scripts/gemini-smoke.ts says which one answers. */
  GEMINI_API?: string;
  WORKERS_AI_MODEL?: string;
  AI?: AiBinding;
}

export function providerFromEnv(env: LlmEnv): LlmProvider | null {
  const choice = (env.LLM_PROVIDER ?? 'gemini').toLowerCase();
  if (choice === 'none') return null;
  if (choice === 'workers-ai') return env.AI ? new WorkersAiProvider(env.AI, env.WORKERS_AI_MODEL) : null;
  if (choice === 'gemini') return env.GEMINI_API_KEY ? new GeminiProvider(env.GEMINI_API_KEY, env.GEMINI_MODEL, undefined, env.GEMINI_API === 'interactions' || env.GEMINI_API === 'auto' ? env.GEMINI_API : 'generateContent', { strict: !!env.GEMINI_MODEL }) : env.AI ? new WorkersAiProvider(env.AI, env.WORKERS_AI_MODEL) : null;
  return null;
}
