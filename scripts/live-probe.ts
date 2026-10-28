// FIRST THING TO RUN WHEN THE KEY ARRIVES.
//   QLOO_API_KEY=... node scripts/live-probe.ts        (or put the key in .dev.vars)
//
// Tests, against the live hackathon API and with the product's own code paths
// (openReadRequest, rankedAnchors, anchorSetsFor, consensus, directionCheck):
//   0. Auth at https://hackathon.api.qloo.com with X-Api-Key (401 = stop and fix).
//   1. PINNED   location + filter.results.entities: does it score all pinned titles, or collapse?
//   2. OPEN     location only: do the two ends return different top titles?
//   3. ANCHORED the product's method: do the two readings per end agree (tau >= MIN_CONSENSUS_TAU,
//               the same constant the app uses), and do the two ends rank the catalogue differently?
//   5. EXTRAS (report only, never part of the GO rule): network fit (urn:entity:destination, two
//               readings), /v2/tags, filter.tags on a location read, and urn:heatmap (expected 403).
//   4. DIRECTION (headline): do hand-coded hometown titles rank higher with their own city's
//               anchors than with the other end's? Compared against a shuffled-anchor null.
//
// GO rule (pre-registered; do not tune after seeing results):
//   GO       = direction passes (>= 70% of n >= 6 comparisons, one-sided cluster sign-flip
//              permutation p < 0.05 over route x city clusters, null rate averaged over all other
//              cities <= 60%) AND anchored consensus holds at both ends with ends tau < 0.85 for films
//              or TV on at least 2 of 3 routes.
//   DEGRADED = only the open reads differ between ends (rail works, ranking does not). NO-GO for Seatback.
//   NO-GO    = otherwise: the method does not hold on live data; do not ship it.
//
// Writes only a summary (no raw Qloo payloads) to .private/ (gitignored).
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { HttpQlooClient } from '../src/qloo/http-client.ts';
import { MemoryCache } from '../src/qloo/cache.ts';
import { type Domain, type QlooEntity, QlooError } from '../src/qloo/types.ts';
import { consensus, endsSeparation, looksCollapsed, percentileMap, ENDS_AGREE_TAU, MIN_CONSENSUS_TAU } from '../src/agent/market.ts';
import { type AnchorDomain, anchorSetsFor, openReadRequest, rankedAnchors } from '../src/agent/anchors.ts';
import { directionCheck, directionPasses } from '../src/agent/validity.ts';
import { parseCatalogue } from '../src/agent/catalogue.ts';
import { LIVE_SAMPLE_CATALOGUE } from '../src/examples.ts';
import { DEFAULT_NETWORK, networkFit } from '../src/agent/network.ts';
import { blockNetwork, dryRunLines, findKey, isDryRun, requireKey } from './live-guard.ts';

const ROUTES: [string, string][] = [
  ['Minneapolis', 'Orlando'],
  ['Atlanta', 'Seattle'],
  ['Miami', 'Denver'],
];
const varsPath = new URL('../.dev.vars', import.meta.url);
if (isDryRun(process.argv)) {
  // Proves the run is ready without a key or a network call: nothing is read into output, nothing is written.
  blockNetwork();
  const gi = new URL('../.gitignore', import.meta.url);
  const lines = dryRunLines({
    script: 'scripts/live-probe.ts',
    keyPresent: !!findKey(process.env, varsPath),
    plan: [
      'authenticate with one /search call (401 stops the run)',
      `resolve the sample catalogue titles, then for each route (${ROUTES.map(([a, b]) => `${a}-${b}`).join(', ')}): open reads, pinned reads and anchored reads per domain`,
      'run the home-direction validity check with the pre-registered GO rule',
      'report extras (taste analysis, demographics, trending, network fit, tags, filter.tags, heatmap); these never change the GO rule',
      'print a verdict: GO, GO (pinned mode), DEGRADED or NO-GO',
    ],
    outputFiles: ['.private/probe-<date>.json (a summary only; no raw Qloo responses)'],
    gitignoreText: existsSync(gi) ? readFileSync(gi, 'utf8') : '',
  });
  for (const l of lines) console.log(l);
  process.exit(0);
}
const qloo = new HttpQlooClient({ apiKey: requireKey(process.env, varsPath), cache: new MemoryCache(4000) });
const recencyYear = new Date().getUTCFullYear() - 3;
const summary: Record<string, unknown> = { at: new Date().toISOString(), routes: {} };
const log = (s: string) => console.log(s);
const DOMAINS: Domain[] = ['movie', 'tv_show', 'podcast', 'artist'];

async function main() {
  try {
    const r = await qloo.searchLocality('Minneapolis');
    log(`[0] auth OK. /search locality: ${r.data.slice(0, 3).map((e) => e.name).join(', ') || 'no results'}`);
  } catch (e) {
    const err = e as QlooError;
    log(`[0] FAILED: ${err.message}`);
    if (err.kind === 'auth') log('    401: check the key, base URL (hackathon.api.qloo.com) and X-Api-Key header; post in Discord #api-help if it persists.');
    process.exit(1);
  }

  const items = parseCatalogue(LIVE_SAMPLE_CATALOGUE, 40).items;
  const ids: Record<Domain, string[]> = { movie: [], tv_show: [], podcast: [], artist: [] };
  for (const it of items) {
    const e = (await qloo.searchTitle(it.title, it.domain)).data[0];
    if (e?.entity_id) ids[it.domain].push(e.entity_id);
    else log(`    no match: ${it.domain} "${it.title}"`);
  }
  log(`[cat] resolved ${Object.values(ids).flat().length}/${items.length} sample titles`);

  let anchoredRoutes = 0;
  let pinnedRoutes = 0;
  let openDiffer = 0;
  for (const [o, d] of ROUTES) {
    const rs: Record<string, unknown> = {};
    log(`\n=== ${o} -> ${d} ===`);
    const open: Record<string, Record<Domain, QlooEntity[]>> = {};
    for (const city of [o, d]) {
      open[city] = {} as Record<Domain, QlooEntity[]>;
      for (const dom of DOMAINS) {
        const r = await qloo.insights(openReadRequest(dom, { query: city }, { recencyYear }));
        open[city][dom] = r.data;
        log(`[open] ${city} ${dom}: ${r.data.length} -> ${r.data.slice(0, 4).map((e) => `${e.name} (${e.query?.affinity?.toFixed(3) ?? 'no affinity'})`).join('; ')}`);
      }
    }
    const top = (c: string, dom: Domain) => new Set(open[c]![dom].map((e) => e.entity_id));
    const overlap = [...top(o, 'movie')].filter((x) => top(d, 'movie').has(x)).length / Math.max(1, top(o, 'movie').size);
    log(`[open] film top-list overlap between ends: ${(overlap * 100).toFixed(0)}%`);
    if (overlap < 0.8) openDiffer++;
    rs.openFilmOverlap = overlap;
    const ranked = (c: string, other: string) =>
      Object.fromEntries((['artist', 'tv_show', 'movie'] as AnchorDomain[]).map((ad) => [ad, rankedAnchors(open[c]![ad], open[other]![ad])])) as Record<AnchorDomain, QlooEntity[]>;
    let anchoredOkScreens = 0;
    let pinnedOkScreens = 0;
    for (const dom of DOMAINS) {
      const pinned = ids[dom];
      if (pinned.length < 3) continue;
      // PINNED
      const pm: Map<string, number>[] = [];
      let collapsed = false;
      for (const city of [o, d]) {
        const r = await qloo.insights({ domain: dom, location: { query: city }, onlyEntityIds: pinned, take: pinned.length });
        pm.push(new Map(r.data.filter((e) => typeof e.query?.affinity === 'number').map((e) => [e.entity_id!, e.query!.affinity!])));
        if (looksCollapsed(pinned.length, r.data.length)) collapsed = true;
      }
      const identical = pm[0]!.size > 0 && [...pm[0]!].every(([k, v]) => pm[1]!.get(k) === v);
      const pinnedSep = endsSeparation(percentileMap(pm[0]!), percentileMap(pm[1]!));
      // ANCHORED (the product's method)
      const per = [];
      for (const [city, other] of [[o, d], [d, o]] as const) {
        const sets = anchorSetsFor(dom, 0, ranked(city, other));
        const maps: Map<string, number>[] = [];
        for (const s of sets) {
          const r = await qloo.insights({ domain: dom, anchorEntityIds: s.entities.map((e) => e.entity_id!), onlyEntityIds: pinned, take: pinned.length });
          maps.push(new Map(r.data.filter((e) => typeof e.query?.affinity === 'number').map((e) => [e.entity_id!, e.query!.affinity!])));
        }
        per.push(maps.length ? consensus(pinned, maps[0]!, maps[1]) : consensus(pinned, new Map()));
      }
      const sep = endsSeparation(per[0]!.pct, per[1]!.pct);
      const anchoredOk = per.every((c) => !c.abstain && (c.tau ?? 0) >= MIN_CONSENSUS_TAU) && sep !== null && sep < ENDS_AGREE_TAU;
      const pinnedOk = !collapsed && !identical && pinnedSep !== null && pinnedSep < ENDS_AGREE_TAU;
      log(`[${dom}] pinned: collapsed=${collapsed} identical=${identical} endsTau=${pinnedSep?.toFixed(2)} | anchored: readings tau ${per.map((c) => c.tau?.toFixed(2) ?? 'n/a').join('/')}, withheld ${per.map((c) => c.withheld.length).join('/')}, endsTau ${sep?.toFixed(2) ?? 'n/a'}${per.some((c) => c.abstain) ? `, ABSTAIN: ${per.map((c) => c.abstain).filter(Boolean).join('; ')}` : ''} -> ${anchoredOk ? 'OK' : 'not ok'}`);
      rs[dom] = { collapsed, identical, pinnedSep, anchoredOk, pinnedOk, readingsTau: per.map((c) => c.tau), endsTau: sep };
      if ((dom === 'movie' || dom === 'tv_show') && anchoredOk) anchoredOkScreens++;
      if ((dom === 'movie' || dom === 'tv_show') && pinnedOk) pinnedOkScreens++;
    }
    if (anchoredOkScreens) anchoredRoutes++;
    if (pinnedOkScreens) pinnedRoutes++;
    summary.routes = { ...(summary.routes as object), [`${o}-${d}`]: rs };
  }

  // DIRECTION (headline)
  const filler: Partial<Record<Domain, string[]>> = {};
  for (const it of items) (filler[it.domain] ??= []).push(it.title);
  const dir = await directionCheck(qloo, ROUTES, { recencyYear, filler });
  for (const x of dir.details) log(`[direction] ${x.route} ${x.title} (home ${x.home}): home ${x.pctHome?.toFixed(2) ?? 'n/a'} vs away ${x.pctAway?.toFixed(2) ?? 'n/a'} (null win rate ${x.nullRate?.toFixed(2) ?? 'n/a'}) ${x.success === null ? 'not scored' : x.success ? 'OK' : 'miss'}`);
  const dirOk = directionPasses(dir);
  log(`[direction] ${dir.k}/${dir.n} hometown titles rank higher at home; cluster permutation p=${dir.p.toFixed(4)} over ${dir.clusters} clusters (per-title binomial p=${dir.pBinomial.toFixed(4)}, optimistic); null over all other cities ${dir.nullK}/${dir.nullN}. ${dirOk ? 'PASS' : 'FAIL'}`);
  summary.direction = { k: dir.k, n: dir.n, permutationP: dir.p, binomialP: dir.pBinomial, clusters: dir.clusters, nullK: dir.nullK, nullN: dir.nullN, pass: dirOk };

  try {
    const t = await qloo.tasteAnalysis({ location: { query: 'Orlando' }, parentTypes: ['urn:entity:movie', 'urn:entity:tv_show'], take: 10 });
    log(`\n[taste] Orlando: ${t.data.length} tags; affinity present: ${t.data.some((x) => typeof x.query?.affinity === 'number')}`);
    const dm = await qloo.demographics(ids.movie.slice(0, 3));
    log(`[demographics] ${dm.data.length} blocks`);
    const end = new Date();
    const tr = await qloo.trending({ domain: 'movie', entityId: ids.movie[0]!, startDate: new Date(end.getTime() - 84 * 86_400_000).toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10) });
    log(`[trending] ${tr.data.length} points`);
  } catch (e) {
    log(`[extras] failed: ${(e as Error).message}`);
  }

  // NEW FEATURES (report only; they never change the GO rule). Each one fails soft in the app.
  const extras: Record<string, unknown> = {};
  const tryStep = async (name: string, fn: () => Promise<string>) => {
    try {
      const msg = await fn();
      log(`[${name}] ${msg}`);
      extras[name] = msg;
    } catch (e) {
      const m = `FAILED: ${(e as Error).message}`;
      log(`[${name}] ${m}`);
      extras[name] = m;
    }
  };
  const seeds = [...ids.movie.slice(0, 4), ...ids.tv_show.slice(0, 4)];
  await tryStep('network', async () => {
    // Two disjoint seed halves, as the app does; the app needs tau >= MIN_CONSENSUS_TAU over >= 5 network cities.
    const a = await qloo.destinations({ seedEntityIds: seeds.filter((_, i) => i % 2 === 0), countryCode: 'US' });
    const b = await qloo.destinations({ seedEntityIds: seeds.filter((_, i) => i % 2 === 1), countryCode: 'US' });
    const fit = networkFit(a.data, b.data, DEFAULT_NETWORK, []);
    const geo = a.data.some((x) => x.properties?.geocode?.name);
    return `destinations A ${a.data.length}, B ${b.data.length}; geocode present: ${geo}; network cities paired ${fit.paired}, tau ${fit.tau?.toFixed(2) ?? 'n/a'}; ${fit.abstain ? 'WITHHELD: ' + fit.abstain : 'top ' + fit.rows.filter((x) => x.status === 'ranked').slice(0, 5).map((x) => x.code).join(' ')}. Top raw: ${a.data.slice(0, 6).map((x) => x.name).join(', ')}`;
  });
  let themeTag: string | undefined;
  await tryStep('tags', async () => {
    const t = await qloo.searchTags({ query: 'family', parentTypes: ['urn:entity:movie', 'urn:entity:tv_show'], take: 5 });
    themeTag = t.data.map((x) => x.tag_id ?? x.id).find(Boolean);
    return `/v2/tags "family": ${t.data.length} tags -> ${t.data.slice(0, 5).map((x) => `${x.name} (${x.tag_id ?? x.id})`).join('; ')}`;
  });
  await tryStep('filter.tags', async () => {
    if (!themeTag) return 'skipped: no tag from /v2/tags';
    const r = await qloo.insights({ ...openReadRequest('movie', { query: 'Orlando' }, { recencyYear }), tagIds: [themeTag] });
    const r0 = await qloo.insights(openReadRequest('movie', { query: 'Orlando' }, { recencyYear }));
    const same = r.data.map((x) => x.entity_id).join() === r0.data.map((x) => x.entity_id).join();
    return `Orlando films with filter.tags=${themeTag}: ${r.data.length} (${same ? 'IDENTICAL to the untagged read: filter.tags may be ignored' : 'differs from the untagged read: OK'}) ${r.data.slice(0, 4).map((x) => x.name).join(', ')}`;
  });
  await tryStep('heatmap', async () => {
    // Not on the hackathon key's supported filter.type list; expected to 403. Not used by the app.
    const h = await qloo.heatmap({ locationQuery: 'Orlando', seedEntityIds: ids.movie.slice(0, 2) });
    return `urn:heatmap Orlando: ${h.data.length} cells (supported on this key)`;
  });
  summary.extras = extras;

  const verdict = dirOk && anchoredRoutes >= 2 ? 'GO' : dirOk && pinnedRoutes >= 2 ? 'GO (pinned mode)' : openDiffer >= 2 ? 'DEGRADED (treat as NO-GO for Seatback)' : 'NO-GO';
  const mode = verdict === 'GO (pinned mode)' ? 'pinned' : 'anchored';
  Object.assign(summary, { verdict, recommendedScoringMode: mode, counts: { anchoredRoutes, pinnedRoutes, openDiffer } });
  log(`\nVERDICT: ${verdict}. SCORING_MODE=${mode}. direction ${dir.k}/${dir.n} (p=${dir.p.toFixed(4)}), anchored routes ${anchoredRoutes}/3, pinned routes ${pinnedRoutes}/3, open-differ ${openDiffer}/3.`);
  const dir2 = new URL('../.private/', import.meta.url);
  mkdirSync(dir2, { recursive: true });
  writeFileSync(new URL(`probe-${new Date().toISOString().slice(0, 10)}.json`, dir2), JSON.stringify(summary, null, 2));
  log('Summary written to .private/ (gitignored). No raw Qloo responses were saved.');
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
