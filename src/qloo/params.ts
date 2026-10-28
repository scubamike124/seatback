/**
 * Parameter allowlists copied from the official docs, so Seatback never sends a parameter
 * Qloo would silently ignore.
 *
 * Why: "invalid parameters are silently ignored rather than returning an error", and an
 * empty 200 is the usual symptom.
 * https://docs.qloo.com/reference/qloo-llm-hackathon-developer-guide (Empty Results)
 *
 * Every request built in http-client.ts passes through `assertAllowed`, so a typo fails a
 * unit test instead of quietly degrading the live demo.
 */
import type { Domain } from './types.ts';

/**
 * Location signals. The Entity Type Parameter Guide tables do not list any `signal.location*`
 * row for any type (not even Place), but two other official pages do document them for
 * Movie / TV Show / Podcast / Artist:
 * - Parameter reference, `signal.location` and `signal.location.query`: compatible with
 *   "Artist, Book, Brand, Destination, Movie, Person, Place, Podcast, TV Show, Video Game".
 *   https://docs.qloo.com/reference/parameters
 * - Location-based insights guide: worked example `filter.type=urn:entity:movie` +
 *   `signal.location.query=Lower East Side`.
 *   https://docs.qloo.com/reference/insights-with-location-use-case
 * scripts/live-probe.ts verifies this per domain on day one of the key.
 */
const LOCATION_SIGNALS = ['signal.location', 'signal.location.query'];

/** Rows from the Entity Type Parameter Guide that Seatback uses (all four domains list them). */
const COMMON = [
  'filter.type',
  'filter.tags',
  'filter.results.entities',
  'filter.exclude.entities',
  'signal.interests.entities',
  'take',
  'offset',
];

/**
 * https://docs.qloo.com/reference/available-parameters-by-entity-type
 * Movie and TV Show list `filter.content_rating` and `filter.release_year.min/max`;
 * Podcast and Artist list neither.
 */
export const LOCATED_INSIGHTS_PARAMS: Record<Domain, Set<string>> = {
  movie: new Set([...COMMON, ...LOCATION_SIGNALS, 'filter.content_rating', 'filter.release_year.min']),
  tv_show: new Set([...COMMON, ...LOCATION_SIGNALS, 'filter.content_rating', 'filter.release_year.min']),
  podcast: new Set([...COMMON, ...LOCATION_SIGNALS]),
  artist: new Set([...COMMON, ...LOCATION_SIGNALS]),
};

/**
 * `filter.type=urn:tag`. Union of the "Tag" table (filter.type, diversify.by, diversify.take,
 * offset, take) and the signals/filters the Taste Analysis guide accepts, which include
 * `signal.location` / `signal.location.query` and `filter.parents.types`.
 * https://docs.qloo.com/reference/available-parameters-by-entity-type (Tag)
 * https://docs.qloo.com/reference/taste-analysis
 */
export const TASTE_ANALYSIS_PARAMS = new Set([
  'filter.type',
  'diversify.by',
  'diversify.take',
  'offset',
  'take',
  'filter.parents.types',
  'filter.tag.types',
  ...LOCATION_SIGNALS,
]);

/**
 * Destination rows of the Entity Type Parameter Guide that Seatback uses.
 * https://docs.qloo.com/reference/available-parameters-by-entity-type (Destination)
 */
export const DESTINATION_PARAMS = new Set([
  'filter.type',
  'signal.interests.entities',
  'filter.geocode.country_code',
  'filter.exclude.entities',
  'take',
]);

/** https://docs.qloo.com/reference/search-tags */
export const TAG_SEARCH_PARAMS = new Set(['filter.query', 'filter.parents.types', 'take', 'page']);

/**
 * Heatmap rows of the Entity Type Parameter Guide. `urn:heatmap` is NOT on the hackathon
 * developer guide's supported `filter.type` list, so only scripts/live-probe.ts calls it.
 * https://docs.qloo.com/reference/available-parameters-by-entity-type (Heatmap)
 * https://docs.qloo.com/reference/heatmaps-use-case
 */
export const HEATMAP_PARAMS = new Set([
  'filter.type',
  'filter.location',
  'filter.location.query',
  'signal.interests.entities',
  'signal.interests.tags',
  'output.heatmap.boundary',
  'take',
]);

/** https://docs.qloo.com/reference/demographics-use-case */
export const DEMOGRAPHICS_PARAMS = new Set(['filter.type', 'signal.interests.entities', 'signal.interests.tags']);

/** https://docs.qloo.com/reference/get-search */
export const SEARCH_PARAMS = new Set(['query', 'types', 'take', 'page', 'sort_by']);

/** https://docs.qloo.com/reference/get-trending */
export const TRENDING_PARAMS = new Set([
  'signal.interests.entities',
  'filter.type',
  'filter.start_date',
  'filter.end_date',
  'take',
  'offset',
  'page',
]);

/** `take` is documented with a maximum of 50 on /v2/insights and /v2/trending. */
export const MAX_TAKE = 50;
/** `/search` documents `take` with `exclusiveMaximum: 200`. */
export const MAX_SEARCH_TAKE = 199;

/**
 * `/search` types. The developer guide spells Insights types like `urn:entity:tv_show`; the
 * `/search` OpenAPI enum uses the same spelling for the four domains Seatback uses, plus
 * `urn:entity:locality` ("legacy types available for search only").
 * https://docs.qloo.com/reference/get-search
 */
export const SEARCH_TYPES: Record<Domain | 'locality', string> = {
  movie: 'urn:entity:movie',
  tv_show: 'urn:entity:tv_show',
  podcast: 'urn:entity:podcast',
  artist: 'urn:entity:artist',
  locality: 'urn:entity:locality',
};

export function assertAllowed(endpoint: string, params: Record<string, string>, allowed: Set<string>): void {
  for (const key of Object.keys(params)) {
    if (!allowed.has(key)) {
      throw new Error(`Seatback bug: parameter "${key}" is not documented for ${endpoint}`);
    }
  }
}

export function clampTake(n: number | undefined, fallback: number, max = MAX_TAKE): string {
  return String(Math.max(1, Math.min(max, Math.floor(n ?? fallback))));
}

/** Strict YYYY-MM-DD for /v2/trending `filter.start_date` / `filter.end_date`. */
export function isIsoDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
}

/** Qloo IDs are UUID-like strings; refuse anything that could smuggle extra query syntax. */
export function isSafeId(s: string): boolean {
  return /^[A-Za-z0-9:_\-]{1,80}$/.test(s);
}
