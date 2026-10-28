// Owner-side one-command Gemini check. Makes ONE tiny generateContent call on the configured model and prints only
// ok/failed, the model that answered and token counts. It never prints the key or any model text.
//   node scripts/gemini-smoke.ts --yes          (reads GEMINI_API_KEY and optional GEMINI_MODEL from the environment or .dev.vars)
// Refuses to run without --yes: the call is billed to the project that owns the key (free tier or paid).
import { existsSync, readFileSync } from 'node:fs';
import { GEMINI_FALLBACK_MODELS } from '../src/llm/provider.ts';

export function readVar(name: string, env: Record<string, string | undefined>, vars: string): string | undefined {
  if (env[name]) return env[name];
  const m = new RegExp(`^\\s*${name}\\s*=[ \\t]*(.*?)\\s*$`, 'm').exec(vars);
  return m?.[1] ? m[1].replace(/^["']|["']$/g, '') : undefined;
}

export async function geminiSmoke(key: string, models: string[], fetchImpl: typeof fetch = fetch): Promise<{ ok: boolean; model?: string; promptTokens?: number; outputTokens?: number; tried: string[] }> {
  const tried: string[] = [];
  for (const model of models) {
    try {
      const res = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Reply with the JSON {"ok":true}' }] }], generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 32, temperature: 0, ...(/2\.5-flash/.test(model) ? { thinkingConfig: { thinkingBudget: 0 } } : {}) } }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) { tried.push(`${model}:${res.status}`); continue; }
      const j = (await res.json()) as { usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } };
      return { ok: true, model, promptTokens: j.usageMetadata?.promptTokenCount, outputTokens: j.usageMetadata?.candidatesTokenCount, tried };
    } catch { tried.push(`${model}:error`); }
  }
  return { ok: false, tried };
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://').href) {
  if (!process.argv.includes('--yes')) { console.error('Refusing to run without --yes (one small billable call to Gemini). Nothing was called.'); process.exit(2); }
  const varsPath = new URL('../.dev.vars', import.meta.url);
  const vars = existsSync(varsPath) ? readFileSync(varsPath, 'utf8') : '';
  const key = readVar('GEMINI_API_KEY', process.env, vars);
  if (!key) { console.error('No GEMINI_API_KEY in the environment or .dev.vars. Nothing was called.'); process.exit(2); }
  const configured = readVar('GEMINI_MODEL', process.env, vars);
  const r = await geminiSmoke(key, [...new Set([...(configured ? [configured] : []), ...GEMINI_FALLBACK_MODELS])]);
  console.log(r.ok ? `ok: model ${r.model}, prompt tokens ${r.promptTokens ?? '?'}, output tokens ${r.outputTokens ?? '?'}${r.tried.length ? `; skipped ${r.tried.join(', ')}` : ''}` : `failed: no model answered (${r.tried.join(', ')})`);
  process.exit(r.ok ? 0 : 1);
}
