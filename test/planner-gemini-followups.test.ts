// Targeted tests for the two mutants the independent review of v2 found surviving (CONTRACT tests against a local stub; not evidence of model behaviour):
//  M5: in auto mode a 429 must not be retried on the other endpoint (no extra request that could burn quota or money);
//  M7: each transport's request timeout is the documented-by-us value (generateContent 20 s, Interactions 30 s, model list 20 s) and is actually applied to the request.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { GeminiProvider, LlmError } from '../src/llm/provider.ts';
import { listModels } from '../scripts/gemini-smoke.ts';
import { startStub, genOk, interOutputText, type Stub } from './helpers/gemini-stub.ts';

const KEY = ['FAKE', 'KEY', 'followup', '77aa'].join('-');
let stub: Stub;
before(async () => { stub = await startStub(); });
after(() => stub.close());

test('M5: auto mode never retries a 429 on the other endpoint: a 429 from generateContent ends that call after ONE request', async () => {
  stub.seen.length = 0; stub.handler = () => ({ status: 429, json: { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'quota' } } });
  const p = new GeminiProvider(KEY, 'gemini-3.5-flash-lite', stub.fetch, 'auto', { strict: true });
  await assert.rejects(() => p.completeJson('x'), (e: LlmError) => e.kind === 'rate_limited' && e.status === 429);
  assert.equal(stub.seen.length, 1, 'exactly one request: no Interactions leg after a 429');
  assert.ok(stub.seen[0]!.url.includes(':generateContent'));
});
test('M5: auto mode with generateContent missing (404) tries the Interactions leg ONCE; a 429 there ends the call, with no third request', async () => {
  stub.seen.length = 0; stub.handler = (_n, _b, url) => (url.includes(':generateContent') ? { status: 404, json: {} } : { status: 429, json: {} });
  const p = new GeminiProvider(KEY, 'gemini-3.5-flash-lite', stub.fetch, 'auto', { strict: true });
  await assert.rejects(() => p.completeJson('x'), (e: LlmError) => e.kind === 'rate_limited');
  assert.deepEqual(stub.seen.map((s) => (s.url.includes(':generateContent') ? 'generateContent' : 'interactions')), ['generateContent', 'interactions']);
});
test('M5: auto mode does not fall through to the Interactions leg on a safety block either', async () => {
  stub.seen.length = 0; stub.handler = () => ({ status: 200, json: { promptFeedback: { blockReason: 'SAFETY' } } });
  await assert.rejects(() => new GeminiProvider(KEY, 'gemini-3.5-flash-lite', stub.fetch, 'auto', { strict: true }).completeJson('x'), (e: LlmError) => e.kind === 'blocked');
  assert.equal(stub.seen.length, 1);
});

/** Records every AbortSignal.timeout(ms) the code asks for while `fn` runs. */
async function timeouts(fn: () => Promise<unknown>): Promise<number[]> {
  const orig = AbortSignal.timeout; const asked: number[] = [];
  AbortSignal.timeout = ((ms: number) => { asked.push(ms); return orig.call(AbortSignal, ms); }) as typeof AbortSignal.timeout;
  try { await fn(); } finally { AbortSignal.timeout = orig; }
  return asked;
}
test('M7: the request timeouts are applied and have the stated values: generateContent 20 s, Interactions 30 s, model list 20 s', async () => {
  stub.handler = () => genOk('{"a":1}');
  assert.deepEqual(await timeouts(() => new GeminiProvider(KEY, 'gemini-3.5-flash-lite', stub.fetch, 'generateContent', { strict: true }).completeJson('x')), [20_000]);
  stub.handler = () => interOutputText('{"a":1}');
  assert.deepEqual(await timeouts(() => new GeminiProvider(KEY, 'gemini-3.5-flash-lite', stub.fetch, 'interactions', { strict: true }).completeJson('x')), [30_000]);
  stub.handler = () => ({ status: 200, json: { models: [] } });
  assert.deepEqual(await timeouts(() => listModels(KEY, stub.fetch)), [20_000]);
});
test('M7: the signal handed to fetch is a live AbortSignal on the Interactions request (a request that never answers is aborted by it)', async () => {
  let sig: AbortSignal | undefined;
  const f = (async (_u: string, init: RequestInit) => { sig = init.signal as AbortSignal; return new Response(JSON.stringify({ output_text: '{"a":1}' })); }) as unknown as typeof fetch;
  await new GeminiProvider(KEY, 'gemini-3.5-flash-lite', f, 'interactions', { strict: true }).completeJson('x');
  assert.ok(sig instanceof AbortSignal && sig.aborted === false, 'a signal is passed and not yet aborted');
});
