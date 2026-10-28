import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { HttpQlooClient, resetQlooCooldown } from '../src/qloo/http-client.ts';
import { QlooError } from '../src/qloo/types.ts';
import { FX } from './helpers/contract-suite.ts';

const KEY = ['FAKE', 'KEY', 'failure', '9876543210'].join('-');
beforeEach(() => resetQlooCooldown());

function client(responses: (Response | Error)[], calls: string[] = []) {
  const f = (async (url: string | URL | Request) => {
    calls.push(String(url));
    const r = responses.shift() ?? new Response(JSON.stringify(FX.insights), { status: 200 });
    if (r instanceof Error) throw r;
    return r;
  }) as typeof fetch;
  return new HttpQlooClient({ apiKey: KEY, fetchImpl: f, sleep: async () => {}, maxRetries: 2 });
}
const q = (c: HttpQlooClient) => c.insights({ domain: 'movie', location: { query: 'Orlando' } });
async function kindOf(p: Promise<unknown>): Promise<QlooError> {
  try { await p; } catch (e) { assert.ok(e instanceof QlooError, String(e)); assert.ok(!String(e.message).includes(KEY)); return e; }
  assert.fail('expected a QlooError');
}
const timeout = () => Object.assign(new Error(`aborted ${KEY}`), { name: 'TimeoutError' });

test('timeout: retried a bounded number of times, then kind=timeout, message without the key', async () => {
  const calls: string[] = [];
  const e = await kindOf(q(client([timeout(), timeout(), timeout(), timeout()], calls)));
  assert.equal(e.kind, 'timeout');
  assert.equal(calls.length, 3);
});
test('timeout then success recovers', async () => {
  assert.equal((await q(client([timeout()]))).data.length, 2);
});
test('network error: kind=network, original message (which could hold the key) is not propagated', async () => {
  const e = await kindOf(q(client([new Error(`ECONNRESET ${KEY}`), new Error('x'), new Error('y')])));
  assert.equal(e.kind, 'network');
});
for (const [status, kind] of [[401, 'auth'], [403, 'forbidden_type'], [404, 'not_found'], [400, 'bad_request']] as const) {
  test(`${status} -> ${kind}, not retried`, async () => {
    const calls: string[] = [];
    const e = await kindOf(q(client([new Response('nope', { status })], calls)));
    assert.equal(e.kind, kind); assert.equal(e.status, status); assert.equal(calls.length, 1);
  });
}
test('429 then success: retried after backoff', async () => {
  const calls: string[] = [];
  const r = await q(client([new Response('', { status: 429, headers: { 'retry-after': '1' } })], calls));
  assert.equal(r.data.length, 2); assert.equal(calls.length, 2);
});
test('429 forever: kind=rate_limited after bounded retries', async () => {
  const calls: string[] = [];
  const e = await kindOf(q(client([429, 429, 429, 429].map((s) => new Response('', { status: s })), calls)));
  assert.equal(e.kind, 'rate_limited'); assert.equal(calls.length, 3);
});
test('5xx forever: kind=server after bounded retries; 5xx then success recovers', async () => {
  const calls: string[] = [];
  const e = await kindOf(q(client([502, 503, 500, 500].map((s) => new Response('', { status: s })), calls)));
  assert.equal(e.kind, 'server'); assert.equal(calls.length, 3);
  resetQlooCooldown();
  assert.equal((await q(client([new Response('', { status: 503 })]))).data.length, 2);
});
test('malformed JSON: kind=malformed, not retried', async () => {
  const calls: string[] = [];
  const e = await kindOf(q(client([new Response('<html>oops', { status: 200 })], calls)));
  assert.equal(e.kind, 'malformed'); assert.equal(calls.length, 1);
});
test('wrong shapes: results.entities not an array, non-object body, string entity items', async () => {
  for (const body of [{ results: { entities: 'x' } }, [1, 2], 'str', { results: { entities: [1, 2] } }]) {
    const e = await kindOf(q(client([new Response(JSON.stringify(body), { status: 200 })])));
    assert.equal(e.kind, 'malformed');
  }
});
test('empty results are a valid empty answer, not an error', async () => {
  for (const body of [{}, { results: {} }, FX.empty, { results: { entities: null } }]) {
    const r = await q(client([new Response(JSON.stringify(body), { status: 200 })]));
    assert.deepEqual(r.data, []);
  }
  const s = await client([new Response('{"results":[]}', { status: 200 })]).searchLocality('Nowhere');
  assert.deepEqual(s.data, []);
});
