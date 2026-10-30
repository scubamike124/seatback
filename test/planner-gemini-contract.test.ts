// CONTRACT TEST, NOT EVIDENCE OF MODEL BEHAVIOUR. A local stub server answers in the Gemini generateContent response format
// (candidates[].content.parts[].text, finishReason, usageMetadata, and the {error:{code,message,status}} error body) so the adapter's
// parsing and the planner loop's handling are exercised offline. The "model" here is a few lines of scripted code. It proves the
// plumbing (request shape, parsing, error mapping, fallback, budget, trace, grounding checks); it says NOTHING about what a real
// Gemini model would do. CAVEAT: the response shape is the one the adapter was written against; the Gemini docs pages fetched on
// 2026-10-26 show the newer Interactions API (POST /v1beta/interactions), and did not themselves show generateContent. The owner's
// real smoke run (REAL-PLANNER-TEST-PLAN.md) is what confirms the live endpoint.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { GeminiProvider, LlmError } from '../src/llm/provider.ts';
import { BudgetedLlm } from '../src/llm/budget.ts';
import { runPipeline } from '../src/agent/pipeline.ts';
import { createQlooClient } from '../src/qloo/client.ts';
import { EXAMPLE_ROUTES, SYNTHETIC_CATALOGUE } from '../src/examples.ts';
/** runPipeline returns null when the visitor disconnected: a test must fail on that, not hide it behind a non-null assertion. */
const must = <T>(x: T | null): T => { assert.ok(x, 'runPipeline returned null'); return x as T; };
import { evaluatePlannerRun } from '../scripts/planner-real-test.ts';

const KEY = ['FAKE', 'KEY', 'contract', '0001'].join('-');
type Seen = { url: string; key: string | undefined; body: any };
let server: http.Server, port = 0; const seen: Seen[] = [];
let handler: (n: number, body: any) => { status: number; json: unknown } = () => ({ status: 200, json: {} });
const ok = (text: string) => ({ status: 200, json: { candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP', index: 0 }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 }, modelVersion: 'stub' } });
before(async () => {
  server = http.createServer((q, r) => {
    let b = ''; q.on('data', (c) => (b += c)); q.on('end', () => {
      const body = JSON.parse(b || '{}'); seen.push({ url: q.url ?? '', key: q.headers['x-goog-api-key'] as string | undefined, body });
      let out: { status: number; json: unknown };
      try { out = handler(seen.length, body); } catch { out = { status: 500, json: { error: { code: 500, message: 'stub failure', status: 'INTERNAL' } } }; }
      r.writeHead(out.status, { 'content-type': 'application/json' }); r.end(JSON.stringify(out.json));
    });
  });
  await new Promise<void>((o) => server.listen(0, '127.0.0.1', o)); port = (server.address() as AddressInfo).port;
});
after(() => new Promise<void>((o) => { server.closeAllConnections?.(); server.close(() => o()); }));
const toStub: typeof fetch = ((u: string, init: RequestInit) => fetch(String(u).replace('https://generativelanguage.googleapis.com', `http://127.0.0.1:${port}`), init)) as typeof fetch;
const provider = (model?: string) => new GeminiProvider(KEY, model, toStub);

test('CONTRACT: request shape: v1beta generateContent path, key only in the x-goog-api-key header, contents/parts, JSON mime type, thinking off for 2.5-flash', async () => {
  seen.length = 0; handler = () => ok('{"ok":true}');
  assert.equal(await provider('gemini-2.5-flash').completeJson('hello'), '{"ok":true}');
  const s = seen[0]!;
  assert.equal(s.url, '/v1beta/models/gemini-2.5-flash:generateContent');
  assert.equal(s.key, KEY); assert.ok(!s.url.includes('FAKE') && !JSON.stringify(s.body).includes('FAKE'));
  assert.deepEqual(s.body.contents, [{ role: 'user', parts: [{ text: 'hello' }] }]);
  assert.equal(s.body.generationConfig.responseMimeType, 'application/json');
  assert.deepEqual(s.body.generationConfig.thinkingConfig, { thinkingBudget: 0 });
});
test('CONTRACT: response parsing: multi-part text is joined; MAX_TOKENS, SAFETY, empty text and promptFeedback block map to fixed LlmError kinds', async () => {
  handler = () => ({ status: 200, json: { candidates: [{ content: { parts: [{ text: '{"a":' }, { text: '1}' }] }, finishReason: 'STOP' }] } });
  assert.equal(await provider().completeJson('x'), '{"a":1}');
  handler = () => ({ status: 200, json: { candidates: [{ content: { parts: [{ text: '{"a"' }] }, finishReason: 'MAX_TOKENS' }] } });
  await assert.rejects(() => provider('only-model').completeJson('x'), (e: LlmError) => e.kind === 'truncated' || /no model answered/.test(e.message));
  handler = () => ({ status: 200, json: { promptFeedback: { blockReason: 'SAFETY' } } });
  await assert.rejects(() => provider().completeJson('x'), (e: LlmError) => e.kind === 'blocked');
  handler = () => ({ status: 200, json: { candidates: [{ content: { parts: [] }, finishReason: 'STOP' }] } });
  await assert.rejects(() => provider().completeJson('x'), (e: LlmError) => e.kind === 'empty' || /no model answered/.test(e.message));
});
test('CONTRACT: Gemini error bodies ({error:{code,message,status}}) never reach the public reason; 404/429 fall through to the next model', async () => {
  seen.length = 0;
  handler = (n) => n === 1 ? { status: 404, json: { error: { code: 404, message: `models/x is not found ${KEY}`, status: 'NOT_FOUND' } } } : n === 2 ? { status: 429, json: { error: { code: 429, message: 'quota', status: 'RESOURCE_EXHAUSTED' } } } : ok('{"b":2}');
  const p = provider('x');
  assert.equal(await p.completeJson('q'), '{"b":2}');
  assert.deepEqual(p.lastAttempts, ['x:404', `${p.models[1]}:429`]);
  handler = () => ({ status: 403, json: { error: { code: 403, message: `forbidden ${KEY}`, status: 'PERMISSION_DENIED' } } });
  await assert.rejects(() => provider().completeJson('q'), (e: LlmError) => !e.message.includes('FAKE') && !e.publicReason.includes('forbidden'));
});
test('CONTRACT: BudgetedLlm stops the stub being called past the per-run cap (no request leaves)', async () => {
  seen.length = 0; handler = () => ok('{}');
  const b = new BudgetedLlm(provider(), 2);
  await b.completeJson('a'); await b.completeJson('b');
  await assert.rejects(() => b.completeJson('c'), (e: LlmError) => e.kind === 'budget');
  assert.equal(seen.length, 2);
});

/** A scripted stand-in for a model: reads the planner prompt it was sent and answers with one JSON action. It is code, not intelligence. */
function scriptedModel(mode: 'good' | 'invented-anchor' | 'garbage'): typeof handler {
  return (_n, body) => {
    const prompt: string = body.contents[0].parts[0].text;
    const m = /STEP (\d+) of/.exec(prompt);
    if (!m) return ok('{}'); // a prompt that is not a planner step (the programmer's note): a stub that has nothing to say
    const step = Number(m[1]);
    if (mode === 'garbage') return ok('Sure! I will help you plan.');
    const data = JSON.parse(prompt.slice(prompt.indexOf('<<<DATA') + 7, prompt.indexOf('DATA>>>')));
    const firstId = (end: string) => {
      const h = (data.history as any[]).find((x) => x.action === 'read_location' && String(x.args).includes(end) && String(x.args).includes('artist'));
      return h ? /([A-Za-z0-9:_-]+) \|/.exec(h.result)?.[1] : undefined;
    };
    if (step === 1) return ok(JSON.stringify({ action: 'read_location', args: { end: 'origin', domain: 'artist' }, reason: 'See what the origin favours in music.' }));
    if (step === 2) return ok(JSON.stringify({ action: 'read_location', args: { end: 'destination', domain: 'artist' }, reason: 'See what the destination favours in music.' }));
    const o = mode === 'invented-anchor' ? 'SYN-NOT-A-REAL-ID' : firstId('origin'), d = firstId('destination');
    return ok(JSON.stringify({ action: 'finish', args: { anchors: { origin: { artist: [o] }, destination: { artist: [d] } } }, reason: 'Anchors that distinguish the two ends.' }));
  };
}
const run = (steps = 6) => { const llm = new BudgetedLlm(provider(), steps + 2); const h = createQlooClient({}, { budget: 200, forceMode: 'MOCK' }); return { llm, p: runPipeline({ ...EXAMPLE_ROUTES[0]!.request, catalogue: SYNTHETIC_CATALOGUE, autoConfirm: true, swap: false, compare: false }, { qloo: h.client, llm, planner: { enabled: true, maxSteps: steps }, emit: () => {} }) }; };

test('CONTRACT: planner loop over the stub: valid calls execute against synthetic fixtures, finish is accepted, the evaluator passes it (plumbing only)', async () => {
  seen.length = 0; handler = scriptedModel('good');
  const { llm, p } = run(); const r = must(await p);
  assert.equal(r.workflow!.kind, 'llm-planner');
  assert.ok(r.plannerDecisions!.some((d) => d.action === 'read_location' && d.status === 'ok'));
  const v = evaluatePlannerRun(r, SYNTHETIC_CATALOGUE, llm.used, 8);
  assert.ok(v.pass, JSON.stringify(v.checks));
  assert.ok(seen.every((s) => s.key === KEY));
});
test('CONTRACT: an anchor id that no earlier result returned is rejected by the guard (the evaluator would also catch it)', async () => {
  handler = scriptedModel('invented-anchor');
  const { llm, p } = run(); const r = must(await p);
  assert.ok(r.plannerDecisions!.some((d) => d.status === 'rejected' && /no earlier read_location returned/.test(d.result)));
  assert.ok(!evaluatePlannerRun(r, SYNTHETIC_CATALOGUE, llm.used, 8).pass);
});
test('CONTRACT: text that is not JSON ends the planner after the invalid limit and the pipeline falls back, labelled; the evaluator fails it', async () => {
  handler = scriptedModel('garbage');
  const { llm, p } = run(); const r = must(await p);
  assert.equal(r.workflow!.kind, 'planner-fallback');
  assert.ok(!evaluatePlannerRun(r, SYNTHETIC_CATALOGUE, llm.used, 8).checks.planner_finished!.ok);
});
test('CONTRACT: the evaluator rejects a slate with an invented title and a run over the model-call cap', async () => {
  handler = scriptedModel('good');
  const { llm, p } = run(); const r = must(await p);
  const bad = structuredClone(r); (bad.domains.find((x) => x.picks.length)!.picks[0] as { title: string }).title = 'Totally Invented Film';
  assert.ok(!evaluatePlannerRun(bad, SYNTHETIC_CATALOGUE, llm.used, 8).checks.no_invented_titles!.ok);
  assert.ok(!evaluatePlannerRun(r, SYNTHETIC_CATALOGUE, 99, 8).checks.within_llm_cap!.ok);
});

test('CONTRACT (shape taken from the SDK examples in the docs, not from a raw reply): interactions mode posts to /v1beta/interactions with {model,input,response_format} and reads output_text, or text from non-thought steps; auto mode falls back to it when generateContent is refused', async () => {
  seen.length = 0;
  handler = () => ({ status: 200, json: { output_text: '{"x":1}', steps: [] } });
  const a = new GeminiProvider(KEY, 'gemini-3.5-flash-lite', toStub, 'interactions');
  assert.equal(await a.completeJson('hi'), '{"x":1}');
  assert.equal(seen[0]!.url, '/v1beta/interactions'); assert.equal(seen[0]!.key, KEY);
  assert.deepEqual(seen[0]!.body, { model: 'gemini-3.5-flash-lite', input: 'hi', store: false, response_format: { type: 'text', mime_type: 'application/json' }, generation_config: { max_output_tokens: 2048, thinking_level: 'low' } });
  assert.equal(a.api, 'interactions');
  handler = () => ({ status: 200, json: { steps: [{ type: 'thought', text: 'secret thinking' }, { type: 'model_output', content: [{ type: 'text', text: '{"y":' }, { type: 'text', text: '2}' }] }] } });
  assert.equal(await new GeminiProvider(KEY, 'm', toStub, 'interactions').completeJson('hi'), '{"y":2}');
  seen.length = 0;
  handler = (n) => n === 1 ? { status: 404, json: { error: { code: 404, status: 'NOT_FOUND', message: 'gone' } } } : { status: 200, json: { output_text: '{"z":3}' } };
  const c = new GeminiProvider(KEY, 'gemini-3.5-flash-lite', toStub, 'auto');
  assert.equal(await c.completeJson('hi'), '{"z":3}');
  assert.deepEqual(seen.map((x) => x.url), ['/v1beta/models/gemini-3.5-flash-lite:generateContent', '/v1beta/interactions']); assert.equal(c.api, 'interactions');
  // default mode never touches the interactions endpoint
  seen.length = 0; handler = () => ({ status: 404, json: {} });
  await assert.rejects(() => new GeminiProvider(KEY, undefined, toStub).completeJson('hi'));
  assert.ok(seen.every((x) => x.url.includes(':generateContent')));
});
