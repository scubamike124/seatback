/**
 * Cloudflare Worker entry point. Also runs under Node via scripts/dev-server.ts.
 *
 * Routes:
 *   GET  /                    the app
 *   GET  /app.js, /app.css    client assets
 *   GET  /api/config          mode (live or synthetic), LLM, example routes
 *   GET  /api/example/:id     cached example (judge mode): no live Qloo spend after warm-up
 *   POST /api/slate           run the workflow (scripted, or the LLM planner when configured); streams NDJSON trace events, then the result
 *   POST /api/admin/warm      (ADMIN_TOKEN) re-run the examples live and store them in private KV
 *   GET  /api/health
 */
import { recordable, trimForRecording } from './export.ts';
import { accessGate, withPreviewBanner } from './access.ts';
import { ICON_PNG_BASE64 } from './ui/icon.ts';
import { BudgetedLlm, DEFAULT_DAILY_LLM_CALLS, DEFAULT_EXAMPLE_LLM_CALLS, DEFAULT_LLM_CALLS_PER_RUN, DEFAULT_VISITOR_LLM_CALLS } from './llm/budget.ts';
import { createQlooClient, resolveMode, DEFAULT_EXAMPLE_BUDGET, DEFAULT_RUN_BUDGET, type QlooHandle } from './qloo/client.ts';
import { redactSecrets } from './qloo/redact.ts';
import { KvCache, MemoryCache, sha256, type KVLike, type ResponseCache } from './qloo/cache.ts';
import { type QlooClient, QlooError } from './qloo/types.ts';
import { providerFromEnv, type AiBinding } from './llm/provider.ts';
import { runPipeline } from './agent/pipeline.ts';
import type { SlateRequest, SlateResult, TraceEvent } from './agent/types.ts';
import { WindowLimiter, CallBudgetLedger, KvCounter, MemoryCounter, DEFAULT_DAILY_CALL_CAP, DEFAULT_VISITOR_CALL_CAP, clientKey, safeEqual, type AtomicCounter, type RateLimitBinding } from './ratelimit.ts';
import { personalDataIn } from './qloo/outbound.ts';
import { EXAMPLE_ROUTES, LIVE_SAMPLE_CATALOGUE, SYNTHETIC_CATALOGUE } from './examples.ts';
import { PAGE_HTML } from './ui/page.ts';
import { APP_JS } from './ui/app.ts';
import { APP_CSS } from './ui/styles.ts';

export interface Env {
  QLOO_API_KEY?: string;
  LLM_PROVIDER?: string;
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
  WORKERS_AI_MODEL?: string;
  AI?: AiBinding;
  /** Atomic counter (Deno KV). Without it the Workers-KV counter is best-effort: keep LIVE_ENABLED=0 there. */
  COUNTER?: AtomicCounter;
  CACHE_KV?: KVLike & { get(key: string): Promise<string | null>; get(key: string, type: 'json'): Promise<unknown | null> };
  RATE_LIMITER?: RateLimitBinding;
  MAX_QLOO_CALLS_PER_RUN?: string;
  SCORING_MODE?: string;
  ADMIN_TOKEN?: string;
  /** Private preview: when set, every route except /healthz needs this token (see src/access.ts). Unset = contest mode, gate off. */
  DEMO_ACCESS_TOKEN?: string;
  FORCE_SYNTHETIC?: string;
  /** Kill switch: custom live runs and on-demand live examples are OFF unless this is "1". */
  LIVE_ENABLED?: string;
  /** Qloo calls per UTC day, all visitors (default 600) and per visitor (default 120). */
  DAILY_CALL_CAP?: string;
  PER_VISITOR_CALL_CAP?: string;
  EXAMPLE_CALL_BUDGET?: string;
  /** "0" turns the LLM planner off (the scripted workflow runs). */
  PLANNER_ENABLED?: string;
  /** LLM call caps (all modes): per run, per visitor per day, global per day; examples use their own per-run cap. */
  LLM_CALLS_PER_RUN?: string;
  EXAMPLE_LLM_CALLS?: string;
  PER_VISITOR_LLM_CALL_CAP?: string;
  DAILY_LLM_CALL_CAP?: string;
  /** Public-demo controls (all optional): all /api/* except stored-example reads, per minute, all visitors (default 600). */
  GLOBAL_API_PER_MINUTE?: string;
  /** Custom runs and cold example computes per minute, all visitors (default 30). */
  GLOBAL_RUNS_PER_MINUTE?: string;
  /** Custom runs streaming at the same time (default 4). */
  MAX_CONCURRENT_RUNS?: string;
}

interface Ctx {
  waitUntil(p: Promise<unknown>): void;
}

const memCache = new MemoryCache(800);
const perIpLive = new WindowLimiter(4, 10 * 60_000);
const perIpAny = new WindowLimiter(60, 60_000);
const exampleMemo = new Map<string, SlateResult>();

// Public-demo controls. Defaults are generous for a few judges and small for an attacker; all are env-tunable and none lowers an existing limit.
export const DEFAULT_GLOBAL_API_PER_MINUTE = 600;
export const DEFAULT_GLOBAL_RUNS_PER_MINUTE = 30;
export const DEFAULT_MAX_CONCURRENT_RUNS = 4;
const globalLimiters = new Map<string, { api: WindowLimiter; runs: WindowLimiter; maxConc: number }>();
function globalLimits(env: Env) {
  const a = num(env.GLOBAL_API_PER_MINUTE, DEFAULT_GLOBAL_API_PER_MINUTE);
  const r = num(env.GLOBAL_RUNS_PER_MINUTE, DEFAULT_GLOBAL_RUNS_PER_MINUTE);
  const c = num(env.MAX_CONCURRENT_RUNS, DEFAULT_MAX_CONCURRENT_RUNS);
  const k = `${a}|${r}|${c}`;
  let g = globalLimiters.get(k);
  if (!g) { g = { api: new WindowLimiter(a, 60_000), runs: new WindowLimiter(r, 60_000), maxConc: c }; globalLimiters.set(k, g); }
  return g;
}
let activeRuns = 0;
/** Test hook: number of custom runs currently streaming. */
export function activeRunCount(): number { return activeRuns; }
/** A refusal that tells the visitor (and any script) what still works: the stored or synthetic example routes. Same status and `error` text as before; two fields added. */
function pausedJson(error: string, status: number, headers: Record<string, string> = {}): Response {
  return json({ error, fallback: 'stored-examples', exampleIds: EXAMPLE_ROUTES.map((r) => r.id) }, status, headers);
}

const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
};

export function isLive(env: Env): boolean {
  return resolveMode(env) === 'LIVE';
}

export function makeQlooHandle(env: Env, budget: number, shouldStop?: () => boolean): QlooHandle {
  const cache: ResponseCache | undefined = isLive(env) ? (env.CACHE_KV ? new KvCache(env.CACHE_KV) : memCache) : undefined;
  return createQlooClient(env, { budget, cache, shouldStop });
}
export function makeQloo(env: Env, budget: number): QlooClient {
  return makeQlooHandle(env, budget).client;
}

const memCounter = new MemoryCounter();
function callLedger(env: Env): CallBudgetLedger {
  const counter = env.COUNTER ?? (env.CACHE_KV ? new KvCounter(env.CACHE_KV) : memCounter);
  return new CallBudgetLedger(counter, num(env.DAILY_CALL_CAP, DEFAULT_DAILY_CALL_CAP), num(env.PER_VISITOR_CALL_CAP, DEFAULT_VISITOR_CALL_CAP));
}
function num(v: string | undefined, d: number): number {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : d;
}
const runBudget = (env: Env) => num(env.MAX_QLOO_CALLS_PER_RUN, DEFAULT_RUN_BUDGET);
const exampleBudget = (env: Env) => num(env.EXAMPLE_CALL_BUDGET, DEFAULT_EXAMPLE_BUDGET);
/** The configured LLM wrapped with per-run, per-visitor and per-day caps, in EVERY data mode (synthetic too). */
function llmFor(env: Env, visitor: string, perRun: number, admin = false): BudgetedLlm | null {
  const inner = providerFromEnv(env);
  if (!inner) return null;
  const counter = env.COUNTER ?? (env.CACHE_KV ? new KvCounter(env.CACHE_KV) : memCounter);
  const ledger = new CallBudgetLedger(counter, num(env.DAILY_LLM_CALL_CAP, DEFAULT_DAILY_LLM_CALLS), num(env.PER_VISITOR_LLM_CALL_CAP, DEFAULT_VISITOR_LLM_CALLS), () => new Date(), 'llm');
  return new BudgetedLlm(inner, perRun, { ledger, visitor, skipVisitor: admin });
}
const llmRunCap = (env: Env) => num(env.LLM_CALLS_PER_RUN, DEFAULT_LLM_CALLS_PER_RUN);
const llmExampleCap = (env: Env) => num(env.EXAMPLE_LLM_CALLS, DEFAULT_EXAMPLE_LLM_CALLS);
/** One computation per example key at a time (stops a thundering herd before the first KV write). */
const inflightExamples = new Map<string, Promise<SlateResult | null>>();
const lastRefusal = new Map<string, string>();
/** Test hook: forget this isolate's in-memory example results. */
export function resetExampleMemo(): void { exampleMemo.clear(); lastRefusal.clear(); }

export default {
  async fetch(request: Request, env: Env, ctx?: Ctx): Promise<Response> {
    try {
      if (request.method === 'HEAD') {
        // HEAD is answered like GET, without a body (uptime checks, link previews).
        const r = await route(new Request(request.url, { method: 'GET', headers: request.headers }), env, ctx);
        return new Response(null, { status: r.status, headers: r.headers });
      }
      return await route(request, env, ctx);
    } catch (e) {
      return json({ error: 'Internal error' }, 500);
    }
  },
};

async function route(request: Request, env: Env, ctx?: Ctx): Promise<Response> {
  const url = new URL(request.url);
  // Liveness probe for hosts: answers the same text always and reveals nothing about the deployment.
  if (url.pathname === '/healthz') return new Response('ok', { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
  const gated = await accessGate(request, env.DEMO_ACCESS_TOKEN);
  if (gated) return gated;
  const ip = clientKey(request);
  if (url.pathname.startsWith('/api/')) {
    const wait = perIpAny.check(ip);
    if (wait) return json({ error: `Too many requests. Try again in ${wait}s.` }, 429, { 'retry-after': String(wait) });
    // Stored or memoised example reads are cheap and are never blocked by the all-visitor cap, so judges can always open them.
    if (!(request.method === 'GET' && url.pathname.startsWith('/api/example/'))) {
      const gw = globalLimits(env).api.check('global');
      if (gw) return json({ error: `The demo is busy. Try again in ${gw}s.` }, 429, { 'retry-after': String(gw) });
    }
  }

  if (request.method === 'GET' && url.pathname === '/') return env.DEMO_ACCESS_TOKEN ? asset(withPreviewBanner(PAGE_HTML), 'text/html; charset=utf-8', true) : asset(PAGE_HTML, 'text/html; charset=utf-8');
  if (request.method === 'GET' && url.pathname === '/apple-touch-icon.png') return new Response(Uint8Array.from(atob(ICON_PNG_BASE64), (c) => c.charCodeAt(0)), { headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400', ...SECURITY_HEADERS } });
  if (request.method === 'GET' && url.pathname === '/manifest.webmanifest') return new Response(JSON.stringify({ name: 'Seatback', short_name: 'Seatback', start_url: '/', display: 'standalone', background_color: '#123a5c', theme_color: '#123a5c', icons: [{ src: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }] }), { headers: { 'content-type': 'application/manifest+json', 'cache-control': 'public, max-age=3600', ...SECURITY_HEADERS } });
  if (request.method === 'GET' && url.pathname === '/app.js') return asset(APP_JS, 'text/javascript; charset=utf-8');
  if (request.method === 'GET' && url.pathname === '/app.css') return asset(APP_CSS, 'text/css; charset=utf-8');
  if (request.method === 'GET' && url.pathname === '/api/health') return json({ ok: true, mode: isLive(env) ? 'live' : 'synthetic', dataLabel: isLive(env) ? 'LIVE' : 'MOCK' });

  if (request.method === 'GET' && url.pathname === '/api/config') {
    const llm = providerFromEnv(env);
    return json({
      mode: isLive(env) ? 'live' : 'synthetic',
      dataLabel: isLive(env) ? 'LIVE' : 'MOCK',
      callBudget: runBudget(env),
      // true only when custom runs would really call Qloo (a key is set AND the switch is on); synthetic fixtures are not "live".
      liveEnabled: isLive(env) && env.LIVE_ENABLED === '1',
      llm: llm?.name ?? null,
      examples: EXAMPLE_ROUTES.map(({ id, title, blurb, request: r }) => ({ id, title, blurb, request: r })),
      sampleCatalogue: isLive(env) ? LIVE_SAMPLE_CATALOGUE : SYNTHETIC_CATALOGUE,
    });
  }

  const ex = /^\/api\/example\/([a-z0-9-]{1,32})$/.exec(url.pathname);
  if (request.method === 'GET' && ex) {
    const route = EXAMPLE_ROUTES.find((r) => r.id === ex[1]);
    if (!route) return json({ error: 'Unknown example' }, 404);
    const key = `example:${isLive(env) ? 'live' : 'synthetic'}:${route.id}`;
    // Served as stored text, without parsing, to keep CPU time minimal on the Workers free plan.
    const memo = exampleMemo.get(key);
    let storedText: string | null | undefined = null;
    if (!memo) {
      try { storedText = await env.CACHE_KV?.get(key); } catch {
        // A failed, corrupt or incomplete replay is never a generic 500 and never leaks internals.
        return json({ error: 'Replay unavailable: the stored example could not be read right now, so nothing is shown rather than something partial. Try again shortly; the operator can re-record it.', replayUnavailable: true }, 503);
      }
    }
    if (memo || storedText) {
      const text = storedText ?? JSON.stringify(memo);
      // provenance says exactly what happened: a stored recording (live, from private storage) or a run computed in this process.
      const provenance = isLive(env) ? 'stored-recording' : 'computed-synthetic';
      return new Response(`{"provenance":"${provenance}","result":${text}}`, {
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SECURITY_HEADERS },
      });
    }
    if (isLive(env)) {
      // Live judge mode is served from the private KV cache, warmed by the owner with /api/admin/warm.
      if (!env.CACHE_KV) return json({ error: 'Judge mode on a live deployment needs the CACHE_KV binding. Ask the operator to configure it and warm the examples.' }, 503);
      if (env.LIVE_ENABLED !== '1') return json({ error: 'This example has not been recorded yet and live runs are switched off on this deployment.' }, 503);
      const wait = perIpLive.check(ip);
      if (wait) return json({ error: `Example is warming up; try again in ${wait}s.` }, 429);
      if (env.RATE_LIMITER && !(await env.RATE_LIMITER.limit({ key: ip })).success) return json({ error: 'Rate limit reached. Try again shortly.' }, 429);
    }
    const out = await computeExample(route.id, env, ip);
    if ('error' in out) return out.status === 429 ? pausedJson(out.error, 429) : json({ error: out.error }, out.status);
    return json({ provenance: isLive(env) ? 'computed-live' : 'computed-synthetic', result: out.result, ...(out.notStored ? { notStored: out.notStored } : {}) });
  }

  if (request.method === 'POST' && url.pathname === '/api/admin/warm') {
    if (!env.ADMIN_TOKEN || !(await safeEqual(request.headers.get('authorization') ?? '', `Bearer ${env.ADMIN_TOKEN}`))) return json({ error: 'Forbidden' }, 403);
    const out: Record<string, string> = {};
    for (const r of EXAMPLE_ROUTES) {
      lastRefusal.delete(r.id);
      const res = await computeExample(r.id, env, 'admin', true);
      out[r.id] = 'error' in res ? `not stored: ${res.error}` : lastRefusal.has(r.id) ? `NOT STORED: ${lastRefusal.get(r.id)}` : `ok (${res.result.metrics.qlooCalls} calls)`;
    }
    return json(out);
  }

  if (request.method === 'POST' && url.pathname === '/api/slate') {
    // CSRF / cost abuse: a cross-site <form> can only send simple content types, so require JSON and a same-origin Origin.
    if (!/^application\/json\b/i.test(request.headers.get('content-type') ?? '')) return json({ error: 'Content-Type must be application/json' }, 415);
    const origin = request.headers.get('origin');
    if (origin && origin !== url.origin) return json({ error: 'Cross-origin requests are not allowed' }, 403);
    const body = await readBody(request);
    if ('error' in body) return json({ error: body.error }, 400);
    // Public-demo caps (all visitors): runs per minute, then runs at the same time. A slot is taken before any await and handed to stream(), which frees it.
    const lim = globalLimits(env);
    const rw = lim.runs.check('global');
    if (rw) return pausedJson(`The demo is busy computing runs. Try again in ${rw}s. Example routes still work.`, 429, { 'retry-after': String(rw) });
    if (activeRuns >= lim.maxConc) return pausedJson('Too many runs are in progress. Try again in a few seconds. Example routes still work.', 503, { 'retry-after': '10' });
    activeRuns++;
    let handed = false;
    try {
    let reserved = 0;
    const visitor = (await sha256(ip)).slice(0, 16);
    if (isLive(env)) {
      if (env.LIVE_ENABLED !== '1') return pausedJson('Custom live runs are switched off on this deployment. Open one of the example routes.', 503);
      const wait = perIpLive.check(ip);
      if (wait) return json({ error: `Live runs are limited to 4 per 10 minutes per visitor. Try an example route, or wait ${wait}s.` }, 429);
      if (env.RATE_LIMITER && !(await env.RATE_LIMITER.limit({ key: ip })).success) return json({ error: 'Rate limit reached. Try an example route.' }, 429);
      reserved = runBudget(env);
      const ok = await callLedger(env).reserve(visitor, reserved);
      if (!ok.ok) return pausedJson(ok.reason === 'visitor' ? "You have used today's Qloo call allowance for custom runs. Example routes still work." : "Today's Qloo call budget is used up. Example routes still work.", 429);
    }
    handed = true;
    return stream(body.req, env, request, ctx, visitor, reserved);
    } finally { if (!handed) activeRuns--; }
  }

  return json({ error: 'Not found' }, 404);
}

type ExampleOut = { result: SlateResult; notStored?: string } | { error: string; status: number };

/** Computes one example (singleflight per key), charges the call ledger, and records it only if complete. */
async function computeExample(id: string, env: Env, visitorIp: string, admin = false): Promise<ExampleOut> {
  const key = `example:${isLive(env) ? 'live' : 'synthetic'}:${id}`;
  // Only the owner's warm-up may spend LLM calls on an example. A visitor-triggered compute (cold isolate, or LIVE_ENABLED=1)
  // runs the scripted workflow, labelled as such, and is never stored when an LLM is configured (it would not match what the example claims).
  const useLlm = admin;
  const flightKey = `${key}:${admin ? 'a' : 'v'}`;
  let p = inflightExamples.get(flightKey);
  if (!p) {
    p = (async () => {
      const live = isLive(env);
      const budget = exampleBudget(env);
      const visitor = admin ? 'admin' : (await sha256(visitorIp)).slice(0, 16);
      if (live) {
        const ok = await callLedger(env).reserve(visitor, budget, admin);
        if (!ok.ok) throw new QlooError('budget', 429, 'budget');
      }
      const r = EXAMPLE_ROUTES.find((x) => x.id === id)!;
      const h = makeQlooHandle(env, budget);
      try {
        const req: SlateRequest = { ...r.request, catalogue: live ? LIVE_SAMPLE_CATALOGUE : SYNTHETIC_CATALOGUE, autoConfirm: true };
        return await runPipeline(req, { qloo: h.client, llm: useLlm ? llmFor(env, visitor, llmExampleCap(env), true) : null, planner: { enabled: useLlm && env.PLANNER_ENABLED !== '0' }, emit: () => {}, scoringMode: env.SCORING_MODE === 'pinned' ? 'pinned' : 'anchored' });
      } finally {
        if (live) await callLedger(env).settle(visitor, budget, h.counter.used, admin);
      }
    })();
    inflightExamples.set(flightKey, p);
    p.then(() => inflightExamples.delete(flightKey), () => inflightExamples.delete(flightKey));
  }
  try {
    const result = await p;
    let notStored: string | undefined;
    if (!result) return { error: 'Example needs confirmation', status: 500 };
    // Recording gate: shown to the visitor either way, but stored only if complete and made by the method the example claims.
    const llmConfigured = !!providerFromEnv(env);
    const gate = admin || !llmConfigured ? recordable(result, { llmConfigured: admin && llmConfigured, plannerEnabled: env.PLANNER_ENABLED !== '0' }) : { ok: false as const, why: 'visitor-triggered run with an LLM configured' };
    if (gate.ok) {
      exampleMemo.set(key, result);
      if (isLive(env)) {
        try { await env.CACHE_KV?.put(key, JSON.stringify(trimForRecording(result))); } catch {
          // The computed result is still returned to the visitor, labelled as not stored.
          notStored = 'storage write failed';
          if (admin) lastRefusal.set(id, 'storage write failed (the result was computed but not stored)');
        }
      }
    } else if (admin) lastRefusal.set(id, gate.why);
    else if (!isLive(env) && !exampleMemo.has(key)) exampleMemo.set(key, result); // scripted, labelled, no LLM spent
    return { result, ...(notStored ? { notStored } : {}) };
  } catch (e) {
    if (e instanceof QlooError && e.kind === 'budget' && e.message === 'budget') return { error: "Today's Qloo call budget is used up.", status: 429 };
    return { error: e instanceof Error ? redactSecrets(e.message, [env.QLOO_API_KEY, env.GEMINI_API_KEY, env.ADMIN_TOKEN]) : 'Run failed', status: 500 };
  }
}

function stream(req: SlateRequest, env: Env, request: Request, ctx: Ctx | undefined, visitor: string, reserved: number): Response {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  let aborted = request.signal?.aborted ?? false;
  request.signal?.addEventListener('abort', () => { aborted = true; });
  const write = (e: TraceEvent) => writer.write(enc.encode(JSON.stringify(e) + '\n')).catch(() => { aborted = true; });
  const h = makeQlooHandle(env, runBudget(env), () => aborted);
  // Custom runs: swap test off, catalogue capped (call budget: see README).
  const run: SlateRequest = { ...req, swap: false, maxTitles: Math.min(req.maxTitles ?? CUSTOM_MAX_TITLES, CUSTOM_MAX_TITLES) };
  const job = (async () => {
    try {
      await runPipeline(run, {
        qloo: h.client,
        llm: llmFor(env, visitor, llmRunCap(env)),
        planner: { enabled: env.PLANNER_ENABLED !== '0' },
        emit: write,
        shouldStop: () => aborted,
        scoringMode: env.SCORING_MODE === 'pinned' ? 'pinned' : 'anchored',
      });
    } catch (e) {
      const msg = e instanceof QlooError || e instanceof Error ? redactSecrets(e.message, [env.QLOO_API_KEY, env.GEMINI_API_KEY, env.ADMIN_TOKEN]) : 'Run failed';
      await write({ type: 'error', message: msg });
    } finally {
      if (reserved) await callLedger(env).settle(visitor, reserved, h.counter.used).catch(() => {});
      await writer.close().catch(() => {});
      activeRuns = Math.max(0, activeRuns - 1);
    }
  })();
  ctx?.waitUntil(job);
  return new Response(readable, {
    headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', ...SECURITY_HEADERS },
  });
}

export const CUSTOM_MAX_TITLES = 20;

export async function readBody(request: Request): Promise<{ req: SlateRequest } | { error: string }> {
  const len = Number(request.headers.get('content-length') ?? 0);
  if (len > 20_000) return { error: 'Request too large' };
  let raw: any;
  try {
    const text = await request.text();
    if (text.length > 20_000) return { error: 'Request too large' };
    raw = JSON.parse(text);
  } catch {
    return { error: 'Body must be JSON' };
  }
  const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
  const origin = str(raw?.origin, 80).trim();
  const destination = str(raw?.destination, 80).trim();
  const catalogue = str(raw?.catalogue, 8000);
  if (!origin || !destination) return { error: 'Enter both route ends.' };
  // Personal data never goes to Qloo or an LLM: reject it in the route/theme text, drop catalogue lines that carry it.
  if (personalDataIn(origin).length || personalDataIn(destination).length || personalDataIn(str(raw?.theme, 40)).length) return { error: 'The route and theme fields must be place and topic words, not personal data.' };
  const kept: string[] = [];
  let droppedPersonalLines = 0;
  for (const line of catalogue.split('\n')) {
    if (personalDataIn(line).length) droppedPersonalLines++;
    else kept.push(line);
  }
  const cleanCatalogue = kept.join('\n');
  if (!cleanCatalogue.trim()) return { error: 'Paste your catalogue (one title per line).' };
  const slots: Record<string, number> = {};
  for (const d of ['movie', 'tv_show', 'podcast', 'artist']) {
    const n = Number(raw?.slots?.[d]);
    if (Number.isFinite(n)) slots[d] = Math.max(0, Math.min(12, Math.floor(n)));
  }
  const confirmations: Record<string, string> = {};
  if (raw?.confirmations && typeof raw.confirmations === 'object') {
    for (const [k, v] of Object.entries(raw.confirmations).slice(0, 4)) confirmations[str(k, 80)] = str(v, 120);
  }
  return {
    req: {
      origin,
      destination,
      catalogue: cleanCatalogue,
      ...(droppedPersonalLines ? { droppedPersonalLines } : {}),
      originShare: Number.isFinite(Number(raw?.originShare)) ? Number(raw.originShare) : 0.5,
      familySafeOnly: raw?.familySafeOnly === true,
      ...(Number.isFinite(Number(raw?.recencyYear)) && raw?.recencyYear ? { recencyYear: Math.max(1900, Math.min(2100, Math.floor(Number(raw.recencyYear)))) } : {}),
      slots,
      confirmations,
      autoConfirm: raw?.autoConfirm === true,
      compare: raw?.compare !== false,
      ...(str(raw?.theme, 40).trim() ? { theme: str(raw?.theme, 40).trim() } : {}),
    },
  };
}

function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SECURITY_HEADERS, ...extra },
  });
}

function asset(body: string, type: string, priv = false): Response {
  return new Response(body, { headers: { 'content-type': type, 'cache-control': priv ? 'private, no-store' : 'public, max-age=300', ...SECURITY_HEADERS } });
}
