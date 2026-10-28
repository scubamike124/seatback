/**
 * SYNTHETIC fixture client. Nothing here is a Qloo response, and nothing was derived from one.
 *
 * It exists so the full product runs, and is testable, before a hackathon key exists. Every
 * value is generated deterministically from hashes of the inputs over an invented genre space.
 * Every entity name it invents carries the "(synthetic)" suffix, every ID starts with "SYN-",
 * and every result is tagged `source: 'synthetic-fixture'`, which the UI shows as a banner and
 * a badge on every number.
 *
 * The response *shapes* mirror the documented examples (results.entities, results.tags,
 * results.demographics, results.trending) so the same parsing code runs in both modes.
 * Synthetic destinations reuse US city names only so the network map has somewhere to draw
 * them; their names carry "(synthetic)" and their scores mean nothing.
 */
import { DEFAULT_NETWORK } from '../agent/network.ts';

/** Invented places that are not on any airline network, so the "top destinations" list differs. */
const TAG_WORDS = ['Weekend', 'Reunion', 'Season', 'Story', 'Summer', 'Express'];

const SYN_EXTRA_DESTINATIONS = ['Lake Tamsin', 'Port Averill', 'Cedar Hollow', 'Mesa Lumen', 'Saltgrass Key', 'Bramble Falls'];
import {
  AGE_BANDS,
  type DestinationsRequest,
  type Domain,
  type InsightsRequest,
  type LocationSignal,
  type QlooClient,
  type QlooDemographicsBlock,
  type QlooEntity,
  QlooError,
  type QlooResult,
  type QlooTag,
  type QlooTrendingPoint,
  type TagSearchRequest,
  type TasteAnalysisRequest,
  type TrendingRequest,
} from './types.ts';

/** Invented genre space for the synthetic world. IDs are deliberately not Qloo tag IDs. */
export const SYN_GENRES = [
  { id: 'syn:genre:comedy', name: 'Comedy', words: ['laugh', 'comedy', 'funny', 'sitcom', 'goofy', 'wit'] },
  { id: 'syn:genre:family', name: 'Family & animation', words: ['family', 'kids', 'animated', 'cartoon', 'puppy', 'dragon'] },
  { id: 'syn:genre:docs', name: 'Documentary', words: ['documentary', 'true', 'story of', 'inside', 'making'] },
  { id: 'syn:genre:scifi', name: 'Sci-fi', words: ['star', 'space', 'robot', 'galaxy', 'future', 'orbit'] },
  { id: 'syn:genre:romance', name: 'Romance', words: ['love', 'heart', 'wedding', 'romance', 'kiss'] },
  { id: 'syn:genre:crime', name: 'Crime & mystery', words: ['murder', 'crime', 'detective', 'mystery', 'case', 'heist'] },
  { id: 'syn:genre:sports', name: 'Sports', words: ['game', 'team', 'season', 'league', 'cup', 'race'] },
  { id: 'syn:genre:travel', name: 'Travel & food', words: ['kitchen', 'food', 'travel', 'island', 'road', 'taste'] },
  { id: 'syn:genre:thriller', name: 'Action & thriller', words: ['fury', 'chase', 'mission', 'strike', 'edge'] },
  { id: 'syn:genre:music', name: 'Music', words: ['song', 'band', 'music', 'rhythm', 'concert', 'beat'] },
] as const;

const SYN_DISCOVERY_TITLES: Record<Domain, string[]> = {
  movie: ['Ember Coast', 'The Quiet Orchard', 'Signal Hill', 'Copperhead Summer', 'The Last Ferry Home', 'Lantern District', 'North of the River', 'Paper Kites', 'Glassblower', 'The Saltmarsh Case', 'Midnight Diner Run', 'Starboard'],
  tv_show: ['Front Porch Detectives', 'The Long Kitchen', 'Harbor Ward', 'Night Shift Radio', 'Prairie Lights', 'The Corner Bakery', 'Dockside', 'Field Station', 'Rookie Season', 'The Weather Desk', 'Little Lakes', 'Downstream'],
  podcast: ['Gate Change', 'The Stopover', 'Short Haul Science', 'Late Checkout', 'Carry-On Stories', 'Jet Lag Mysteries', 'Window Light', 'Overhead Bin', 'Tray Table Talk'],
  artist: ['The Juniper Line', 'Mara Quill', 'Night Harbor', 'Copper & Coal', 'Static Meadow', 'The Low Pines', 'Velvet Ferry', 'Granite Choir', 'Sunday Tram', 'Okra Bloom'],
};

export const SYNTHETIC_SUFFIX = ' (synthetic)';

/** Names with more than one match, so the ambiguity prompt can be exercised ("Portland", "Springfield"). */
export const AMBIGUOUS_PLACES: Record<string, string[]> = { portland: ['Oregon', 'Maine'], springfield: ['Illinois', 'Missouri'] };

/** Extra real US cities the fixture accepts besides the default network. Names only; no data. */
const EXTRA_PLACES = [
  'Honolulu', 'Anchorage', 'Pittsburgh', 'Cleveland', 'Columbus', 'Cincinnati', 'Indianapolis', 'Kansas City', 'St Louis', 'Saint Louis', 'Milwaukee', 'Baltimore',
  'Sacramento', 'San Jose', 'San Antonio', 'Raleigh', 'Albuquerque', 'Louisville', 'Memphis', 'Oklahoma City', 'Omaha', 'Boise', 'Buffalo', 'Jacksonville',
  'Fort Lauderdale', 'Charleston', 'Richmond', 'Tucson', 'El Paso', 'Des Moines', 'Madison', 'Providence', 'Hartford', 'Birmingham', 'Tulsa', 'Reno', 'Spokane', 'Savannah',
];
const KNOWN_PLACES = new Set(
  [...DEFAULT_NETWORK.flatMap((c) => [c.city, ...(c.aka ?? [])]), ...EXTRA_PLACES, ...Object.keys(AMBIGUOUS_PLACES)].map((n) => n.toLowerCase().replace(/\./g, '').replace(/[-\u2013]/g, ' ').replace(/\s+/g, ' ').trim()),
);
/** "Orlando", "Orlando, Florida" and "orlando" are known; "Atlantis" is not. */
export function isKnownPlace(name: string): boolean {
  const key = name.split(',')[0]!.toLowerCase().replace(/\./g, '').replace(/[-\u2013]/g, ' ').replace(/\s+/g, ' ').trim();
  return KNOWN_PLACES.has(key);
}

export class FixtureQlooClient implements QlooClient {
  readonly source = 'synthetic-fixture' as const;
  /** Count of calls, so tests and budgets behave the same as with the live client. */
  calls = 0;
  /** Entities invented so far, so an ID always maps back to the same synthetic entity. */
  readonly #seen = new Map<string, QlooEntity>();
  /** Which synthetic city an open-read entity came from, so anchors carry their city's taste. */
  readonly #home = new Map<string, string>();
  readonly #onCall?: (path: string) => void;

  constructor(opts: { onNetworkCall?: (path: string) => void } = {}) {
    this.#onCall = opts.onNetworkCall;
  }

  async searchLocality(query: string): Promise<QlooResult<QlooEntity[]>> {
    const q = query.trim();
    const params = { query: q, types: 'urn:entity:locality', take: '5' };
    const base = q.replace(/\s*\(.*\)\s*$/, '');
    // The fixture only knows a fixed list of real city names (below), so an unknown place such as
    // "Atlantis" fails cleanly and the unknown-place stop can be demonstrated without a key.
    if (!isKnownPlace(base)) return this.#wrap('/search', params, []);
    // A deliberately ambiguous case so the confirmation step can be exercised.
    const variants = AMBIGUOUS_PLACES[base.toLowerCase()]?.map((st) => `${base}, ${st}`) ?? [base];
    const data: QlooEntity[] = variants.map((name, i) => ({
      entity_id: `SYN-LOC-${hash(name.toLowerCase()).toString(16)}`,
      name: name + SYNTHETIC_SUFFIX,
      subtype: 'urn:entity:locality',
      popularity: round(0.9 - i * 0.05),
    }));
    return this.#wrap('/search', params, data);
  }

  async searchTitle(query: string, domain: Domain): Promise<QlooResult<QlooEntity[]>> {
    const q = query.trim();
    const params = { query: q, types: `urn:entity:${domain}`, take: '3' };
    if (!q || /\bnot ?found\b/i.test(q)) return this.#wrap('/search', params, []);
    const e = this.#entity(/\(synthetic\)$/.test(q) ? q : q + SYNTHETIC_SUFFIX, domain, q);
    const data: QlooEntity[] = [{ ...e, properties: { ...e.properties, release_year: undefined } }];
    return this.#wrap('/search', params, data);
  }

  /**
   * Emulates the three read modes (see types.ts InsightsRequest):
   * - open (location, nothing pinned): ranks an invented local pool by the city's synthetic taste.
   * - pinned (location + pinned IDs): returns ONLY the single best pinned title, to simulate the
   *   "location acts as a hard filter" behaviour another entrant reported, so the probe and the
   *   agent's fallback logic can be exercised before the key arrives.
   * - anchored (anchor IDs + pinned IDs): scores pinned titles by genre similarity to the anchors.
   */
  async insights(req: InsightsRequest): Promise<QlooResult<QlooEntity[]>> {
    const params = describe(req);
    const take = Math.min(50, req.take ?? 20);
    const pinned = (req.onlyEntityIds ?? []).filter((id) => id.startsWith('SYN-')).map((id) => this.#entityFromId(id, req.domain));
    let scored: QlooEntity[];
    if (req.anchorEntityIds?.length) {
      const anchors = req.anchorEntityIds.map((id) => this.#entityFromId(id, 'artist'));
      const vec = anchorVector(anchors);
      const homes = req.anchorEntityIds.map((id) => this.#home.get(id)).filter((x): x is string => !!x);
      const home = homes.length ? homes.sort((a, b) => homes.filter((x) => x === b).length - homes.filter((x) => x === a).length)[0] : undefined;
      const pool = pinned.length ? pinned : SYN_DISCOVERY_TITLES[req.domain].map((t) => this.#entity(t + SYNTHETIC_SUFFIX, req.domain, t));
      const seed = req.anchorEntityIds.join(',');
      scored = pool
        .filter((e) => !req.anchorEntityIds!.includes(e.entity_id!))
        .map((e) => ({
          ...e,
          query: { affinity: home ? affinity(home, e, seed) : affinityFromVector(vec, e, seed) },
        }));
    } else if (req.location) {
      const locKey = locationKey(req.location);
      let pool: QlooEntity[];
      if (pinned.length) {
        pool = pinned;
      } else if (req.tagIds?.length) {
        // A tag-filtered read: an invented pool whose titles all carry the requested tag.
        pool = SYN_DISCOVERY_TITLES[req.domain].map((t) => this.#taggedEntity(`${t} ${TAG_WORDS[hash(req.tagIds![0]! + t) % TAG_WORDS.length]}`, req.domain, req.tagIds![0]!, locKey));
        if (req.contentRating) {
          const allowed = new Set(req.contentRating.split(','));
          pool = pool.filter((e) => allowed.has(String(e.properties?.content_rating)));
        }
      } else {
        pool = SYN_DISCOVERY_TITLES[req.domain].map((t) => this.#entity(t + SYNTHETIC_SUFFIX, req.domain, t, locKey));
        pool.forEach((e) => this.#home.set(e.entity_id!, locKey));
        if (req.contentRating) {
          const allowed = new Set(req.contentRating.split(','));
          pool = pool.filter((e) => allowed.has(String(e.properties?.content_rating)));
        }
        if (req.releaseYearMin) pool = pool.filter((e) => (e.properties?.release_year ?? 0) >= req.releaseYearMin!);
      }
      scored = pool.map((e) => ({ ...e, query: { affinity: affinity(locKey, e) } }));
      if (pinned.length) scored = scored.sort((a, b) => (b.query?.affinity ?? 0) - (a.query?.affinity ?? 0)).slice(0, 1);
    } else {
      scored = pinned.map((e) => ({ ...e, query: { affinity: round(e.popularity ?? 0.5) } }));
    }
    if (req.excludeEntityIds?.length) scored = scored.filter((e) => !req.excludeEntityIds!.includes(e.entity_id!));
    if (req.tagIds?.length) scored = scored.filter((e) => (e.tags ?? []).some((t) => req.tagIds!.includes(t.id ?? '')));
    scored.sort((a, b) => (b.query?.affinity ?? 0) - (a.query?.affinity ?? 0));
    return this.#wrap('/v2/insights', params, scored.slice(0, take));
  }

  async tasteAnalysis(req: TasteAnalysisRequest): Promise<QlooResult<QlooTag[]>> {
    const params: Record<string, string> = { 'filter.type': 'urn:tag', ...locParams(req.location) };
    const w = cityWeights(locationKey(req.location));
    const tags: QlooTag[] = SYN_GENRES.map((g, i) => ({
      tag_id: g.id,
      name: g.name + SYNTHETIC_SUFFIX,
      subtype: 'syn:genre',
      query: { affinity: round(w[i] ?? 0) },
    })).sort((a, b) => (b.query!.affinity ?? 0) - (a.query!.affinity ?? 0));
    return this.#wrap('/v2/insights', params, tags.slice(0, req.take ?? 25));
  }

  async demographics(entityIds: string[]): Promise<QlooResult<QlooDemographicsBlock[]>> {
    const params = { 'filter.type': 'urn:demographics', 'signal.interests.entities': entityIds.join(',') };
    const data: QlooDemographicsBlock[] = entityIds.map((id) => {
      const h = hash(id);
      const age: Partial<Record<(typeof AGE_BANDS)[number], number>> = {};
      AGE_BANDS.forEach((band, i) => {
        age[band] = round(((((h >>> (i * 3)) & 0x3f) / 63) - 0.5) * 0.8);
      });
      const g = round(((h & 0xff) / 255 - 0.5) * 0.4);
      return { entity_id: id, query: { age, gender: { male: g, female: round(-g) } } };
    });
    return this.#wrap('/v2/insights', params, data);
  }

  async trending(req: TrendingRequest): Promise<QlooResult<QlooTrendingPoint[]>> {
    const params = {
      'signal.interests.entities': req.entityId,
      'filter.type': `urn:entity:${req.domain}`,
      'filter.start_date': req.startDate,
      'filter.end_date': req.endDate,
    };
    const h = hash(req.entityId);
    const slope = ((h & 0xff) / 255 - 0.45) * 4; // percentile points per week
    const end = Date.parse(req.endDate);
    const points: QlooTrendingPoint[] = [];
    for (let w = 0; w < 8; w++) {
      const pct = Math.max(1, Math.min(99, 60 + slope * (8 - w) - slope * 4));
      points.push({
        date: new Date(end - w * 7 * 86_400_000).toISOString().slice(0, 10),
        population_percentile: round(pct),
        population_percent_delta: round(slope),
      });
    }
    return this.#wrap('/v2/trending', params, points);
  }

  /**
   * Destinations favoured by the audience behind the seed entities. The score blends each
   * synthetic city's taste weights with the seeds' synthetic genres, plus noise, so two
   * disjoint halves of a slate broadly agree, as the consistency check expects.
   */
  async destinations(req: DestinationsRequest): Promise<QlooResult<QlooEntity[]>> {
    const params: Record<string, string> = { 'filter.type': 'urn:entity:destination', 'signal.interests.entities': req.seedEntityIds.join(',') };
    if (req.countryCode) params['filter.geocode.country_code'] = req.countryCode;
    params.take = String(req.take ?? 50);
    const seeds = req.seedEntityIds.map((id) => this.#seen.get(id)).filter((e): e is QlooEntity => !!e);
    const vec = anchorVector(seeds);
    const total = [...vec.values()].reduce((a, b) => a + b, 0) || 1;
    const places = [...DEFAULT_NETWORK.map((c) => c.city), ...SYN_EXTRA_DESTINATIONS];
    const data: QlooEntity[] = places.map((city) => {
      const w = cityWeights(`dest:${city.toLowerCase()}`);
      const match = SYN_GENRES.reduce((acc, g, i) => acc + ((vec.get(g.id) ?? 0) / total) * (w[i] ?? 0), 0);
      // A shared per-city baseline (some places draw everyone) plus the seeds' genre match.
      const baseline = (hash(`dest-base:${city}`) % 1000) / 1000;
      const noise = ((hash(`${req.seedEntityIds.join(',')}|${city}`) % 100) / 100 - 0.5) * 0.1;
      return {
        entity_id: `SYN-DEST-${hash(city).toString(16)}`,
        name: city + SYNTHETIC_SUFFIX,
        subtype: 'urn:entity:destination',
        properties: { geocode: { name: city + SYNTHETIC_SUFFIX, country_code: 'US' } },
        query: { affinity: round(Math.max(0.01, Math.min(0.99, 0.1 + 0.45 * baseline + 0.5 * match + noise))) },
      };
    });
    data.sort((a, b) => (b.query?.affinity ?? 0) - (a.query?.affinity ?? 0));
    return this.#wrap('/v2/insights', params, data.slice(0, req.take ?? 50));
  }

  /** Tag search over the invented genre space (shape of `results.tags`). */
  async searchTags(req: TagSearchRequest): Promise<QlooResult<QlooTag[]>> {
    const q = req.query.trim().toLowerCase();
    const params: Record<string, string> = { 'filter.query': req.query.trim() };
    if (req.parentTypes?.length) params['filter.parents.types'] = req.parentTypes.join(',');
    params.take = String(req.take ?? 10);
    const hits = q
      ? SYN_GENRES.filter((g) => g.name.toLowerCase().includes(q) || g.words.some((w) => w.includes(q) || q.includes(w)))
      : [];
    const data: QlooTag[] = hits.map((g) => ({
      tag_id: g.id,
      name: g.name + SYNTHETIC_SUFFIX,
      types: ['urn:entity:movie', 'urn:entity:tv_show'],
      subtype: 'syn:genre',
    }));
    return this.#wrap('/v2/tags', params, data.slice(0, req.take ?? 10));
  }

  #taggedEntity(title: string, domain: Domain, tagId: string, locKey: string): QlooEntity {
    const id = `SYN-${domain.toUpperCase()}-T${hash(`${locKey}|${tagId}|${title}`).toString(16)}`;
    const known = this.#seen.get(id);
    if (known) return known;
    const base = this.#makeEntity(id, domain, title + SYNTHETIC_SUFFIX, title);
    const g = SYN_GENRES.find((x) => x.id === tagId);
    const e: QlooEntity = { ...base, tags: [{ id: tagId, name: g?.name ?? tagId, type: 'syn:genre' }, ...(base.tags ?? []).filter((t) => t.id !== tagId)] };
    this.#seen.set(id, e);
    return e;
  }

  #entity(name: string, domain: Domain, seed: string, locKey?: string): QlooEntity {
    // Open reads give each city its own invented local pool, so two route ends differ.
    const salt = locKey ? `${locKey}|` : '';
    const id = `SYN-${domain.toUpperCase()}-${hash(salt + domain + ':' + seed.toLowerCase()).toString(16)}`;
    return this.#entityFromId(id, domain, name, seed);
  }

  #entityFromId(id: string, domain: Domain, name?: string, seed?: string): QlooEntity {
    const known = this.#seen.get(id);
    if (known) return known;
    const e = this.#makeEntity(id, domain, name, seed);
    this.#seen.set(id, e);
    return e;
  }

  #makeEntity(id: string, domain: Domain, name?: string, seed?: string): QlooEntity {
    const h = hash(id);
    const ratingsMovie = ['G', 'PG', 'PG-13', 'PG-13', 'R'];
    const ratingsTv = ['TV-G', 'TV-PG', 'TV-14', 'TV-14', 'TV-MA'];
    const genres = genresFor(seed ?? name ?? id, h);
    return {
      entity_id: id,
      name: name ?? `${id}${SYNTHETIC_SUFFIX}`,
      subtype: `urn:entity:${domain}`,
      popularity: round(0.5 + ((h >>> 4) & 0xff) / 600),
      properties: {
        release_year: 2014 + (h % 12),
        content_rating:
          domain === 'movie' ? ratingsMovie[h % 5] : domain === 'tv_show' ? ratingsTv[h % 5] : undefined,
      },
      tags: genres.map((g) => ({ id: g.id, name: g.name, type: 'syn:genre' })),
    };
  }

  #wrap<T>(path: string, params: Record<string, string>, data: T): QlooResult<T> {
    this.calls++;
    this.#onCall?.(path);
    if (Object.values(params).some((v) => /\bforce-401\b/.test(v))) {
      throw new QlooError('Synthetic 401 for tests', 401, 'auth');
    }
    return { data, request: { path, params }, source: this.source, cached: false, ms: 1 };
  }
}

/** Deterministic 32-bit FNV-1a hash. */
export function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function locationKey(loc: LocationSignal): string {
  return 'localityId' in loc ? loc.localityId : `q:${loc.query.toLowerCase()}`;
}

function locParams(loc: LocationSignal): Record<string, string> {
  return 'localityId' in loc ? { 'signal.location': loc.localityId } : { 'signal.location.query': loc.query };
}

function describe(req: InsightsRequest): Record<string, string> {
  const p: Record<string, string> = { 'filter.type': `urn:entity:${req.domain}`, ...(req.location ? locParams(req.location) : {}) };
  if (req.anchorEntityIds?.length) p['signal.interests.entities'] = req.anchorEntityIds.join(',');
  if (req.onlyEntityIds?.length) p['filter.results.entities'] = req.onlyEntityIds.join(',');
  if (req.excludeEntityIds?.length) p['filter.exclude.entities'] = req.excludeEntityIds.join(',');
  if (req.releaseYearMin) p['filter.release_year.min'] = String(req.releaseYearMin);
  if (req.contentRating) p['filter.content_rating'] = req.contentRating;
  if (req.tagIds?.length) p['filter.tags'] = req.tagIds.join(',');
  p.take = String(req.take ?? 20);
  return p;
}

/** A synthetic city's taste: weights over SYN_GENRES, from the locality key. */
export function cityWeights(key: string): number[] {
  return SYN_GENRES.map((g) => {
    const h = hash(`${key}|${g.id}`);
    return 0.15 + (h % 1000) / 1000 * 0.85;
  });
}

function genresFor(text: string, h: number): (typeof SYN_GENRES)[number][] {
  const t = text.toLowerCase();
  const matched = SYN_GENRES.filter((g) => g.words.some((w) => t.includes(w)));
  if (matched.length) return matched.slice(0, 3);
  const a = SYN_GENRES[h % SYN_GENRES.length]!;
  const b = SYN_GENRES[(h >>> 8) % SYN_GENRES.length]!;
  return a === b ? [a] : [a, b];
}

function affinity(locKey: string, e: QlooEntity, noiseSeed = ''): number {
  const w = cityWeights(locKey);
  const ids = new Set((e.tags ?? []).map((t) => t.id));
  let s = 0;
  let n = 0;
  SYN_GENRES.forEach((g, i) => {
    if (ids.has(g.id)) {
      s += w[i] ?? 0;
      n++;
    }
  });
  const base = n ? s / n : 0.4;
  const noise = ((hash(`${locKey}|${noiseSeed}|${e.entity_id}`) % 100) / 100 - 0.5) * 0.12;
  return round(Math.max(0.01, Math.min(0.99, base + noise)));
}

function anchorVector(anchors: QlooEntity[]): Map<string, number> {
  const v = new Map<string, number>();
  for (const a of anchors) for (const t of a.tags ?? []) v.set(t.id!, (v.get(t.id!) ?? 0) + 1);
  return v;
}

function affinityFromVector(vec: Map<string, number>, e: QlooEntity, seed: string): number {
  const total = [...vec.values()].reduce((s, x) => s + x, 0) || 1;
  const tags = e.tags ?? [];
  const match = tags.reduce((s, t) => s + (vec.get(t.id!) ?? 0), 0) / total;
  const noise = ((hash(`${seed}|${e.entity_id}`) % 100) / 100 - 0.5) * 0.16;
  return round(Math.max(0.01, Math.min(0.99, 0.3 + 0.6 * match + noise)));
}
