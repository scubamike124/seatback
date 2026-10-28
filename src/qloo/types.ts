/**
 * Qloo client interface and the response shapes Seatback reads.
 *
 * Only fields Seatback uses are typed, and all are optional: the docs say the API returns the
 * full response and example payloads omit fields, so parsers never assume a field exists.
 *
 * Sources (all read 2026-10-24):
 * - Hackathon developer guide:  https://docs.qloo.com/reference/qloo-llm-hackathon-developer-guide
 * - Insights deep dive:         https://docs.qloo.com/reference/insights-api-deep-dive
 * - Location-based insights:    https://docs.qloo.com/reference/insights-with-location-use-case
 * - Parameter reference:        https://docs.qloo.com/reference/parameters
 * - Entity type parameter guide https://docs.qloo.com/reference/available-parameters-by-entity-type
 * - Entity search:              https://docs.qloo.com/reference/get-search
 * - Taste analysis:             https://docs.qloo.com/reference/taste-analysis
 * - Demographics:               https://docs.qloo.com/reference/demographics-use-case
 * - Trending:                   https://docs.qloo.com/reference/get-trending
 * - Analysis compare:           https://docs.qloo.com/reference/analysis-compare
 * - Tag search (/v2/tags):      https://docs.qloo.com/reference/search-tags
 * - Heatmaps:                   https://docs.qloo.com/reference/heatmaps-use-case
 */

/** The content domains an IFE slate covers, mapped to Insights `filter.type` values. */
export type Domain = 'movie' | 'tv_show' | 'podcast' | 'artist';

export const DOMAIN_TYPE: Record<Domain, string> = {
  movie: 'urn:entity:movie',
  tv_show: 'urn:entity:tv_show',
  podcast: 'urn:entity:podcast',
  artist: 'urn:entity:artist',
};

export const DOMAIN_LABEL: Record<Domain, string> = {
  movie: 'Films',
  tv_show: 'TV',
  podcast: 'Podcasts',
  artist: 'Music',
};

export interface QlooTagRef {
  id?: string;
  tag_id?: string;
  name?: string;
  type?: string;
  value?: string;
}

export interface QlooEntity {
  entity_id?: string;
  name?: string;
  type?: string;
  subtype?: string;
  types?: string[];
  disambiguation?: string;
  popularity?: number;
  properties?: {
    release_year?: number;
    content_rating?: string;
    description?: string;
    /** Destination and Place entities: documented filters `filter.geocode.*` match these fields. */
    geocode?: { name?: string; country_code?: string; admin1_region?: string; admin2_region?: string };
    [k: string]: unknown;
  };
  tags?: QlooTagRef[];
  /** Insights results carry scores here (e.g. `query.affinity`). */
  query?: { affinity?: number; [k: string]: unknown };
}

/** A tag returned by taste analysis (`filter.type=urn:tag`). */
export interface QlooTag {
  tag_id?: string;
  id?: string;
  name?: string;
  subtype?: string;
  types?: string[];
  tag_value?: string;
  /** The taste-analysis doc example shows `query: {}`; when an affinity is present we use it. */
  query?: { affinity?: number; [k: string]: unknown };
}

/** One block of `/v2/insights?filter.type=urn:demographics`: relative affinities, + or -. */
export interface QlooDemographicsBlock {
  entity_id?: string;
  query?: {
    age?: Partial<Record<AgeBand, number>>;
    gender?: Partial<Record<'male' | 'female', number>>;
  };
}

export interface QlooTrendingPoint {
  date?: string;
  population_percentile?: number;
  population_rank?: number;
  population_rank_velocity?: number;
  velocity_fold_change?: number;
  population_percent_delta?: number;
}

/** Documented age bands (parameter reference, `signal.demographics.age`). */
export const AGE_BANDS = ['24_and_younger', '25_to_29', '30_to_34', '35_to_44', '45_to_54', '55_and_older'] as const;
export type AgeBand = (typeof AGE_BANDS)[number];

/** A location signal: a resolved locality ID (preferred) or the documented fuzzy query fallback. */
export type LocationSignal = { localityId: string } | { query: string };

/**
 * One `/v2/insights` request for a content domain. The three market-reading modes Seatback
 * supports are all expressed with this one shape:
 * - open:     `location` only. "What does this city favour?" (documented location use case)
 * - pinned:   `location` + `onlyEntityIds`. Documented, but another entrant reports that the
 *             location then acts as a hard filter (pinned titles collapse); see docs/QLOO-NOTES.md.
 * - anchored: `anchorEntityIds` (Qloo's own top local artists/shows for the city) + `onlyEntityIds`.
 */
export interface InsightsRequest {
  domain: Domain;
  location?: LocationSignal;
  /** `signal.interests.entities` */
  anchorEntityIds?: string[];
  /** `filter.results.entities`: scores the programmer's own catalogue. */
  onlyEntityIds?: string[];
  /** `filter.exclude.entities` */
  excludeEntityIds?: string[];
  /** `filter.tags` (Movie / TV Show / Podcast / Artist all list it): real Qloo tag IDs only. */
  tagIds?: string[];
  releaseYearMin?: number;
  /** Movie / TV only. Comma-separated documented ratings, e.g. "G,PG,PG-13" (US MPAA / TV Parental Guidelines). */
  contentRating?: string;
  take?: number;
}

export interface TasteAnalysisRequest {
  location: LocationSignal;
  parentTypes?: string[];
  take?: number;
}

export interface TrendingRequest {
  domain: Domain;
  entityId: string;
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
}

/**
 * `/v2/insights?filter.type=urn:entity:destination`: which destinations the audience behind a
 * set of entities favours. Destination is on the hackathon key's supported type list, and the
 * Entity Type Parameter Guide lists `signal.interests.entities` (required) and
 * `filter.geocode.country_code` for it.
 */
export interface DestinationsRequest {
  seedEntityIds: string[];
  countryCode?: string;
  take?: number;
}

/** `/v2/tags`: tag discovery by name (documented `filter.query`, `filter.parents.types`). */
export interface TagSearchRequest {
  query: string;
  parentTypes?: string[];
  take?: number;
}

/** One cell of `results.heatmap` (heatmaps use case). Used by the probe only. */
export interface QlooHeatmapCell {
  location?: { latitude?: number; longitude?: number; geohash?: string };
  query?: { affinity?: number; affinity_rank?: number; popularity?: number };
}

/** Every client call returns the parsed payload plus provenance for the evidence ledger. */
export interface QlooResult<T> {
  data: T;
  /** Path plus the exact query parameters sent. Never contains the API key. */
  request: { path: string; params: Record<string, string> };
  source: 'qloo-live' | 'synthetic-fixture';
  cached: boolean;
  ms: number;
  /** Set by the guarded client (client.ts). MOCK data can never be mistaken for LIVE. */
  mode?: QlooMode;
  label?: string;
  /** Present when the host does not offer this endpoint (see GuardedQlooClient). */
  unavailable?: { reason: 'endpoint-not-available-on-host'; endpoint: string; fallback: 'none' };
}

export type QlooMode = 'MOCK' | 'LIVE' | 'DRY-RUN';

/**
 * What the agent depends on. `HttpQlooClient` talks to the live hackathon API;
 * `FixtureQlooClient` returns clearly synthetic data so the app runs before a key exists.
 */
export interface QlooClient {
  readonly source: 'qloo-live' | 'synthetic-fixture';
  /** `/search` with `types=urn:entity:locality`, to turn "Orlando" into a locality ID. */
  searchLocality(query: string): Promise<QlooResult<QlooEntity[]>>;
  /** `/search` for a catalogue title within one domain. */
  searchTitle(query: string, domain: Domain): Promise<QlooResult<QlooEntity[]>>;
  /** `/v2/insights` for one content domain (open, pinned or anchored read). */
  insights(req: InsightsRequest): Promise<QlooResult<QlooEntity[]>>;
  /** `/v2/insights?filter.type=urn:tag` conditioned on a location. */
  tasteAnalysis(req: TasteAnalysisRequest): Promise<QlooResult<QlooTag[]>>;
  /** `/v2/insights?filter.type=urn:demographics` for a set of entities. */
  demographics(entityIds: string[]): Promise<QlooResult<QlooDemographicsBlock[]>>;
  /** `/v2/trending` for one entity. */
  trending(req: TrendingRequest): Promise<QlooResult<QlooTrendingPoint[]>>;
  /** `/v2/insights?filter.type=urn:entity:destination` seeded with entities (cross-domain). */
  destinations(req: DestinationsRequest): Promise<QlooResult<QlooEntity[]>>;
  /** `/v2/tags` search: resolve a programming theme ("holiday") to real Qloo tag IDs. */
  searchTags(req: TagSearchRequest): Promise<QlooResult<QlooTag[]>>;
}

export class QlooError extends Error {
  readonly status: number;
  readonly kind: 'auth' | 'forbidden_type' | 'rate_limited' | 'bad_request' | 'not_found' | 'server' | 'network' | 'budget' | 'timeout' | 'malformed' | 'invalid_request';
  constructor(message: string, status: number, kind: QlooError['kind']) {
    super(message);
    this.name = 'QlooError';
    this.status = status;
    this.kind = kind;
  }
}

export function tagIdOf(t: QlooTag | QlooTagRef): string | undefined {
  const anyT = t as QlooTag & QlooTagRef;
  return anyT.tag_id ?? anyT.id ?? anyT.tag_value ?? anyT.value;
}
