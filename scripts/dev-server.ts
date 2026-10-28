// Local server that runs the same Worker fetch handler under Node 22+ (no wrangler needed).
// Usage: node scripts/dev-server.ts [port]
// Reads .dev.vars (gitignored) for QLOO_API_KEY / GEMINI_API_KEY if present; never prints them.
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import worker, { type Env } from '../src/worker.ts';

const env: Env = {};
const varsPath = new URL('../.dev.vars', import.meta.url);
if (existsSync(varsPath)) {
  for (const line of readFileSync(varsPath, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && m[2]) (env as Record<string, string>)[m[1]!] = m[2].replace(/^["']|["']$/g, '');
  }
}
for (const k of ['QLOO_API_KEY', 'GEMINI_API_KEY', 'LLM_PROVIDER', 'GEMINI_MODEL', 'FORCE_SYNTHETIC', 'SCORING_MODE', 'MAX_QLOO_CALLS_PER_RUN', 'LIVE_ENABLED', 'DAILY_CALL_CAP', 'PER_VISITOR_CALL_CAP', 'EXAMPLE_CALL_BUDGET', 'PLANNER_ENABLED']) {
  if (process.env[k]) (env as Record<string, string>)[k] = process.env[k]!;
}

const port = Number(process.argv[2] ?? process.env.PORT ?? 8787);
createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const headers = Object.fromEntries(Object.entries(req.headers).filter(([, v]) => typeof v === 'string') as [string, string][]);
  headers['cf-connecting-ip'] = req.socket.remoteAddress ?? 'unknown'; // never trust a client-sent value
  const request = new Request(`http://localhost:${port}${req.url}`, {
    method: req.method,
    headers,
    ...(body && req.method !== 'GET' && req.method !== 'HEAD' ? { body } : {}),
  });
  const pending: Promise<unknown>[] = [];
  const response = await worker.fetch(request, env, { waitUntil: (p) => pending.push(p) });
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (response.body) {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  }
  res.end();
}).listen(port, () => {
  console.log(`Seatback on http://localhost:${port} (${env.QLOO_API_KEY && env.FORCE_SYNTHETIC !== '1' ? 'LIVE Qloo' : 'synthetic fixtures'})`);
});
