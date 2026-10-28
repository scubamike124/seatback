#!/usr/bin/env bash
# Safety checks before any deploy or publish. Exits non-zero on any problem.
set -euo pipefail
cd "$(dirname "$0")/.."
fail=0
echo "1. No secrets or Qloo payloads tracked by git"
if git ls-files | grep -E '(^|/)\.dev\.vars$|(^|/)\.env|^\.private/|^eval-output/|\.live\.json$' ; then echo "   FAIL: secret or private file is tracked"; fail=1; fi
if git grep -nE '(QLOO_API_KEY|GEMINI_API_KEY|ADMIN_TOKEN)\s*=\s*["'"'"']?[A-Za-z0-9_\-]{12,}' -- . ':!*.example' ; then echo "   FAIL: something that looks like a real key is committed"; fail=1; fi
if git grep -nE 'AIza[0-9A-Za-z_\-]{30,}' ; then echo "   FAIL: Google API key pattern found"; fail=1; fi
echo "2. Fixtures are synthetic only (IDs start with SYN-)"
if git grep -nE '"entity_id"\s*:\s*"[0-9A-F]{8}-[0-9A-F]{4}-' -- src test ; then echo "   FAIL: a Qloo-looking UUID is hard-coded in src/test"; fail=1; fi
echo "3. Live deploy needs the KV namespace (judge-mode cache) configured in wrangler.toml"
if ! grep -qE '^\[\[kv_namespaces\]\]' wrangler.toml || grep -qE '^id = ""' wrangler.toml; then echo "   FAIL: set the empty id under [[kv_namespaces]] in wrangler.toml with the id from: npx wrangler kv namespace create CACHE_KV"; fail=1; fi
echo "4. Typecheck (needs: npm install)"
npx tsc -p tsconfig.json
echo "5. Tests (one file at a time; set TEST_LOCK to serialise with flock)"
node scripts/run-tests.ts
[ "$fail" = 0 ] && echo "All pre-deploy checks passed." || { echo "Pre-deploy checks FAILED."; exit 1; }
