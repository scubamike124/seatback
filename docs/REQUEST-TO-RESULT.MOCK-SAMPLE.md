# Seatback request to result

**Data mode: MOCK.** MOCK DATA: synthetic fixture, not a Qloo result

> This file was generated from MOCK/dry-run data. It is a template. It must be regenerated in LIVE mode before submission (npm run presubmit:live refuses it otherwise).

Qloo calls: 4/20 (0 served from cache) [MOCK]

## 1. Requests sent (redacted: the key travels in a header and is never recorded)

| # | call | path | parameters | mode | cached | results |
|---|---|---|---|---|---|---|
| 1 | searchLocality | /search | query=Orlando; types=urn:entity:locality; take=5 | MOCK | no | 1 |
| 2 | searchTags | /v2/tags | filter.query=holiday; take=8 | MOCK | no | 0 |
| 3 | insights | /v2/insights | filter.type=urn:entity:movie; signal.location.query=Orlando; take=5 | MOCK | no | 5 |
| 4 | trending | /v2/trending | signal.interests.entities=SYN-M-1; filter.type=urn:entity:movie; filter.start_date=2026-09-01; filter.end_date=2026-10-01 | MOCK | no | 8 |

## 2. Entity and tag choices

- "Orlando": **ambiguous**. Several plausible matches; ask the user to pick. Nothing was chosen automatically.
  - Orlando (synthetic) [SYN-LOC-44c87c5a] confidence 0.62
- "holiday": **none**. Qloo returned no match. Ask for a different spelling.

## 3. Result

See the trace above; ranked output is produced from these responses by the scripted workflow (no LLM), or by the LLM planner (the calls it chose) when an LLM is configured, with plain arithmetic scoring.

## 4. Limitations

- Entity and tag choices use a name-similarity heuristic; ambiguous matches are listed, not auto-picked.
- Affinity scores are Qloo relative scores for the queried location and signals, not audience counts.
- trending and demographics are not documented for the hackathon host; if absent they are reported as unavailable, never invented.
- Quota is unknown; every run is capped by a call budget and uses a private server-side cache.

## 5. Clean-environment setup

1. Node >= 22.18. `npm ci` (only @types/node and typescript as dev dependencies).
2. Copy `.dev.vars.example` to `.dev.vars` (gitignored). Leave QLOO_API_KEY empty for MOCK mode.
3. For LIVE: put the event-issued key in `.dev.vars` locally, or `npx wrangler secret put QLOO_API_KEY` for the Worker. Never commit it.
4. `npm test` (all suites), `npm run dev` (local server). `CONTRACT_LIVE=1 node --test test/contract.test.ts` runs the live contract suite.
