/**
 * Live Qloo client, written strictly against the hackathon developer guide:
 * https://docs.qloo.com/reference/qloo-llm-hackathon-developer-guide
 *
 * - Base URL: hackathon keys work ONLY at https://hackathon.api.qloo.com (not staging, not prod).
 * - Auth: the key goes in the `X-Api-Key` header, never in the query string or as a Bearer token.
 * - `/v2/insights` is a GET with parameters in the query string (no JSON body).
 * - `/recommendations` and `/recs` are legacy and unsupported; this client never calls them.
 * - 403 "You do not have permission to access urn:entity:..." means an unsupported type.
 * - 200 with an empty list usually means an ignored parameter; params.ts allowlists prevent it.
 *
 * Caching: "Private server-side caching is fine and there is no time limit ... Do not store Qloo
 * response data in a public repository." (developer guide FAQ). The cache passed in here is
 * server-side only (Workers Cache API or memory) and is never written to the repo.
 */
import {
  type DestinationsRequest,
  type Domain,
  DOMAIN_TYPE,
  type InsightsRequest,
  type LocationSignal,
  type QlooClient,
  type QlooDemographicsBlock,
  type QlooEntity,
  QlooError,
  type QlooHeatmapCell,
  type QlooResult,
  type QlooTag,
  type QlooTrendingPoint,
  type TagSearchRequest,
  type TasteAnalysisRequest,
  type TrendingRequest,
} from './types.ts';
import {
  DEMOGRAPHICS_PARAMS,
  DESTINATION_PARAMS,
  HEATMAP_PARAMS,
  TAG_SEARCH_PARAMS,
  LOCATED_INSIGHTS_PARAMS,
  MAX_SEARCH_TAKE,
  SEARCH_PARAMS,
  SEARCH_TYPES,
  TASTE_ANALYSIS_PARAMS,
  TRENDING_PARAMS,
  assertAllowed,
  clampTake,
  isIsoDate,
  isSafeId,
} from './params.ts';
import type { ResponseCache } from './cache.ts';
import { sanitizeOutbound } from './outbound.ts';
import { validateEnvelope } from './schema.ts';

export const HACKATHON_BASE_URL = 'https://hackathon.api.qloo.com';

export interface HttpClientOptions {
  apiKey: string;
  cache?: ResponseCache;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Bounded retries for 429 / 5xx / network errors (kit: "make retry behavior bounded"). */
  maxRetries?: number;
  /** Called before each network call; throw to enforce a per-brief or daily budget. */
  onNetworkCall?: (path: string) => void;
  sleep?: (ms: number) => Promise<void>;
  /** Most network calls in flight at once from this client (default 6). Others queue. */
  maxConcurrent?: number;
  now?: () => number;
}

/**
 * Shared across clients in one isolate: when Qloo answers 429, every client waits out the same
 * cooldown instead of each one hammering the API with its own retries.
 */
const cooldown = { until: 0 };
export function resetQlooCooldown(): void {
  cooldown.until = 0;
}

export class HttpQlooClient implements QlooClient {
  readonly source = 'qloo-live' as const;
  readonly #key: string;
  readonly #cache?: ResponseCache;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #maxRetries: number;
  readonly #onNetworkCall?: (path: string) => void;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;
  readonly #maxConcurrent: number;
  #active = 0;
  readonly #queue: (() => void)[] = [];
  /** Identical requests already in flight share one network call (request coalescing). */
  readonly #inflight = new Map<string, Promise<unknown>>();
  /** Network calls actually made (after cache and coalescing). Exposed for tests and metrics. */
  networkCalls = 0;

  constructor(opts: HttpClientOptions) {
    if (!opts.apiKey) throw new Error('HttpQlooClient needs an API key; use FixtureQlooClient without one');
    this.#key = opts.apiKey;
    this.#cache = opts.cache;
    this.#fetch = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
    this.#timeoutMs = opts.timeoutMs ?? 12_000;
    this.#maxRetries = opts.maxRetries ?? 2;
    this.#onNetworkCall = opts.onNetworkCall;
    this.#sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.#now = opts.now ?? Date.now;
    this.#maxConcurrent = Math.max(1, opts.maxConcurrent ?? 6);
  }

  /** https://docs.qloo.com/reference/get-search (types includes urn:entity:locality) */
  async searchLocality(query: string): Promise<QlooResult<QlooEntity[]>> {
    const params = { query: query.slice(0, 120), types: SEARCH_TYPES.locality, take: clampTake(5, 5, MAX_SEARCH_TAKE) };
    assertAllowed('/search', params, SEARCH_PARAMS);
    return this.#get('/search', params, (j) => asArray<QlooEntity>(j?.results));
  }

  /** https://docs.qloo.com/reference/get-search */
  async searchTitle(query: string, domain: Domain): Promise<QlooResult<QlooEntity[]>> {
    const params = { query: query.slice(0, 160), types: SEARCH_TYPES[domain], take: clampTake(3, 3, MAX_SEARCH_TAKE) };
    assertAllowed('/search', params, SEARCH_PARAMS);
    return this.#get('/search', params, (j) => asArray<QlooEntity>(j?.results));
  }

  /**
   * https://docs.qloo.com/reference/insights-api-deep-dive
   * https://docs.qloo.com/reference/insights-with-location-use-case (location signal)
   * https://docs.qloo.com/reference/available-parameters-by-entity-type (Movie, TV Show, Podcast, Artist)
   */
  async insights(req: InsightsRequest): Promise<QlooResult<QlooEntity[]>> {
    const params: Record<string, string> = { 'filter.type': DOMAIN_TYPE[req.domain] };
    if (req.location) Object.assign(params, locationParams(req.location));
    if (req.anchorEntityIds?.length) params['signal.interests.entities'] = ids(req.anchorEntityIds);
    if (req.onlyEntityIds?.length) params['filter.results.entities'] = ids(req.onlyEntityIds);
    if (req.excludeEntityIds?.length) params['filter.exclude.entities'] = ids(req.excludeEntityIds);
    if (req.releaseYearMin && (req.domain === 'movie' || req.domain === 'tv_show')) {
      params['filter.release_year.min'] = String(Math.floor(req.releaseYearMin));
    }
    if (req.contentRating && (req.domain === 'movie' || req.domain === 'tv_show')) {
      params['filter.content_rating'] = req.contentRating;
    }
    if (req.tagIds?.length) params['filter.tags'] = ids(req.tagIds);
    if (Object.keys(params).length === 1) throw new Error('insights needs at least one signal or filter');
    params.take = clampTake(req.take, 20);
    assertAllowed(`/v2/insights (${req.domain})`, params, LOCATED_INSIGHTS_PARAMS[req.domain]);
    return this.#get('/v2/insights', params, (j) => asArray<QlooEntity>(j?.results?.entities));
  }

  /** https://docs.qloo.com/reference/taste-analysis */
  async tasteAnalysis(req: TasteAnalysisRequest): Promise<QlooResult<QlooTag[]>> {
    const params: Record<string, string> = { 'filter.type': 'urn:tag', ...locationParams(req.location) };
    if (req.parentTypes?.length) params['filter.parents.types'] = req.parentTypes.join(',');
    params.take = clampTake(req.take, 25);
    assertAllowed('/v2/insights (urn:tag)', params, TASTE_ANALYSIS_PARAMS);
    return this.#get('/v2/insights', params, (j) => asArray<QlooTag>(j?.results?.tags));
  }

  /** https://docs.qloo.com/reference/demographics-use-case */
  async demographics(entityIds: string[]): Promise<QlooResult<QlooDemographicsBlock[]>> {
    const params = { 'filter.type': 'urn:demographics', 'signal.interests.entities': ids(entityIds) };
    assertAllowed('/v2/insights (urn:demographics)', params, DEMOGRAPHICS_PARAMS);
    return this.#get('/v2/insights', params, (j) => asArray<QlooDemographicsBlock>(j?.results?.demographics));
  }

  /** https://docs.qloo.com/reference/get-trending (filter.start_date / filter.end_date required) */
  async trending(req: TrendingRequest): Promise<QlooResult<QlooTrendingPoint[]>> {
    if (!isIsoDate(req.startDate) || !isIsoDate(req.endDate)) throw new Error('trending dates must be YYYY-MM-DD');
    const params = {
      'signal.interests.entities': ids([req.entityId]),
      'filter.type': DOMAIN_TYPE[req.domain],
      'filter.start_date': req.startDate,
      'filter.end_date': req.endDate,
    };
    assertAllowed('/v2/trending', params, TRENDING_PARAMS);
    return this.#get('/v2/trending', params, (j) => asArray<QlooTrendingPoint>(j?.results?.trending));
  }

  /**
   * Cross-domain: which destinations the audience behind these entities favours.
   * https://docs.qloo.com/reference/available-parameters-by-entity-type (Destination)
   * https://docs.qloo.com/reference/parameters (`filter.geocode.country_code`: Destination, Place)
   */
  async destinations(req: DestinationsRequest): Promise<QlooResult<QlooEntity[]>> {
    const params: Record<string, string> = { 'filter.type': 'urn:entity:destination', 'signal.interests.entities': ids(req.seedEntityIds) };
    if (req.countryCode) {
      if (!/^[A-Z]{2}$/.test(req.countryCode)) throw new Error('country code must be two capital letters');
      params['filter.geocode.country_code'] = req.countryCode;
    }
    params.take = clampTake(req.take, 50);
    assertAllowed('/v2/insights (urn:entity:destination)', params, DESTINATION_PARAMS);
    return this.#get('/v2/insights', params, (j) => asArray<QlooEntity>(j?.results?.entities));
  }

  /** https://docs.qloo.com/reference/search-tags (response: `results.tags`) */
  async searchTags(req: TagSearchRequest): Promise<QlooResult<QlooTag[]>> {
    const params: Record<string, string> = { 'filter.query': req.query.trim().slice(0, 60) };
    if (!params['filter.query']) throw new Error('tag search needs a query');
    if (req.parentTypes?.length) params['filter.parents.types'] = req.parentTypes.join(',');
    params.take = clampTake(req.take, 10);
    assertAllowed('/v2/tags', params, TAG_SEARCH_PARAMS);
    return this.#get('/v2/tags', params, (j) => asArray<QlooTag>(j?.results?.tags));
  }

  /**
   * Heatmap (probe only: `urn:heatmap` is not on the hackathon key's supported type list).
   * https://docs.qloo.com/reference/heatmaps-use-case (response: `results.heatmap`)
   */
  async heatmap(req: { locationQuery: string; seedEntityIds?: string[]; tagIds?: string[]; take?: number }): Promise<QlooResult<QlooHeatmapCell[]>> {
    const params: Record<string, string> = { 'filter.type': 'urn:heatmap', 'filter.location.query': req.locationQuery.slice(0, 120) };
    if (req.seedEntityIds?.length) params['signal.interests.entities'] = ids(req.seedEntityIds);
    if (req.tagIds?.length) params['signal.interests.tags'] = ids(req.tagIds);
    if (Object.keys(params).length === 2) throw new Error('heatmap needs an entity or tag signal');
    params.take = clampTake(req.take, 50);
    assertAllowed('/v2/insights (urn:heatmap)', params, HEATMAP_PARAMS);
    return this.#get('/v2/insights', params, (j) => asArray<QlooHeatmapCell>(j?.results?.heatmap));
  }

  async #get<T>(path: string, params: Record<string, string>, pick: (json: any) => T): Promise<QlooResult<T>> {
    sanitizeOutbound(path, params);
    const qs = new URLSearchParams(Object.entries(params).sort(([a], [b]) => a.localeCompare(b))).toString();
    const url = `${HACKATHON_BASE_URL}${path}?${qs}`;
    const started = Date.now();

    const hit = await this.#cache?.get(url);
    if (hit !== undefined) {
      return { data: pick(hit), request: { path, params }, source: this.source, cached: true, ms: Date.now() - started };
    }

    // Coalesce: a second identical request waits for the first instead of spending a call.
    const pending = this.#inflight.get(url);
    if (pending) {
      const json = await pending;
      return { data: pick(json), request: { path, params }, source: this.source, cached: true, ms: Date.now() - started };
    }
    const p = this.#limited(() => this.#fetchJson(url, path));
    this.#inflight.set(url, p);
    try {
      const json = await p;
      return { data: pick(json), request: { path, params }, source: this.source, cached: false, ms: Date.now() - started };
    } finally {
      this.#inflight.delete(url);
    }
  }

  async #limited<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#active >= this.#maxConcurrent) await new Promise<void>((r) => this.#queue.push(r));
    this.#active++;
    try {
      return await fn();
    } finally {
      this.#active--;
      this.#queue.shift()?.();
    }
  }

  async #fetchJson(url: string, path: string): Promise<unknown> {
    const out = await this.#fetchAttempts(url, path);
    try {
      await this.#cache?.put(url, out.json);
    } catch {
      // swallow: the data is good, only the cache write failed
    }
    return out.json;
  }

  async #fetchAttempts(url: string, path: string): Promise<{ json: unknown }> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.#maxRetries; attempt++) {
      try {
        const wait = cooldown.until - this.#now();
        if (wait > 0) await this.#sleep(Math.min(wait, 5000));
        // Charged per HTTP attempt: a retry is a real request and spends quota (throws a budget QlooError).
        this.#onNetworkCall?.(path);
        this.networkCalls++;
        const res = await this.#fetch(url, {
          method: 'GET',
          headers: { 'X-Api-Key': this.#key, Accept: 'application/json' },
          redirect: 'manual', signal: AbortSignal.timeout(this.#timeoutMs),
        });
        if (res.ok) {
          let json: unknown;
          try {
            json = JSON.parse(await res.text());
          } catch {
            throw new QlooError(`Qloo ${path} returned a body that is not valid JSON.`, res.status, 'malformed');
          }
          validateEnvelope(path, json);
          // Outside the retry logic: a failing cache write (e.g. KV daily write limit) must not trigger more fetches.
          return { json };
        }
        const err = classify(res.status, path);
        if (err.kind === 'rate_limited') cooldown.until = this.#now() + backoffMs(attempt, res.headers.get('retry-after'));
        // Retry only what can succeed on retry. 401/403/400/404 never will.
        if ((err.kind === 'rate_limited' || err.kind === 'server') && attempt < this.#maxRetries) {
          lastErr = err;
          await this.#sleep(backoffMs(attempt, res.headers.get('retry-after')));
          continue;
        }
        throw err;
      } catch (e) {
        if (e instanceof QlooError) throw e;
        const timedOut = (e as { name?: string } | null)?.name === 'TimeoutError' || (e as { name?: string } | null)?.name === 'AbortError';
        lastErr = timedOut ? new QlooError(`Qloo ${path} timed out after ${this.#timeoutMs} ms.`, 0, 'timeout') : new QlooError(`Network error calling Qloo ${path}`, 0, 'network');
        if (attempt < this.#maxRetries) {
          await this.#sleep(backoffMs(attempt, null));
          continue;
        }
      }
    }
    throw lastErr instanceof QlooError ? lastErr : new QlooError(`Qloo ${path} failed`, 0, 'network');
  }
}

function locationParams(loc: LocationSignal): Record<string, string> {
  if ('localityId' in loc) {
    if (!isSafeId(loc.localityId)) throw new Error('unsafe locality id');
    return { 'signal.location': loc.localityId };
  }
  return { 'signal.location.query': loc.query.slice(0, 120) };
}

function ids(list: string[]): string {
  const clean = list.filter(isSafeId).slice(0, 50);
  if (clean.length === 0) throw new Error('no valid entity ids');
  return clean.join(',');
}

function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

function classify(status: number, path: string): QlooError {
  // Messages never include the key or the full URL.
  // A 3xx is never followed (redirect: 'manual' on the request): following one could send the key to another host. No Location value is kept.
  if (status >= 300 && status < 400) return new QlooError(`Qloo answered ${path} with a redirect (HTTP ${status}); redirects are never followed.`, status, 'bad_request');
  if (status === 401) {
    return new QlooError(
      `Qloo rejected the key (401) on ${path}. Check that the key is the hackathon key and the base URL is hackathon.api.qloo.com.`,
      401,
      'auth',
    );
  }
  if (status === 403) return new QlooError(`Qloo returned 403 on ${path}: entity type not available to this key.`, 403, 'forbidden_type');
  if (status === 404) return new QlooError(`Qloo returned 404 on ${path}.`, 404, 'not_found');
  if (status === 429) return new QlooError(`Qloo rate limit reached on ${path}.`, 429, 'rate_limited');
  if (status >= 500) return new QlooError(`Qloo server error ${status} on ${path}.`, status, 'server');
  return new QlooError(`Qloo returned ${status} on ${path} (bad request; e.g. a locality query that matched nothing).`, status, 'bad_request');
}

/** Honours Retry-After (capped at 5 s); otherwise exponential backoff with +/-20% jitter. */
export function backoffMs(attempt: number, retryAfter: string | null, rand: () => number = Math.random): number {
  const ra = retryAfter ? Number(retryAfter) : NaN;
  if (Number.isFinite(ra) && ra >= 0) return Math.min(ra * 1000, 5000);
  const base = Math.min(400 * 2 ** attempt, 3000);
  return Math.round(base * (0.8 + 0.4 * rand()));
}
