// A local stand-in for the Gemini API, used by CONTRACT tests only. It answers in the shapes the adapter was written against: generateContent (candidates/parts) and the Interactions API
// (output_text, steps with model_output text blocks, as the docs show them through the SDK and jq .steps). A contract test proves the adapter's parsing and the planner's handling; it is NOT
// evidence of what a real Gemini model does, and the raw Interactions reply shape is UNVERIFIED against a live reply.
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export type StubOut = { status: number; json?: unknown; text?: string };
export type Seen = { url: string; key: string | undefined; body: any };
export interface Stub { port: number; seen: Seen[]; handler: (n: number, body: any, url: string) => StubOut; fetch: typeof fetch; close(): Promise<void> }

export async function startStub(): Promise<Stub> {
  const stub: Stub = { port: 0, seen: [], handler: () => ({ status: 200, json: {} }), fetch: undefined as never, close: async () => undefined };
  const server = http.createServer((q, r) => {
    let b = ''; q.on('data', (c) => (b += c)); q.on('end', () => {
      let body: any = {}; try { body = JSON.parse(b || '{}'); } catch { /* not JSON */ }
      stub.seen.push({ url: q.url ?? '', key: q.headers['x-goog-api-key'] as string | undefined, body });
      let out: StubOut;
      try { out = stub.handler(stub.seen.length, body, q.url ?? ''); } catch { out = { status: 500, json: { error: { code: 500, message: 'stub failure', status: 'INTERNAL' } } }; }
      r.writeHead(out.status, { 'content-type': 'application/json' }); r.end(out.text ?? JSON.stringify(out.json ?? {}));
    });
  });
  await new Promise<void>((o) => server.listen(0, '127.0.0.1', o));
  stub.port = (server.address() as AddressInfo).port;
  stub.fetch = ((u: string, init: RequestInit) => fetch(String(u).replace('https://generativelanguage.googleapis.com', `http://127.0.0.1:${stub.port}`), init)) as typeof fetch;
  stub.close = () => new Promise<void>((o) => { server.closeAllConnections?.(); server.close(() => o()); });
  return stub;
}

export const genOk = (text: string): StubOut => ({ status: 200, json: { candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP', index: 0 }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 }, modelVersion: 'stub' } });
/** Interactions reply with the text in `steps` (a user step, a thought step and a model step, as the docs list steps). */
export const interSteps = (text: string): StubOut => ({ status: 200, json: { id: 'stub-interaction', status: 'completed', steps: [{ type: 'user_input', content: [{ type: 'text', text: 'the prompt' }] }, { type: 'thought', summary: [{ type: 'text', text: 'private reasoning' }] }, { type: 'model_output', content: [{ type: 'text', text }] }] } });
export const interOutputText = (text: string): StubOut => ({ status: 200, json: { id: 'stub-interaction', status: 'completed', output_text: text, steps: [] } });
export const shapeOf = (api: 'generateContent' | 'interactions', text: string): StubOut => (api === 'generateContent' ? genOk(text) : interSteps(text));

/** A scripted stand-in for a model: reads the planner prompt it was sent and answers with one JSON action. It is code, not intelligence. */
export function scriptedModel(mode: 'good' | 'invented-anchor' | 'invented-tool', api: 'generateContent' | 'interactions' = 'generateContent'): Stub['handler'] {
  return (_n, body) => {
    const prompt: string = api === 'generateContent' ? body.contents[0].parts[0].text : String(body.input);
    const m = /STEP (\d+) of/.exec(prompt);
    if (!m) return shapeOf(api, '{}'); // the programmer's-note prompt: nothing to say
    const step = Number(m[1]);
    if (mode === 'invented-tool') return shapeOf(api, JSON.stringify({ action: 'recommend_titles', args: { titles: ['Totally Real Film', 'Another Invented Show'] }, reason: 'These are great.' }));
    const data = JSON.parse(prompt.slice(prompt.indexOf('<<<DATA') + 7, prompt.indexOf('DATA>>>')));
    const firstId = (end: string) => {
      const h = (data.history as any[]).find((x) => x.action === 'read_location' && String(x.args).includes(end) && String(x.args).includes('artist'));
      return h ? /([A-Za-z0-9:_-]+) \|/.exec(h.result)?.[1] : undefined;
    };
    if (step === 1) return shapeOf(api, JSON.stringify({ action: 'read_location', args: { end: 'origin', domain: 'artist' }, reason: 'See what the origin favours in music.' }));
    if (step === 2) return shapeOf(api, JSON.stringify({ action: 'read_location', args: { end: 'destination', domain: 'artist' }, reason: 'See what the destination favours in music.' }));
    const o = mode === 'invented-anchor' ? 'SYN-NOT-A-REAL-ID' : firstId('origin'), d = firstId('destination');
    return shapeOf(api, JSON.stringify({ action: 'finish', args: { anchors: { origin: { artist: [o] }, destination: { artist: [d] } } }, reason: 'Anchors that distinguish the two ends.' }));
  };
}
