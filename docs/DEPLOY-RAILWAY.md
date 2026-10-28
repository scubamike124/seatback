# Private demo on Railway (isolated project, synthetic mode)

Nothing here was run against Railway: no account, project, repo or deployment was created by the author. The owner does these steps. Never paste a secret into chat, a file or a commit; type it into the Railway dashboard only. Do not use any existing production project: create a NEW project used only for Seatback.

## What gets deployed
A plain Node 22 container (`Dockerfile`, or Railway's Node build with `npm start`) running `deploy/node.ts`: the same app as the Worker, behind an optional access gate. With no Qloo key it shows clearly labelled SYNTHETIC data. Source for this deployment should be a PRIVATE repository or branch, not the public contest repository (see "Private source" below).

## Steps
1. Railway dashboard, New Project, Deploy from GitHub repo (the private one). Railway reads `railway.json`: Dockerfile build, health check `/healthz`, one replica.
2. Service, Variables, add (names only here; type values in the dashboard):
   - `DEMO_ACCESS_TOKEN`: a long random string. Generate it on your own computer with `openssl rand -hex 16` (32 characters) or with your password manager's generator; never paste it into chat, email or a file in the repo (at least 24 characters; the app warns below 24 and refuses to start in production below 16). With it set, every page needs the token and the page shows a PRIVATE PREVIEW banner. Leave unset only for a public contest deployment.
   - `LIVE_ENABLED` = `0` (default; custom live Qloo runs stay off).
   - Leave `QLOO_API_KEY` and `GEMINI_API_KEY` UNSET for the synthetic demo. When keys exist, add them here (never in files). Optional: `LLM_PROVIDER` (`gemini` or `none`), `GEMINI_MODEL`.
   - `ADMIN_TOKEN`: a second random string, only needed to record stored examples later (`POST /api/admin/warm`).
   - Caps (defaults are conservative, set only to change them): `DAILY_CALL_CAP`, `PER_VISITOR_CALL_CAP`, `MAX_QLOO_CALLS_PER_RUN`, `EXAMPLE_CALL_BUDGET`, `LLM_CALLS_PER_RUN`, `EXAMPLE_LLM_CALLS`, `PER_VISITOR_LLM_CALL_CAP`, `DAILY_LLM_CALL_CAP`.
   - `TRUST_PROXY_HEADER` = `x-real-ip` so per-visitor limits see the real client address (Railway puts a proxy in front). If you cannot confirm that Railway sets that header for your service, use `x-forwarded-for` (the app takes its LAST hop) or leave it unset (then all visitors share the proxy's address and the per-IP limits become global). This header behaviour was not verified from here: check it once by opening `/api/config` from two networks and watching the limiter.
   - `PORT` is set by Railway; the app listens on it.
   - Storage: **SKIP the volume for the synthetic demo.** The in-memory store is enough: nothing there needs to survive a restart (examples are recomputed from fixtures). If you later record real examples and want them to survive restarts: add a Railway Volume mounted at `/data`, set `DATA_DIR=/data`, AND set `RAILWAY_RUN_UID=0` (the container runs as the non-root `node` user, and Railway volumes are mounted root-owned, so without this the app cannot write to the volume and stored examples/counters fail with a permission error). Counters and files are for ONE instance only: keep replicas at 1.
3. Deploy. Open `https://<your-service>.up.railway.app/healthz` (answers `ok`; reveals nothing). Then open the access link once: `https://<your-service>.up.railway.app/?access=<your DEMO_ACCESS_TOKEN>`. The app sets a cookie and redirects to the clean URL; the token is not kept in the address bar or logs.
4. iPhone: see `IPHONE-DEMO-INSTRUCTIONS.md` (open the link once, then Share, Add to Home Screen).

## Base image
The Dockerfile pins `node:22.22.0-slim`. That tag was verified to exist on Docker Hub (HTTP 200 on its tag page on 2026-10-25; a newer `22.23.4-slim` also exists). If you ever need to move, change the first line of the Dockerfile to another `node:22.x-slim` tag listed on https://hub.docker.com/_/node.

## Cost knobs
One replica; set a memory limit in the service settings (the app needs well under 256 MB); no volume unless you want stored examples to survive restarts; set a usage limit/alert in Railway billing; no Qloo or Gemini key means no per-call spend.

## Rollback and teardown
- Rollback: Deployments, pick the previous deployment, Redeploy. Change a variable and the service redeploys.
- Pause: set `DEMO_ACCESS_TOKEN` to a new random value (old links stop working at once), or remove the service's public domain.
- Teardown: delete the service, delete the volume, delete the project; revoke any key you added elsewhere; remove the private repo if it is no longer needed.

## Private source (separate from the public contest repo)
First step, in plain words: **create a NEW GitHub repository for the deployment and upload the application files (everything inside the staged folder, not the folder itself) to its main branch.** Then connect that repository in a NEW Railway project dedicated to this demo. Keep any private preview repository private; the contest repository is a separate, public one.

The public contest repo is the allowlist in `scripts/public-allowlist.ts` (`node scripts/public-allowlist.ts --inventory <file>` writes the list of published files with sizes and hashes). For the private demo, use `node scripts/public-allowlist.ts --stage-private <empty folder>`: it copies the same allowlisted files (which include `Dockerfile`, `railway.json`, `package.json` with `npm start`) plus a short `RAILWAY-README.txt` written into that folder (not part of the published list), so a private repo built from that folder deploys without further code changes. The private repo must never contain `.dev.vars`, `.private/`, `.data/` or recorded Qloo data.

## Local dry run (no Railway)
```
DEMO_ACCESS_TOKEN=some-long-random-text PORT=8811 node deploy/node.ts
# then open http://127.0.0.1:8811/?access=some-long-random-text
```

## Public-demo controls (optional variables; defaults are safe)
- `TRUST_PROXY_HEADER` = `x-real-ip` or `x-forwarded-for` (any other value is ignored with a warning). Set it ONLY to a header your proxy overwrites; which header Railway sets is UNVERIFIED here: send one test request and read it before enabling. Unset behind a proxy means all visitors share one per-IP bucket (the server prints a warning at start in production). `x-forwarded-for` uses the last entry (the one the proxy appended).
- `GLOBAL_API_PER_MINUTE` (default 600): all-visitor cap on /api/* except stored or memoised example reads. `GLOBAL_RUNS_PER_MINUTE` (default 30): custom runs per minute, all visitors. `MAX_CONCURRENT_RUNS` (default 4): custom runs streaming at once. Refusals are 429/503 with Retry-After and `fallback: "stored-examples"` plus the example ids; the example routes keep working.
- When the Qloo budget is used up, custom runs are refused with the same message as before (plus the fallback fields). When the LLM budget is used up, the planner stops and the run finishes with the labelled "scripted workflow (LLM budget reached)".
