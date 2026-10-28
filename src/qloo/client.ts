/**
 * The one server-side entry point for Qloo access.
 *
 *   createQlooClient(env, opts) -> { client, mode, counter, trace, ... }
 *
 * Modes: MOCK (default; deterministic synthetic fixtures, labelled MOCK everywhere), LIVE (only when
 * QLOO_API_KEY is in the server environment and FORCE_SYNTHETIC is not 1), DRY-RUN (real request
 * building, validation and sanitising, but nothing is sent; returns empty data and a plan).
 * The key is read here and handed straight to HttpQlooClient. It is never stored on the returned
 * object, logged or returned.
 *
 * Error taxonomy (QlooError.kind): auth(401) forbidden_type(403) not_found(404) bad_request(4xx)
 * rate_limited(429) server(5xx) timeout network malformed(bad JSON/shape) budget invalid_request
 * (blocked by the outbound sanitiser before sending).
 * Retries: 429, 5xx, timeout and network only, bounded (default 2) with backoff and Retry-After.
 */
import { HttpQlooClient } from './http-client.ts';
import { FixtureQlooClient } from './fixture-client.ts';
import type { ResponseCache } from './cache.ts';
import {
  type DestinationsRequest, type Domain, type InsightsRequest, type QlooClient, type QlooDemographicsBlock, type QlooEntity,
  QlooError, type QlooMode, type QlooResult, type QlooTag, type QlooTrendingPoint, type TagSearchRequest, type TasteAnalysisRequest, type TrendingRequest,
} from './types.ts';

export interface QlooEnv {
  QLOO_API_KEY?: string;
  FORCE_SYNTHETIC?: string;
}
/** One place for every budget default (client, worker, wrangler.toml, .dev.vars.example, UI fallback). */
export const DEFAULT_RUN_BUDGET = 70; // custom runs: swap test off, catalogue capped (call budget: see README)
export const DEFAULT_EXAMPLE_BUDGET = 130; // recorded examples (may include the swap test)
export const DEFAULT_CALL_BUDGET = DEFAULT_RUN_BUDGET;

export const MODE_LABEL: Record<QlooMode, string> = {
  MOCK: 'MOCK DATA: synthetic fixture, not a Qloo result',
  LIVE: 'LIVE: Qloo hackathon API (hackathon.api.qloo.com)',
  'DRY-RUN': 'DRY RUN: nothing was sent to Qloo, no data',
};

/** LIVE only if a key is present in the server environment. Default is MOCK. */
export function resolveMode(env: QlooEnv): 'MOCK' | 'LIVE' {
  return env.QLOO_API_KEY && env.FORCE_SYNTHETIC !== '1' ? 'LIVE' : 'MOCK';
}

export class CallCounter {
  used = 0;
  cacheHits = 0;
  readonly budget: number;
  constructor(budget: number) { this.budget = budget; }
  get remaining(): number { return Math.max(0, this.budget - this.used); }
  /** Visible counter line, e.g. "Qloo calls: 12/70 (3 served from cache) [LIVE]". */
  line(mode: QlooMode): string { return `Qloo calls: ${this.used}/${this.budget} (${this.cacheHits} served from cache) [${mode}]`; }
}

export interface TraceEntry {
  n: number;
  call: string;
  path: string;
  /** Request parameters as sent (never contains the key; it travels in a header). */
  params: Record<string, string>;
  mode: QlooMode;
  cached: boolean;
  ms: number;
  count: number;
  top: { id?: string; name?: string }[];
  error?: { kind: string; status: number };
  unavailable?: string;
}

export type EndpointStatus = 'available' | 'unavailable' | 'error' | 'unknown';
/**
 * Per-run memo: an identical request (method + normalised arguments) is answered from memory, costs
 * no budget and is reported cached=true. Only successful results are kept. In-flight duplicates share
 * one call. Covers the swap test's repeated title searches and kept-end reads, planner re-reads, tags.
 */
export class MemoQlooClient implements QlooClient {
  readonly inner: QlooClient;
  readonly #memo = new Map<string, Promise<QlooResult<unknown[]>>>();
  constructor(inner: QlooClient) { this.inner = inner; }
  get source(): QlooClient['source'] { return this.inner.source; }
  #key(name: string, args: unknown): string {
    return name + ':' + JSON.stringify(args, (_k, v) => (typeof v === 'string' ? v.trim().toLowerCase() : v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v));
  }
  async #do<T>(name: string, args: unknown, fn: () => Promise<QlooResult<T[]>>): Promise<QlooResult<T[]>> {
    const key = this.#key(name, args);
    const hit = this.#memo.get(key);
    if (hit) {
      const r = (await hit) as QlooResult<T[]>;
      return { ...r, cached: true, ms: 0 };
    }
    const p = fn();
    this.#memo.set(key, p as Promise<QlooResult<unknown[]>>);
    try { return await p; } catch (e) { this.#memo.delete(key); throw e; }
  }
  searchLocality(q: string) { return this.#do('searchLocality', q, () => this.inner.searchLocality(q)); }
  searchTitle(q: string, d: Domain) { return this.#do('searchTitle', [q, d], () => this.inner.searchTitle(q, d)); }
  insights(req: InsightsRequest) { return this.#do('insights', req, () => this.inner.insights(req)); }
  tasteAnalysis(req: TasteAnalysisRequest) { return this.#do('tasteAnalysis', req, () => this.inner.tasteAnalysis(req)); }
  demographics(ids: string[]) { return this.#do('demographics', ids, () => this.inner.demographics(ids)); }
  trending(req: TrendingRequest) { return this.#do('trending', req, () => this.inner.trending(req)); }
  destinations(req: DestinationsRequest) { return this.#do('destinations', req, () => this.inner.destinations(req)); }
  searchTags(req: TagSearchRequest) { return this.#do('searchTags', req, () => this.inner.searchTags(req)); }
}

const OPTIONAL = new Set(['trending', 'demographics']);


/** Wraps a client: stamps mode/label, records a trace, degrades optional endpoints gracefully. */
export class GuardedQlooClient implements QlooClient {
  readonly trace: TraceEntry[] = [];
  readonly endpointStatus: Record<string, EndpointStatus> = {};
  readonly inner: QlooClient;
  readonly mode: QlooMode;
  readonly counter: CallCounter;
  constructor(inner: QlooClient, mode: QlooMode, counter: CallCounter) {
    this.inner = inner;
    this.mode = mode;
    this.counter = counter;
  }
  get source(): QlooClient['source'] { return this.inner.source; }

  async #run<T>(name: string, fn: (c: QlooClient) => Promise<QlooResult<T[]>>): Promise<QlooResult<T[]>> {
    const optional = OPTIONAL.has(name);
    if (optional && this.endpointStatus[name] === 'unavailable') return this.#unavailable(name);
    try {
      const r = await fn(this.inner);
      if (r.cached) this.counter.cacheHits++;
      if (optional) this.endpointStatus[name] = 'available';
      this.#record(name, r);
      return { ...r, mode: this.mode, label: MODE_LABEL[this.mode] };
    } catch (e) {
      if (e instanceof QlooError) {
        this.trace.push({ n: this.trace.length + 1, call: name, path: name, params: {}, mode: this.mode, cached: false, ms: 0, count: 0, top: [], error: { kind: e.kind, status: e.status } });
        if (optional && (e.kind === 'forbidden_type' || e.kind === 'not_found')) {
          this.endpointStatus[name] = 'unavailable';
          return this.#unavailable(name);
        }
        if (this.endpointStatus[name] !== 'unavailable') this.endpointStatus[name] = 'error';
      }
      throw e;
    }
  }

  #unavailable<T>(name: string): QlooResult<T[]> {
    this.trace.push({ n: this.trace.length + 1, call: name, path: name, params: {}, mode: this.mode, cached: false, ms: 0, count: 0, top: [], unavailable: 'endpoint-not-available-on-host' });
    return {
      data: [], request: { path: name, params: {} }, source: this.inner.source, cached: false, ms: 0, mode: this.mode,
      label: `${MODE_LABEL[this.mode]}; ${name} is not available on this host, no data`,
      unavailable: { reason: 'endpoint-not-available-on-host', endpoint: name, fallback: 'none' },
    };
  }

  #record(name: string, r: QlooResult<unknown[]>): void {
    const items = r.data as { entity_id?: string; tag_id?: string; id?: string; name?: string }[];
    this.trace.push({
      n: this.trace.length + 1, call: name, path: r.request.path, params: r.request.params, mode: this.mode, cached: r.cached, ms: r.ms, count: items.length,
      top: items.slice(0, 5).map((x) => ({ id: x.entity_id ?? x.tag_id ?? x.id, name: x.name })),
    });
  }

  searchLocality(q: string) { return this.#run('searchLocality', (c) => c.searchLocality(q)); }
  searchTitle(q: string, d: Domain) { return this.#run('searchTitle', (c) => c.searchTitle(q, d)); }
  insights(req: InsightsRequest) { return this.#run('insights', (c) => c.insights(req)); }
  tasteAnalysis(req: TasteAnalysisRequest) { return this.#run('tasteAnalysis', (c) => c.tasteAnalysis(req)); }
  demographics(ids: string[]) { return this.#run<QlooDemographicsBlock>('demographics', (c) => c.demographics(ids)); }
  trending(req: TrendingRequest) { return this.#run<QlooTrendingPoint>('trending', (c) => c.trending(req)); }
  destinations(req: DestinationsRequest) { return this.#run<QlooEntity>('destinations', (c) => c.destinations(req)); }
  searchTags(req: TagSearchRequest) { return this.#run<QlooTag>('searchTags', (c) => c.searchTags(req)); }
}

export interface CreateOptions {
  /** Polled before every network attempt; true aborts the run (client disconnected). */
  shouldStop?: () => boolean;
  /** Max network calls for this run (cache hits are free). Default 70. */
  budget?: number;
  dryRun?: boolean;
  cache?: ResponseCache;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Force a mode (tests). LIVE still needs a key. */
  forceMode?: 'MOCK';
}

export interface QlooHandle {
  client: GuardedQlooClient;
  mode: QlooMode;
  label: string;
  counter: CallCounter;
  /** DRY-RUN only: the requests that would have been sent. */
  plan: { path: string; params: Record<string, string> }[];
}

export function createQlooClient(env: QlooEnv, opts: CreateOptions = {}): QlooHandle {
  const counter = new CallCounter(opts.budget ?? DEFAULT_CALL_BUDGET);
  const plan: QlooHandle['plan'] = [];
  const onNetworkCall = (path: string) => {
    if (opts.shouldStop?.()) throw new QlooError('The visitor disconnected; the run was stopped.', 0, 'budget');
    if (counter.used >= counter.budget) throw new QlooError(`This run hit its budget of ${counter.budget} Qloo calls (${path}).`, 0, 'budget');
    counter.used++;
  };
  const mode: QlooMode = opts.dryRun ? 'DRY-RUN' : opts.forceMode === 'MOCK' ? 'MOCK' : resolveMode(env);
  let inner: QlooClient;
  if (mode === 'MOCK') inner = new FixtureQlooClient({ onNetworkCall });
  else if (mode === 'DRY-RUN') {
    const recorder = (async (url: string | URL | Request) => {
      const u = new URL(String(url));
      plan.push({ path: u.pathname, params: Object.fromEntries(u.searchParams) });
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    // The placeholder is not a credential; the recorder never sends anything.
    inner = new HttpQlooClient({ apiKey: 'dry-run-placeholder', fetchImpl: recorder, onNetworkCall, maxRetries: 0 });
  } else {
    inner = new HttpQlooClient({ apiKey: env.QLOO_API_KEY!, cache: opts.cache, onNetworkCall, fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs, maxRetries: opts.maxRetries, sleep: opts.sleep });
  }
  const client = new GuardedQlooClient(new MemoQlooClient(inner), mode, counter);
  return { client, mode, label: MODE_LABEL[mode], counter, plan };
}

/** Which endpoints exist on this host. Uses the unguarded inner client, so a 403/404 is recorded, not hidden. */
export async function probeEndpoints(client: QlooClient): Promise<Record<string, { status: EndpointStatus; kind?: string }>> {
  const g = client instanceof GuardedQlooClient ? client.inner : client;
  const raw = g instanceof MemoQlooClient ? g.inner : g;
  const out: Record<string, { status: EndpointStatus; kind?: string }> = {};
  const probes: [string, () => Promise<unknown>][] = [
    ['/search', () => raw.searchLocality('Orlando')],
    ['/v2/insights', () => raw.insights({ domain: 'movie', location: { query: 'Orlando' }, take: 1 })],
    ['/v2/tags', () => raw.searchTags({ query: 'holiday', take: 1 })],
    ['/v2/trending', () => raw.trending({ domain: 'movie', entityId: 'PROBE', startDate: '2026-09-01', endDate: '2026-10-01' })],
    ['/v2/insights?filter.type=urn:demographics', () => raw.demographics(['PROBE'])],
  ];
  for (const [name, fn] of probes) {
    try {
      await fn();
      out[name] = { status: 'available' };
    } catch (e) {
      const kind = e instanceof QlooError ? e.kind : 'unknown';
      out[name] = { status: kind === 'forbidden_type' || kind === 'not_found' ? 'unavailable' : 'error', kind };
    }
  }
  return out;
}
