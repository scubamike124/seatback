// Owner-side one-command Gemini check. Optional read-only model list, then ONE tiny generation call per candidate model until one answers:
// generateContent first, and only if that fails for a model, the Interactions API (the one Google's docs show as of 2026-10-26). The reply is PARSED (the same parser the planner uses) and only a
// REDACTED summary is printed: ok/failed, model, endpoint, which field carried the text, the number of characters and whether it is JSON. Never the key, headers, the prompt or any model text.
//   node scripts/gemini-smoke.ts --yes          (reads GEMINI_API_KEY, optional GEMINI_MODEL and GEMINI_API from the environment or .dev.vars)
// Refuses to run without --yes: the call is billed to the project that owns the key (free tier or paid).
import { existsSync, readFileSync } from 'node:fs';
import { GEMINI_FALLBACK_MODELS, interactionText } from '../src/llm/provider.ts';

export function readVar(name: string, env: Record<string, string | undefined>, vars: string): string | undefined {
  if (env[name]) return env[name];
  const m = new RegExp(`^\\s*${name}\\s*=[ \\t]*(.*?)\\s*$`, 'm').exec(vars);
  return m?.[1] ? m[1].replace(/^["']|["']$/g, '') : undefined;
}

export interface SmokeResult { ok: boolean; model?: string; api?: 'generateContent' | 'interactions'; via?: string; chars?: number; json?: boolean; promptTokens?: number; outputTokens?: number; tried: string[]; listed?: { status: number | 'error'; count: number; preferredPresent: string[] } }

const PROMPT = 'Reply with the JSON {"ok":true}';
const isJson = (t: string): boolean => { try { JSON.parse(t.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '')); return true; } catch { return false; } };

/** Read-only list of the models this key can see (GET /v1beta/models). The endpoint is NOT shown on the Gemini docs pages read on 2026-10-26 (its API-reference URL returned 404 there): a failure here only means "unlisted". */
export async function listModels(key: string, fetchImpl: typeof fetch = fetch): Promise<{ status: number | 'error'; names: string[] }> {
  try {
    const res = await fetchImpl('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { method: 'GET', headers: { 'x-goog-api-key': key }, redirect: 'manual', signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return { status: res.status, names: [] };
    const j: any = await res.json().catch(() => null);
    return { status: res.status, names: Array.isArray(j?.models) ? j.models.map((m: any) => String(m?.name ?? '').replace(/^models\//, '')).filter(Boolean) : [] };
  } catch { return { status: 'error', names: [] }; }
}

export async function geminiSmoke(key: string, models: string[], fetchImpl: typeof fetch = fetch, opts: { list?: boolean } = {}): Promise<SmokeResult> {
  const tried: string[] = [];
  let listed: SmokeResult['listed'];
  let candidates = models;
  if (opts.list) {
    const l = await listModels(key, fetchImpl);
    const present = models.filter((m) => l.names.includes(m));
    listed = { status: l.status, count: l.names.length, preferredPresent: present };
    // Prefer what the key can see, in the preferred order; an empty or failed list leaves the order alone (the call itself then decides).
    if (present.length) candidates = [...present, ...models.filter((m) => !present.includes(m))];
  }
  for (const model of candidates) {
    const viaInteractions = async (): Promise<SmokeResult | null> => {
      try {
        const r = await fetchImpl('https://generativelanguage.googleapis.com/v1beta/interactions', { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify({ model, input: PROMPT, store: false, response_format: { type: 'text', mime_type: 'application/json' }, generation_config: { max_output_tokens: 64, ...(/gemini-3/.test(model) ? { thinking_level: 'low' } : {}) } }), redirect: 'manual', signal: AbortSignal.timeout(30_000) });
        if (!r.ok) { tried.push(`${model}:interactions:${r.status}`); return null; }
        const j: any = await r.json().catch(() => null);
        const t = interactionText(j);
        if (!t.text.trim()) { tried.push(`${model}:interactions:empty`); return null; }
        return { ok: true, model, api: 'interactions', via: t.via, chars: t.text.length, json: isJson(t.text), tried, ...(listed ? { listed } : {}) };
      } catch { tried.push(`${model}:interactions:error`); return null; }
    };
    try {
      const res = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: PROMPT }] }], generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 64, temperature: 0, ...(/2\.5-flash/.test(model) ? { thinkingConfig: { thinkingBudget: 0 } } : {}) } }),
        redirect: 'manual', signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) { tried.push(`${model}:${res.status}`); const i = await viaInteractions(); if (i) return i; continue; }
      const j = (await res.json().catch(() => null)) as { candidates?: { content?: { parts?: { text?: string }[] } }[]; usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } } | null;
      const text = j?.candidates?.[0]?.content?.parts?.map((p) => p?.text ?? '').join('') ?? '';
      if (!text.trim()) { tried.push(`${model}:empty`); const i = await viaInteractions(); if (i) return i; continue; }
      return { ok: true, model, api: 'generateContent', via: 'candidates', chars: text.length, json: isJson(text), promptTokens: j?.usageMetadata?.promptTokenCount, outputTokens: j?.usageMetadata?.candidatesTokenCount, tried, ...(listed ? { listed } : {}) };
    } catch { tried.push(`${model}:error`); const i = await viaInteractions(); if (i) return i; }
  }
  return { ok: false, tried, ...(listed ? { listed } : {}) };
}

/** The one line the script prints. Fixed words and numbers only. */
export function smokeLine(r: SmokeResult): string {
  const listed = r.listed ? `; model list ${r.listed.status === 200 ? `${r.listed.count} models, preferred present: ${r.listed.preferredPresent.join(', ') || 'none'}` : `unavailable (${r.listed.status})`}` : '';
  return r.ok
    ? `ok: model ${r.model} via ${r.api}${r.api === 'interactions' ? ' (set GEMINI_API=interactions in .dev.vars)' : ''}; text in ${r.via}, ${r.chars} chars, JSON ${r.json ? 'yes' : 'no'}${r.promptTokens !== undefined ? `, prompt tokens ${r.promptTokens ?? '?'}, output tokens ${r.outputTokens ?? '?'}` : ''}${r.tried.length ? `; skipped ${r.tried.join(', ')}` : ''}${listed}`
    : `failed: no model answered (${r.tried.join(', ') || 'none tried'})${listed}`;
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://').href) {
  if (!process.argv.includes('--yes')) { console.error('Refusing to run without --yes (one small billable call to Gemini). Nothing was called.'); process.exit(2); }
  const varsPath = new URL('../.dev.vars', import.meta.url);
  const vars = existsSync(varsPath) ? readFileSync(varsPath, 'utf8') : '';
  const key = readVar('GEMINI_API_KEY', process.env, vars);
  if (!key) { console.error('No GEMINI_API_KEY in the environment or .dev.vars. Nothing was called.'); process.exit(2); }
  const configured = readVar('GEMINI_MODEL', process.env, vars);
  // GEMINI_MODEL is authoritative: only that model is tried. Without it the preferred list is tried in order, after a read-only look at what the key can see.
  const r = await geminiSmoke(key, configured ? [configured] : [...GEMINI_FALLBACK_MODELS], fetch, { list: true });
  console.log(smokeLine(r));
  process.exit(r.ok ? 0 : 1);
}
