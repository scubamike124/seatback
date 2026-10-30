// CONTRACT TESTS for both Gemini transports (generateContent and the Interactions API), run against a local stub. They are NOT evidence of model behaviour: the "model" is scripted code.
// They cover: store:false and generation_config on every Interactions request, error statuses, empty and malformed replies, safety blocks, timeouts, parse-to-plan with documented-shape
// replies through the real parser and the real planner validator, rejection of invented tools/titles with the labelled scripted fallback, and that no key leaks into any output.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { GeminiProvider, LlmError, interactionText, providerFromEnv } from '../src/llm/provider.ts';
import { BudgetedLlm } from '../src/llm/budget.ts';
import { runPipeline } from '../src/agent/pipeline.ts';
import { createQlooClient } from '../src/qloo/client.ts';
import { EXAMPLE_ROUTES, SYNTHETIC_CATALOGUE } from '../src/examples.ts';
import { evaluatePlannerRun } from '../scripts/planner-real-test.ts';
import { geminiSmoke, smokeLine, listModels } from '../scripts/gemini-smoke.ts';
import { startStub, genOk, interSteps, interOutputText, scriptedModel, type Stub } from './helpers/gemini-stub.ts';

const KEY = ['FAKE', 'KEY', 'leak', 'check', '9f3a1c'].join('-');
const must = <T>(x: T | null): T => { assert.ok(x, 'runPipeline returned null'); return x as T; };
let stub: Stub;
before(async () => { stub = await startStub(); });
after(() => stub.close());
const APIS = ['generateContent', 'interactions'] as const;
const prov = (api: (typeof APIS)[number], model = 'gemini-3.5-flash-lite') => new GeminiProvider(KEY, model, stub.fetch, api, { strict: true });

test('CONTRACT interactions: every request carries store:false and generation_config (max_output_tokens; thinking_level low only for 3.x models; no temperature), key only in the header', async () => {
  stub.seen.length = 0; stub.handler = () => interOutputText('{"ok":true}');
  await prov('interactions').completeJson('p', { maxTokens: 777, temperature: 0.9 });
  await prov('interactions', 'gemini-2.5-flash').completeJson('p');
  await prov('interactions', 'gemini-3.8-flash').completeJson('p');
  assert.equal(stub.seen.length, 3);
  for (const s of stub.seen) {
    assert.equal(s.url, '/v1beta/interactions'); assert.equal(s.body.store, false, 'store:false on every request'); assert.equal(s.key, KEY);
    assert.deepEqual(s.body.response_format, { type: 'text', mime_type: 'application/json' }); assert.ok(!('temperature' in s.body) && !('temperature' in s.body.generation_config));
    assert.ok(!JSON.stringify(s.body).includes('FAKE'), 'the key is not in the body');
  }
  assert.deepEqual(stub.seen[0]!.body.generation_config, { max_output_tokens: 777, thinking_level: 'low' });
  assert.deepEqual(stub.seen[1]!.body.generation_config, { max_output_tokens: 2048 });
  assert.deepEqual(stub.seen[2]!.body.generation_config, { max_output_tokens: 2048, thinking_level: 'low' });
});
test('CONTRACT auto mode: when generateContent is refused the Interactions leg of the same call also carries store:false and generation_config', async () => {
  stub.seen.length = 0; stub.handler = (_n, _b, url) => (url.includes(':generateContent') ? { status: 404, json: { error: { code: 404, status: 'NOT_FOUND', message: 'gone' } } } : interOutputText('{"z":3}'));
  const p = new GeminiProvider(KEY, 'gemini-3.5-flash-lite', stub.fetch, 'auto', { strict: true });
  assert.equal(await p.completeJson('hi'), '{"z":3}'); assert.equal(p.api, 'interactions');
  const leg = stub.seen.find((s) => s.url === '/v1beta/interactions')!;
  assert.equal(leg.body.store, false); assert.ok(leg.body.generation_config.max_output_tokens > 0);
});

for (const api of APIS) {
  for (const status of [400, 401, 403, 404, 429, 500]) {
    test(`CONTRACT ${api}: HTTP ${status} becomes a fixed LlmError (kind, status), never the provider's body or the key`, async () => {
      stub.handler = () => ({ status, json: { error: { code: status, message: `provider words ${KEY}`, status: 'X' } } });
      await assert.rejects(() => prov(api).completeJson('p'), (e: LlmError) => e instanceof LlmError && e.status === status && e.kind === (status === 429 ? 'rate_limited' : 'http') && !e.message.includes('FAKE') && !e.message.includes('provider words') && !e.publicReason.includes('provider words'));
    });
  }
  test(`CONTRACT ${api}: an empty reply, whitespace-only text, a body that is not JSON and a reply with no text each fail with a fixed LlmError (never an empty string handed to the planner)`, async () => {
    const empties: Array<[string, () => { status: number; json?: unknown; text?: string }]> = api === 'generateContent'
      ? [['no candidates', () => ({ status: 200, json: {} })], ['empty parts', () => ({ status: 200, json: { candidates: [{ content: { parts: [] }, finishReason: 'STOP' }] } })], ['whitespace text', () => genOk('   \n ')], ['not JSON', () => ({ status: 200, text: '<html>oops</html>' })]]
      : [['empty object', () => ({ status: 200, json: {} })], ['empty output_text', () => interOutputText('   ')], ['no steps', () => ({ status: 200, json: { steps: [] } })], ['only a thought step', () => ({ status: 200, json: { steps: [{ type: 'thought', summary: [{ type: 'text', text: 'only thinking' }] }] } })], ['only the user step', () => ({ status: 200, json: { steps: [{ type: 'user_input', content: [{ type: 'text', text: 'echo' }] }] } })], ['not JSON', () => ({ status: 200, text: 'nope' })]];
    for (const [name, h] of empties) {
      stub.handler = h;
      await assert.rejects(() => prov(api).completeJson('p'), (e: LlmError) => e instanceof LlmError && /no model answered|returned no text|not JSON/.test(e.message), name);
    }
  });
  test(`CONTRACT ${api}: a network timeout or abort is reported as 'could not be reached' (fixed words), for the model and in the attempts list`, async () => {
    for (const name of ['TimeoutError', 'AbortError']) {
      const f = (async () => { throw new DOMException('slow', name); }) as unknown as typeof fetch;
      const p = new GeminiProvider(KEY, 'gemini-3.5-flash-lite', f, api, { strict: true });
      await assert.rejects(() => p.completeJson('p'), (e: LlmError) => e instanceof LlmError && /no model answered \(gemini-3\.5-flash-lite:network\)/.test(e.message) && !e.message.includes('slow'));
    }
  });
}
test('CONTRACT generateContent: a safety block (finishReason or promptFeedback) is a fixed "blocked" error and is not retried on another model', async () => {
  const seen: string[] = [];
  stub.handler = (_n, _b, url) => { seen.push(url); return { status: 200, json: { candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'SAFETY' }] } }; };
  await assert.rejects(() => new GeminiProvider(KEY, undefined, stub.fetch).completeJson('p'), (e: LlmError) => e.kind === 'blocked');
  assert.equal(seen.length, 1);
  stub.handler = () => ({ status: 200, json: { promptFeedback: { blockReason: 'SAFETY' } } });
  await assert.rejects(() => prov('generateContent').completeJson('p'), (e: LlmError) => e.kind === 'blocked');
});
test('interactionText: reads output_text, else only model-step text (thought and user steps never), and reports which field carried it', () => {
  assert.deepEqual(interactionText({ output_text: '{"a":1}' }), { text: '{"a":1}', via: 'output_text' });
  const j = (interSteps('{"b":2}').json) as any;
  assert.deepEqual(interactionText(j), { text: '{"b":2}', via: 'steps' });
  assert.deepEqual(interactionText({ steps: [{ type: 'thought', text: 'x' }] }), { text: '', via: 'none' });
  assert.deepEqual(interactionText(null), { text: '', via: 'none' });
});
test('GEMINI_MODEL is authoritative: providerFromEnv with the variable set tries only that model, with it unset tries the new-project list', () => {
  assert.deepEqual([...(providerFromEnv({ GEMINI_API_KEY: KEY, GEMINI_MODEL: 'gemini-3.6-flash' }) as GeminiProvider).models], ['gemini-3.6-flash']);
  assert.deepEqual([...(providerFromEnv({ GEMINI_API_KEY: KEY }) as GeminiProvider).models], ['gemini-3.5-flash-lite', 'gemini-3.8-flash', 'gemini-2.5-flash']);
});

// ---- parse-to-plan: documented-shape replies through the real parser, the real planner and the real validator ----
const run = (api: (typeof APIS)[number], steps = 6) => { const llm = new BudgetedLlm(prov(api), steps + 2); const h = createQlooClient({}, { budget: 200, forceMode: 'MOCK' }); return { llm, p: runPipeline({ ...EXAMPLE_ROUTES[0]!.request, catalogue: SYNTHETIC_CATALOGUE, autoConfirm: true, swap: false, compare: false }, { qloo: h.client, llm, planner: { enabled: true, maxSteps: steps }, emit: () => {} }) }; };
for (const api of APIS) {
  test(`PARSE-TO-PLAN ${api}: a documented-shape reply goes through the parser into the real planner and yields a usable plan: valid tool calls, grounded in fixture data (contract test, scripted model)`, async () => {
    stub.seen.length = 0; stub.handler = scriptedModel('good', api);
    const { llm, p } = run(api); const r = must(await p);
    assert.equal(r.workflow!.kind, 'llm-planner');
    const reads = r.plannerDecisions!.filter((d) => d.action === 'read_location' && d.status === 'ok');
    assert.ok(reads.length >= 2 && r.plannerDecisions!.some((d) => d.action === 'finish' && d.status === 'final'));
    const v = evaluatePlannerRun(r, SYNTHETIC_CATALOGUE, llm.used, 8); assert.ok(v.pass, JSON.stringify(v.checks));
    assert.ok(r.domains.some((d) => d.picks.length > 0), 'a slate was built from the plan');
    if (api === 'interactions') assert.ok(stub.seen.every((s) => s.body.store === false));
  });
  test(`PLANNER FALLBACK ${api}: invented tools and titles are rejected by the validator, nothing is executed, and the run falls back to the scripted workflow with a visible label`, async () => {
    stub.handler = scriptedModel('invented-tool', api);
    const { p } = run(api); const r = must(await p);
    assert.equal(r.workflow!.kind, 'planner-fallback');
    assert.match(r.workflow!.label, /^scripted workflow \(planner stopped: invalid_limit/);
    assert.ok(r.plannerDecisions!.every((d) => d.status === 'rejected'), 'no invented call was executed');
    const cat = new Set([...SYNTHETIC_CATALOGUE.matchAll(/^(?:movie|tv|podcast|music|artist)\s*:\s*(.+?)(?:\s*\(\d{4}\))?\s*$/gim)].map((m) => m[1]!.trim().toLowerCase()));
    for (const t of r.domains.flatMap((d) => d.picks.map((x) => String((x as { title?: string }).title ?? '').toLowerCase().replace(/\s*\(synthetic\)$/, '')))) assert.ok(cat.has(t), `${t} is a catalogue title`);
    assert.ok(!JSON.stringify(r).includes('Totally Real Film'), 'the invented title appears nowhere in the result');
    assert.ok(!evaluatePlannerRun(r, SYNTHETIC_CATALOGUE, 3, 8).pass);
  });
  test(`PLANNER FALLBACK ${api}: an invented anchor id is rejected by the grounding rule`, async () => {
    stub.handler = scriptedModel('invented-anchor', api);
    const { p } = run(api); const r = must(await p);
    assert.ok(r.plannerDecisions!.some((d) => d.status === 'rejected' && /no earlier read_location returned/.test(d.result)));
  });
}

// ---- key leak: a fake key string must appear in no output ----
test('LEAK: the key appears in no result, trace, evidence, error, smoke line or console output, in either transport, including when the provider echoes it in an error body', async () => {
  const logged: string[] = []; const orig = { log: console.log, error: console.error, warn: console.warn };
  console.log = (...a) => logged.push(a.join(' ')); console.error = (...a) => logged.push(a.join(' ')); console.warn = (...a) => logged.push(a.join(' '));
  const outputs: string[] = [];
  try {
    for (const api of APIS) {
      stub.handler = scriptedModel('good', api);
      const { p } = run(api); outputs.push(JSON.stringify(must(await p)));
      stub.handler = () => ({ status: 403, json: { error: { message: `bad key ${KEY}` } } });
      try { await prov(api).completeJson('p'); } catch (e) { outputs.push(String((e as Error).message), JSON.stringify(e)); }
      const bad = prov(api); try { await bad.completeJson('p'); } catch { /* expected */ } outputs.push(bad.lastAttempts.join(','), bad.name);
      stub.handler = (_n, _b, url) => (url.endsWith('/models?pageSize=200') ? { status: 200, json: { models: [{ name: 'models/gemini-3.5-flash-lite' }] } } : api === 'generateContent' ? genOk('{"ok":true}') : interSteps('{"ok":true}'));
      outputs.push(smokeLine(await geminiSmoke(KEY, ['gemini-3.5-flash-lite'], stub.fetch, { list: true })));
    }
  } finally { console.log = orig.log; console.error = orig.error; console.warn = orig.warn; }
  for (const o of [...outputs, ...logged]) assert.ok(!o.includes(KEY) && !o.includes('FAKE-KEY'), 'the key leaked');
});

// ---- smoke script: parses the reply, lists models first, prints a redacted summary ----
test('SMOKE: lists the models read-only first, prefers those the key can see, parses the reply in both shapes and prints a redacted line (no text, no key)', async () => {
  for (const api of APIS) {
    stub.seen.length = 0;
    stub.handler = (_n, _b, url) => url.includes('/v1beta/models?') ? { status: 200, json: { models: [{ name: 'models/gemini-3.8-flash' }, { name: 'models/other' }] } } : api === 'generateContent' ? (url.includes(':generateContent') ? genOk('{"ok":true}') : { status: 404 }) : (url.includes(':generateContent') ? { status: 404, json: {} } : interSteps('{"ok":true}'));
    const r = await geminiSmoke(KEY, ['gemini-3.5-flash-lite', 'gemini-3.8-flash'], stub.fetch, { list: true });
    assert.equal(stub.seen[0]!.url.startsWith('/v1beta/models?'), true, 'the read-only list is the first call');
    assert.equal(stub.seen[0]!.key, KEY);
    assert.equal(r.ok, true); assert.equal(r.model, 'gemini-3.8-flash', 'the model the key can see is tried first'); assert.equal(r.api, api); assert.equal(r.json, true); assert.equal(r.via, api === 'generateContent' ? 'candidates' : 'steps');
    const line = smokeLine(r); assert.ok(!line.includes(KEY) && !/"ok":true/.test(line), line);
    assert.match(line, /^ok: model gemini-3\.8-flash via /);
  }
  stub.handler = () => ({ status: 404, json: {} });
  const l = await listModels(KEY, stub.fetch); assert.equal(l.status, 404); assert.deepEqual(l.names, []);
  const f = await geminiSmoke(KEY, ['gemini-3.5-flash-lite'], stub.fetch, { list: true });
  assert.equal(f.ok, false); assert.match(smokeLine(f), /^failed: no model answered .*model list unavailable \(404\)/);
});
