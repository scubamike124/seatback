# Where the synthetic fixtures come from

`src/qloo/fixture-client.ts` is a hand-written, deterministic fake of the Qloo client. It exists so the whole product runs and is testable without a key.

- **Nothing was copied from, or derived from, a Qloo response.** The fixture world is an invented genre space (`SYN_GENRES`, ten genres with invented keyword lists) plus short hand-written lists of invented titles, artists and places-that-are-not-on-a-network (`SYN_DISCOVERY_TITLES`, `SYN_EXTRA_DESTINATIONS`). Real US city names are used only as place labels so a route can be typed; they carry no data.
- **Every score is computed**, not stored: affinities, tags, demographics and trending values are deterministic functions of a hash of the inputs (`hash(...)`) over that invented genre space. There is no table of recorded values.
- **Labelling:** every invented entity name ends with "(synthetic)", every entity id starts with `SYN-` (tag ids with `syn:`), and every result is tagged `source: 'synthetic-fixture'`, which the UI shows as a banner and a badge.
- **Shape only:** the response shapes mirror the documented examples (`results.entities`, `results.tags`, `results.demographics`, `results.trending`) so the same parsing code runs in both modes. Shapes are not data.
- **Guards:** `test/fixture-provenance.test.ts` fails if the fixture source or `test/fixtures/` contains a UUID-shaped or 32-hex id, a Qloo-looking `entity_id`, or an entity without the `SYN-` prefix; `scripts/predeploy-check.sh` and `test/public-safety.test.ts` scan the tree too.
- **How to regenerate:** nothing to regenerate: the data is produced at run time by the code above.
