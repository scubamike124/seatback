/** Plain Node HTTP adapter around the Worker's fetch handler (Railway and any container host). Node >= 22.18 (runs .ts directly).
 *  - Request/Response bridge with streaming (NDJSON traces flow through with backpressure).
 *  - Body cap (Content-Length and counted bytes) before the app sees anything.
 *  - Client address: the socket address, or, ONLY when TRUST_PROXY_HEADER is set, the platform's header
 *    (x-real-ip, or the LAST hop of x-forwarded-for). A client-sent cf-connecting-ip is always discarded.
 *  - Disconnects abort the request signal (the app stops spending Qloo calls). */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import worker, { type Env } from '../worker.ts';
import { FileCounter, FileStore } from '../storage/file-store.ts';

export const DEFAULT_MAX_BODY = 64 * 1024;
const ENV_NAMES = ['QLOO_API_KEY', 'GEMINI_API_KEY', 'LLM_PROVIDER', 'GEMINI_MODEL', 'MAX_QLOO_CALLS_PER_RUN', 'LIVE_ENABLED', 'DAILY_CALL_CAP', 'PER_VISITOR_CALL_CAP', 'EXAMPLE_CALL_BUDGET', 'PLANNER_ENABLED', 'SCORING_MODE', 'ADMIN_TOKEN', 'DEMO_ACCESS_TOKEN', 'LLM_CALLS_PER_RUN', 'EXAMPLE_LLM_CALLS', 'PER_VISITOR_LLM_CALL_CAP', 'DAILY_LLM_CALL_CAP', 'FORCE_SYNTHETIC', 'GLOBAL_API_PER_MINUTE', 'GLOBAL_RUNS_PER_MINUTE', 'MAX_CONCURRENT_RUNS'];

/** Environment for the worker from process.env (names only; values never logged). DATA_DIR enables the private file store. */
export function envFromProcess(p: Record<string, string | undefined>): Env {
  const env: Env = {};
  for (const k of ENV_NAMES) if (p[k]) (env as Record<string, string>)[k] = p[k]!;
  const dir = p.DATA_DIR || null;
  if (dir) env.CACHE_KV = new FileStore(dir) as unknown as Env['CACHE_KV'];
  env.COUNTER = new FileCounter(dir);
  return env;
}

/** Which client-address header to trust. Only these two exact values enable trust; anything else (including unset) means "do not trust any header". */
export function proxyHeaderMode(trust: string | undefined): 'x-real-ip' | 'x-forwarded-for' | null {
  const m = (trust ?? '').trim().toLowerCase();
  return m === 'x-real-ip' || m === 'x-forwarded-for' ? m : null;
}

/** Startup advice for the proxy-header setting, or undefined if there is nothing to say. Behind a reverse proxy (Railway included: which header it
 *  sets is UNVERIFIED, check its docs or a test request) the socket address is the proxy's, so with trust OFF every visitor shares ONE rate-limit
 *  bucket and judges can lock each other out; with trust ON for a header the proxy does not overwrite, a visitor can pick their own address. */
export function proxyTrustAdvice(trust: string | undefined, production: boolean): string | undefined {
  const raw = (trust ?? '').trim();
  if (raw && !proxyHeaderMode(raw)) return `TRUST_PROXY_HEADER="${raw.slice(0, 40)}" is not x-real-ip or x-forwarded-for: ignored, so all visitors behind a proxy share ONE rate-limit bucket.`;
  if (!raw && production) return 'TRUST_PROXY_HEADER is not set: client addresses come from the socket. Behind a reverse proxy every visitor then shares ONE rate-limit bucket (per-IP limits become global). Set it to the header your proxy overwrites (x-real-ip or x-forwarded-for) once you have verified that.';
  return undefined;
}

export interface ClientAddress { ip: string; /** true when trust was enabled but the header was missing or malformed, so the socket address was used */ degraded: boolean }
export function resolveClientAddress(socketAddr: string | undefined, headers: IncomingMessage['headers'], trust: string | undefined): ClientAddress {
  const fallback = socketAddr || 'unknown';
  const mode = proxyHeaderMode(trust);
  const pick = (v: string | string[] | undefined) => (Array.isArray(v) ? v[v.length - 1] : v)?.trim();
  let ip: string | undefined;
  // x-forwarded-for: the LAST entry is the one our own (single, trusted) proxy appended; earlier entries are client-supplied and ignored.
  if (mode === 'x-real-ip') ip = pick(headers['x-real-ip']);
  else if (mode === 'x-forwarded-for') ip = pick(headers['x-forwarded-for'])?.split(',').pop()?.trim();
  const ok = !!ip && /^[0-9a-fA-F:.]{3,45}$/.test(ip);
  return { ip: ok ? ip! : fallback, degraded: !!mode && !ok };
}
export function clientAddress(socketAddr: string | undefined, headers: IncomingMessage['headers'], trust: string | undefined): string {
  return resolveClientAddress(socketAddr, headers, trust).ip;
}

/** Token policy: a warning below 24 characters; below 16 the server must not start in production. */
export function checkAccessToken(token: string | undefined, production: boolean): { ok: boolean; warning?: string } {
  if (!token) return { ok: true };
  if (token.length < 16 && production) return { ok: false, warning: 'DEMO_ACCESS_TOKEN is shorter than 16 characters: refusing to start in production. Use 24 or more random characters.' };
  if (token.length < 24) return { ok: true, warning: 'DEMO_ACCESS_TOKEN is shorter than 24 characters: use a longer random value.' };
  return { ok: true };
}

export function createNodeServer(env: Env, opts: { maxBody?: number; trustProxyHeader?: string; warn?: (m: string) => void } = {}): Server {
  const warn = opts.warn ?? ((m: string) => console.warn(m));
  let lastDegradedWarn = 0;
  const maxBody = opts.maxBody ?? DEFAULT_MAX_BODY;
  const server = createServer(async (req, res) => {
    const ac = new AbortController();
    res.on('close', () => { if (!res.writableEnded) ac.abort(); });
    try {
      const declared = Number(req.headers['content-length'] ?? 0);
      if (declared > maxBody) { res.writeHead(413, { 'content-type': 'application/json' }); res.end('{"error":"Request too large"}'); req.destroy(); return; }
      const chunks: Buffer[] = []; let size = 0;
      for await (const c of req) { size += (c as Buffer).length; if (size > maxBody) { res.writeHead(413, { 'content-type': 'application/json' }); res.end('{"error":"Request too large"}'); req.destroy(); return; } chunks.push(c as Buffer); }
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string' && k !== 'cf-connecting-ip') headers.set(k, v);
      const who = resolveClientAddress(req.socket.remoteAddress, req.headers, opts.trustProxyHeader);
      if (who.degraded && Date.now() - lastDegradedWarn > 60_000) { lastDegradedWarn = Date.now(); warn(`WARNING: TRUST_PROXY_HEADER=${opts.trustProxyHeader} is set but a request arrived without a usable value; using the socket address (shared rate-limit bucket for such requests).`); }
      headers.set('cf-connecting-ip', who.ip);
      const hasBody = req.method !== 'GET' && req.method !== 'HEAD' && chunks.length > 0;
      const host = req.headers.host ?? 'localhost';
      const proto = (Array.isArray(req.headers['x-forwarded-proto']) ? req.headers['x-forwarded-proto'][0] : req.headers['x-forwarded-proto']) === 'https' ? 'https' : 'http';
      const request = new Request(`${proto}://${host}${req.url ?? '/'}`, { method: req.method, headers, signal: ac.signal, ...(hasBody ? { body: Buffer.concat(chunks) } : {}) });
      const pending: Promise<unknown>[] = [];
      const response = await worker.fetch(request, env, { waitUntil: (p) => pending.push(p) });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) {
        const reader = response.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!res.write(value)) await new Promise<void>((r) => res.once('drain', r));
          if (ac.signal.aborted) { await reader.cancel().catch(() => {}); break; }
        }
      }
      res.end();
    } catch {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"error":"Internal error"}');
    }
  });
  // Slow or stalled clients are cut off instead of held for Node's 300 s default.
  server.requestTimeout = 30_000; server.headersTimeout = 15_000; server.keepAliveTimeout = 5_000;
  return server;
}

/** Graceful stop: stop accepting, let in-flight requests finish for up to graceMs, then close the rest. */
export function installGracefulShutdown(server: Server, graceMs = 10_000, exit: (code: number) => void = (c) => process.exit(c)): (sig: string) => Promise<void> {
  let stopping = false;
  return async () => {
    if (stopping) return; stopping = true;
    const t = setTimeout(() => { server.closeAllConnections(); exit(0); }, graceMs); t.unref();
    server.close(() => { clearTimeout(t); exit(0); });
    server.closeIdleConnections();
  };
}
