#!/usr/bin/env bash
# One-command deploy to Cloudflare Workers. RUN ONLY WITH THE OWNER'S APPROVAL.
# Prerequisites (owner): Cloudflare account, `npx wrangler login`, secrets set (see wrangler.toml),
# KV namespace created and its id pasted into wrangler.toml.
set -euo pipefail
cd "$(dirname "$0")/.."
bash scripts/predeploy-check.sh
npx --yes wrangler@4 deploy
echo
echo "Deployed. Next: warm the judge examples with live data (stored only in private KV):"
echo '  curl -X POST -H "authorization: Bearer $ADMIN_TOKEN" https://<your-worker>.workers.dev/api/admin/warm'
