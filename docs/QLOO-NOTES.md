# Qloo API notes: what is documented, what is reported, what we must verify

Every endpoint and parameter Seatback sends is listed here with its documentation source. Items marked **REPORTED** come from another entrant's published live measurements. They are not official, so `scripts/live-probe.ts` re-checks them on day one of the key.

## Access (developer guide: https://docs.qloo.com/reference/qloo-llm-hackathon-developer-guide)

- Base URL: `https://hackathon.api.qloo.com` only. Staging and production return 401 for hackathon keys.
- Auth: send the key in the `X-Api-Key` header. A query parameter or Bearer token does not work.
- `/v2/insights` is a GET with a query string. `/recs` and `/recommendations` are legacy and unsupported.
- Invalid parameters are silently ignored and come back as an empty 200. Seatback allowlists every parameter (`src/qloo/params.ts`) and a unit test fails on any undocumented one.
- Caching: "Private server-side caching is fine and there is no time limit." "Do not store Qloo response data in a public repository."
- Keys are deactivated after the hackathon closes. Quotas are "set high enough"; raise them via Discord #api-help.

## Endpoints and parameters used

| Call | Parameters | Source |
|---|---|---|
| `GET /search` | `query`, `types=urn:entity:locality` or a domain type, `take` | https://docs.qloo.com/reference/get-search (`urn:entity:locality` is listed as a search-only type) |
| `GET /v2/insights` open read | `filter.type`, `signal.location.query`, `take`, plus `filter.release_year.min` and `filter.content_rating` for movie and TV | location: https://docs.qloo.com/reference/insights-with-location-use-case (movie example); per-type rows: https://docs.qloo.com/reference/available-parameters-by-entity-type |
| `GET /v2/insights` pinned read | adds `filter.results.entities` | https://docs.qloo.com/reference/parameters ("Often used to assess the affinity of an entity towards input") |
| `GET /v2/insights` anchored read | `signal.interests.entities` + `filter.results.entities` | Entity Type Parameter Guide (Movie, TV Show, Podcast, Artist tables) |
| Taste analysis | `filter.type=urn:tag`, `signal.location.query`, `filter.parents.types`, `take` | https://docs.qloo.com/reference/taste-analysis |
| Demographics | `filter.type=urn:demographics`, `signal.interests.entities` | https://docs.qloo.com/reference/demographics-use-case |
| Trending | `signal.interests.entities`, `filter.type`, `filter.start_date`, `filter.end_date` (both required) | https://docs.qloo.com/reference/get-trending |
| Network fit (destinations) | `filter.type=urn:entity:destination`, `signal.interests.entities` (required for Destination), `filter.geocode.country_code=US`, `take` | Entity Type Parameter Guide (Destination table); `filter.geocode.country_code` in https://docs.qloo.com/reference/parameters ("Destination, Place"). `urn:entity:destination` **is** on the developer guide's supported type list |
| Tag discovery | `GET /v2/tags`: `filter.query`, `filter.parents.types`, `take` | https://docs.qloo.com/reference/search-tags (response `results.tags`) |
| Spotlight and theme reads | open read plus `filter.tags` (real tag IDs from taste analysis or `/v2/tags`) | Entity Type Parameter Guide lists `filter.tags` for Movie, TV Show, Podcast and Artist |
| Heatmap (probe only) | `filter.type=urn:heatmap`, `filter.location.query`, `signal.interests.entities` | https://docs.qloo.com/reference/heatmaps-use-case. **Not** on the developer guide's supported `filter.type` list, so the app does not use it; the probe reports whether this key allows it |

## Documentation gaps and conflicts we found

1. **Location signals and the per-type tables.** The Entity Type Parameter Guide lists **no** `signal.location*` row for any type, not even Place. The Parameter Reference lists `signal.location` and `signal.location.query` as compatible with Movie, TV Show, Podcast and Artist, and the Location-Based Insights guide gives a worked movie example. Seatback follows the two pages that document it, and the probe verifies it.
2. **`video_game` vs `videogame`.** The developer guide writes `urn:entity:video_game`; the OpenAPI enums write `urn:entity:videogame`. Seatback does not use games.
3. **Taste-analysis affinity.** The documented example response shows `query: {}` for tags. Seatback uses `query.affinity` when present and otherwise shows tag order only.
4. **Heatmaps on the hackathon key.** The docs describe `urn:heatmap` fully, but the developer guide's list of supported `filter.type` values omits it (as it also omits `urn:tag` and `urn:demographics`, which are documented as Insights use cases). Seatback uses tag and demographics reads, which fail soft, and leaves heatmaps to the probe.
5. **Audiences.** `/v2/audiences` and `/v2/audiences/types` are marked `deprecated: true` in their OpenAPI definitions, so Seatback does not use them.
6. **`bias.trends` values.** These are documented only in the deep-dive OpenAPI enum (`off` … `very_high`). Seatback does not use it.

## REPORTED by another entrant (Taste Atlas, https://github.com/4KInc/travels-well, measured 13 Oct 2026)

- `filter.location.query` together with pinned entities is silently ignored for movies: identical affinities across cities.
- `signal.location.query` together with pinned entities acts as a hard filter: 8 pinned titles collapsed to 1.
- `signal.location.query` on an open (unpinned) query works, with clearly different top films per city.
- Anchoring on local artists and scoring pinned films with `signal.interests.entities` separates markets. Their result: 11 of 11 regional titles ranked highest at home, p = 0.0005.
- Affinity depends on the signal, not on the candidate set, so scores are comparable across calls that share a signal.
- `popularity` and `query.affinity` are different fields. Never fall back from one to the other: Seatback reads only `query.affinity`.
- How much film taste each anchor domain carries: TV strong, video games strong, artists strong, brands weak, books barely, podcasts barely, places none. Seatback therefore anchors on artists, TV and films (always a different domain from the titles being ranked), never on podcasts or places.
- `take` above 50 returns a 400 that is easy to misread as "no data". Seatback clamps to 50.

**Consequence for Seatback:** podcasts and music are *scored* (as target domains) with artist and TV anchors. Podcasts are not used as anchors. Whether podcasts are well separated *as targets* is unknown; the probe prints it, and the UI abstains if readings disagree.
