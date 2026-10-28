import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateNote } from '../src/agent/narrative.ts';
import { EvidenceLedger, checkGrounding } from '../src/agent/evidence.ts';
import { parseJsonLoose, providerFromEnv, GeminiProvider } from '../src/llm/provider.ts';

const ledger = new EvidenceLedger();
ledger.add('x', { data: [], request: { path: '/v2/insights', params: {} }, source: 'synthetic-fixture', cached: false, ms: 1 });
const facts: Parameters<typeof validateNote>[1] = { route: ['A', 'B'], domains: [{ domain: 'Films', abstained: null, endsAgreeTau: 0.2, picks: [{ title: 'Paper Comets', side: 'both' as const, fit: 81, evidence: ['E1'] }] }] };

test('validateNote keeps grounded sentences and rejects invented titles, numbers and evidence', () => {
  const out = validateNote(
    [
      { text: '"Paper Comets" leads the films with fit 81.', evidence: ['E1'] },
      { text: '"Some Other Film" is great.', evidence: ['E1'] },
      { text: 'It will get 500 views.', evidence: ['E1'] },
      { text: 'No evidence here.', evidence: [] },
      { text: 'Unknown evidence.', evidence: ['E77'] },
    ],
    facts,
    ledger,
  );
  assert.equal(out.length, 1);
  assert.equal(out[0]!.by, 'llm');
});

test('checkGrounding counts interpretation separately and flags uncited claims', () => {
  const g = checkGrounding(
    [
      { text: 'a', evidence: ['E1'], kind: 'qloo' },
      { text: 'b', evidence: [], kind: 'computed' },
      { text: 'c', evidence: [], kind: 'interpretation' },
    ],
    ledger,
  );
  assert.equal(g.grounded, 1);
  assert.equal(g.interpretation, 1);
  assert.equal(g.rate, 0.5);
  assert.deepEqual(g.ungrounded, ['b']);
});

test('parseJsonLoose handles fenced output', () => {
  assert.deepEqual(parseJsonLoose('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonLoose('Sure! {"a":2} done'), { a: 2 });
  assert.throws(() => parseJsonLoose('nope'));
});

test('providerFromEnv: gemini needs a key; none disables; no key means no LLM', () => {
  assert.equal(providerFromEnv({}), null);
  assert.equal(providerFromEnv({ LLM_PROVIDER: 'none', GEMINI_API_KEY: 'k' }), null);
  assert.match(providerFromEnv({ GEMINI_API_KEY: 'k' })!.name, /^gemini:/);
});

test('GeminiProvider sends the key in a header, not the URL', async () => {
  let url = '';
  let headers: Record<string, string> = {};
  const p = new GeminiProvider('secret-gem', 'gemini-2.5-flash', (async (u: string, init: RequestInit) => {
    url = String(u);
    headers = init.headers as Record<string, string>;
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] }), { status: 200 });
  }) as unknown as typeof fetch);
  assert.equal(await p.completeJson('hi'), '{"ok":true}');
  assert.ok(!url.includes('secret-gem'));
  assert.equal(headers['x-goog-api-key'], 'secret-gem');
});
