// Gemini model fallback list, soft failure to the scripted workflow, and the owner smoke script (never run against the network here).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { GeminiProvider, GEMINI_FALLBACK_MODELS, LlmError } from '../src/llm/provider.ts';
import { BudgetedLlm } from '../src/llm/budget.ts';
import { runPipeline } from '../src/agent/pipeline.ts';
import { createQlooClient } from '../src/qloo/client.ts';
import { EXAMPLE_ROUTES, SYNTHETIC_CATALOGUE } from '../src/examples.ts';
import { geminiSmoke, readVar } from '../scripts/gemini-smoke.ts';

const KEY = ['FAKE', 'KEY', 'gem', '00000001'].join('-');
const ok = (text = '{"ok":true}') => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 } }));
/** A fake fetch that answers per model name found in the URL. */
const byModel = (map: Record<string, () => Response>, seen: string[] = []): typeof fetch => (async (u: string) => {
  const m = /models\/([^:]+):/.exec(String(u))![1]!; seen.push(m);
  const h = map[m]; if (!h) throw new Error('unexpected model ' + m);
  return h();
}) as typeof fetch;

test('the model list is GEMINI_MODEL, then gemini-2.5-flash, then gemini-2.0-flash, without duplicates', () => {
  assert.deepEqual([...new GeminiProvider(KEY, 'gemini-1.5-pro').models], ['gemini-1.5-pro', ...GEMINI_FALLBACK_MODELS]);
  assert.deepEqual([...new GeminiProvider(KEY, 'gemini-2.5-flash').models], [...GEMINI_FALLBACK_MODELS]);
  assert.deepEqual([...new GeminiProvider(KEY).models], [...GEMINI_FALLBACK_MODELS]);
});
test('404 and 403 (model not available to this key) move on to the next model; the answering model is named', async () => {
  const seen: string[] = [];
  const p = new GeminiProvider(KEY, 'gemini-3-preview', byModel({ 'gemini-3-preview': () => new Response('no', { status: 404 }), 'gemini-2.5-flash': () => new Response('forbidden', { status: 403 }), 'gemini-2.0-flash': () => ok() }, seen));
  assert.equal(p.name, 'gemini:gemini-3-preview', 'before any answer the name shows the first choice');
  assert.equal(await p.completeJson('x'), '{"ok":true}');
  assert.deepEqual(seen, ['gemini-3-preview', 'gemini-2.5-flash', 'gemini-2.0-flash']);
  assert.equal(p.name, 'gemini:gemini-2.0-flash'); assert.deepEqual(p.lastAttempts, ['gemini-3-preview:404', 'gemini-2.5-flash:403']);
});
test('429, a 5xx and a body that is not JSON each fall through; the first good model wins and later ones are not called', async () => {
  const seen: string[] = [];
  const p = new GeminiProvider(KEY, 'gemini-a', byModel({ 'gemini-a': () => new Response('slow', { status: 429 }), 'gemini-2.5-flash': () => new Response('<html>oops</html>', { status: 200 }), 'gemini-2.0-flash': () => ok() }, seen));
  await p.completeJson('x'); assert.deepEqual(seen, ['gemini-a', 'gemini-2.5-flash', 'gemini-2.0-flash']);
  const seen2: string[] = [];
  const q = new GeminiProvider(KEY, undefined, byModel({ 'gemini-2.5-flash': () => new Response('x', { status: 503 }), 'gemini-2.0-flash': () => ok('{"b":1}') }, seen2));
  assert.equal(await q.completeJson('x'), '{"b":1}'); assert.deepEqual(seen2, ['gemini-2.5-flash', 'gemini-2.0-flash']);
  const seen3: string[] = [];
  const r = new GeminiProvider(KEY, undefined, byModel({ 'gemini-2.5-flash': () => ok(), 'gemini-2.0-flash': () => ok() }, seen3));
  await r.completeJson('x'); assert.deepEqual(seen3, ['gemini-2.5-flash']);
});
test('a blocked prompt is not retried on other models; all models failing throws one LlmError with a fixed reason and no body text', async () => {
  const seen: string[] = [];
  const b = new GeminiProvider(KEY, undefined, byModel({ 'gemini-2.5-flash': () => new Response(JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } })), 'gemini-2.0-flash': () => ok() }, seen));
  await assert.rejects(() => b.completeJson('x'), (e: LlmError) => e.kind === 'blocked'); assert.deepEqual(seen, ['gemini-2.5-flash']);
  const all = new GeminiProvider(KEY, undefined, byModel({ 'gemini-2.5-flash': () => new Response('secret-body-text ' + KEY, { status: 404 }), 'gemini-2.0-flash': () => new Response('429 secret', { status: 429 }) }));
  await assert.rejects(() => all.completeJson('x'), (e: LlmError) => e.kind === 'rate_limited' && /no model answered \(gemini-2\.5-flash:404, gemini-2\.0-flash:429\)/.test(e.publicReason) && !/secret|FAKE/.test(e.message));
});
test('network errors on every model also end as one fixed LlmError', async () => {
  const p = new GeminiProvider(KEY, undefined, (async () => { throw new Error('ECONNRESET with ' + KEY); }) as typeof fetch);
  await assert.rejects(() => p.completeJson('x'), (e: LlmError) => /no model answered/.test(e.publicReason) && !/ECONN|FAKE/.test(e.message));
});
test('if every model fails the run still completes: scripted workflow with a visible label and a warn step; if one answers, the trace names the model', async () => {
  const req = { ...EXAMPLE_ROUTES[0]!.request, catalogue: SYNTHETIC_CATALOGUE, autoConfirm: true, swap: false, compare: false };
  const evs: any[] = [];
  const dead = new BudgetedLlm(new GeminiProvider(KEY, undefined, byModel({ 'gemini-2.5-flash': () => new Response('n', { status: 404 }), 'gemini-2.0-flash': () => new Response('n', { status: 403 }) })), 12);
  const r = (await runPipeline(req, { qloo: createQlooClient({}, { budget: 300 }).client, llm: dead, planner: { enabled: true }, emit: (e) => evs.push(e) }))!;
  assert.equal(r.workflow!.kind, 'planner-fallback'); assert.match(r.workflow!.label, /scripted workflow \(planner stopped: llm_error: Gemini: no model answered \(gemini-2\.5-flash:404, gemini-2\.0-flash:403\)\)/);
  const step = evs.find((e) => e.type === 'step' && e.id === 'llm-model'); assert.equal(step.status, 'warn'); assert.match(step.detail, /scripted workflow runs instead/);
  assert.ok(r.domains.some((d) => d.picks.length > 0), 'the run still produced a slate');
});
test('smoke script: refuses without --yes (exit 2, nothing called), reads the key without printing it, reports only ok/failed + model + tokens', async () => {
  const r = spawnSync(process.execPath, ['scripts/gemini-smoke.ts'], { encoding: 'utf8', env: { PATH: process.env.PATH, GEMINI_API_KEY: KEY } });
  assert.equal(r.status, 2); assert.match(r.stderr, /Refusing to run without --yes/); assert.ok(!(r.stdout + r.stderr).includes(KEY));
  assert.equal(readVar('GEMINI_API_KEY', { GEMINI_API_KEY: 'from-env' }, 'GEMINI_API_KEY=from-file'), 'from-env');
  assert.equal(readVar('GEMINI_API_KEY', {}, '# c\nGEMINI_API_KEY="from-file"\n'), 'from-file');
  assert.equal(readVar('GEMINI_API_KEY', {}, 'GEMINI_API_KEY=\nOTHER=x'), undefined);
  const seen: string[] = [];
  const good = await geminiSmoke(KEY, ['m1', 'gemini-2.0-flash'], (async (u: string) => { seen.push(String(u)); return /m1/.test(String(u)) ? new Response('x', { status: 404 }) : ok(); }) as typeof fetch);
  assert.deepEqual({ ok: good.ok, model: good.model, p: good.promptTokens, o: good.outputTokens, tried: good.tried }, { ok: true, model: 'gemini-2.0-flash', p: 3, o: 2, tried: ['m1:404'] });
  assert.equal(seen.length, 2); assert.ok(seen.every((u) => !u.includes(KEY)), 'the key travels in a header, not the URL');
  assert.equal((await geminiSmoke(KEY, ['a'], (async () => new Response('no', { status: 403 })) as typeof fetch)).ok, false);
});
