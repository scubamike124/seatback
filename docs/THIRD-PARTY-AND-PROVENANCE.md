# Third-party software and provenance

## Runtime dependencies
None. The app is plain TypeScript run by Node 22.18+ (type stripping) or a fetch-style host (Deno Deploy, Cloudflare Workers); `package.json` has no `dependencies`. Nothing third-party is bundled into the served page or the worker.

## Development tooling (not shipped; installed by `npm ci`)
| Package | Version | Licence | Use |
|---|---|---|---|
| typescript | 5.8.3 | Apache-2.0 | type checking only (`npm run typecheck`) |
| @types/node | 22.15.3 | MIT | Node type declarations |
| undici-types | 6.21.0 | MIT | pulled in by @types/node |
Read from each package's own `package.json` in `node_modules` and from `package-lock.json`. No copyleft licence and no package with an unknown licence.

## External services (not code in this repository)
- Qloo API (hackathon host): used under the API key terms. Qloo response data is never stored in this repository; the repository tooling (`npm run presubmit:repo`, `test/public-safety.test.ts`) fails if recorded Qloo data, probe output or example recordings appear in the tree.
- Gemini API (optional): used only if the operator sets a key; the key is read from the environment and never written to a file.

## Fixtures
See `FIXTURES.md`: every fixture title, place and score is invented or generated; none was copied or derived from a Qloo response.

## The project's own code
Written with AI coding assistance (Anthropic's Claude via Claude Code), directed and reviewed by the entrant. Licence: see `LICENSE` (and `NOTICE` if present). Ownership and copyright details are for the entrant to confirm.

## Quotations
`README.md` quotes short passages from public articles and filings with links, for context only.
