// Read-only check of a deployed Seatback (GET requests only; no key, no token, no write).
//   node scripts/verify-deployed.ts https://<host> [--expect synthetic|live] [--allow-example]
// Fails (exit 1) when the deployment is not public, mislabels its data, or leaks anything key-shaped.
// In --expect live mode the example route can spend Qloo calls, so it is fetched only with --allow-example.
export {};
const args = process.argv.slice(2);
const base = (args.find((a) => /^https?:\/\//.test(a)) ?? '').replace(/\/$/, '');
const expect = args.includes('--expect') ? args[args.indexOf('--expect') + 1] : 'synthetic';
const allowExample = args.includes('--allow-example');
if (!base || (expect !== 'synthetic' && expect !== 'live')) { console.error('usage: node scripts/verify-deployed.ts <https://host> [--expect synthetic|live] [--allow-example]'); process.exit(2); }

const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ': ' + detail : ''}`); };
const KEYISH = /(sk-[A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{30,}|ghp_[A-Za-z0-9]{30,}|x-api-key["']?\s*[:=]\s*["']?[A-Za-z0-9_-]{16,}|QLOO_API_KEY\s*[:=]\s*\S{8,})/i;
const get = async (path: string) => { const r = await fetch(base + path, { redirect: 'manual', signal: AbortSignal.timeout(30_000), headers: { 'user-agent': 'seatback-verify/1' } }); return { r, text: await r.text() }; };

const health = await get('/healthz');
check('healthz answers ok', health.r.status === 200 && health.text.trim() === 'ok', `HTTP ${health.r.status}`);
const home = await get('/');
check('home page is public (no access gate, no redirect)', home.r.status === 200, `HTTP ${home.r.status}`);
check('home page is Seatback', /Seatback/.test(home.text));
const cfgRes = await get('/api/config');
let cfg: any = {}; try { cfg = JSON.parse(cfgRes.text); } catch { /* reported below */ }
check('config is readable JSON with three example routes', cfgRes.r.status === 200 && Array.isArray(cfg.examples) && cfg.examples.length === 3, `HTTP ${cfgRes.r.status}`);
const mode = String(cfg.mode ?? '');
check(`data mode is ${expect}`, expect === 'live' ? mode === 'live' : mode === 'synthetic', `mode=${mode} label=${cfg.dataLabel}`);
check('custom live runs are off for the public demo (LIVE_ENABLED=0)', cfg.liveEnabled === false, `liveEnabled=${cfg.liveEnabled}`);
check('no LLM is configured', cfg.llm === null || cfg.llm === undefined, `llm=${JSON.stringify(cfg.llm)}`);
if (expect === 'synthetic') check('home page carries the synthetic banner', /Synthetic demo data|SYNTHETIC DATA/i.test(home.text));

if (expect === 'synthetic' || allowExample) {
  const ex = await get('/api/example/msp-mco');
  let j: any = {}; try { j = JSON.parse(ex.text); } catch { /* reported below */ }
  check('example route returns a result', ex.r.status === 200 && !!j.result, `HTTP ${ex.r.status} provenance=${j.provenance}`);
  const marks = (ex.text.match(/\(synthetic\)/g) ?? []).length;
  if (expect === 'synthetic') check('synthetic example is labelled synthetic', marks > 0 && /synthetic/.test(String(j.provenance)), `marks=${marks}`);
  else check('live example carries no synthetic marks', marks === 0 && !/synthetic/.test(String(j.provenance)), `marks=${marks} provenance=${j.provenance}`);
  check('example response contains nothing key-shaped', !KEYISH.test(ex.text));
}
check('config and home contain nothing key-shaped', !KEYISH.test(cfgRes.text) && !KEYISH.test(home.text));
const bad = results.filter((r) => !r.ok);
console.log(bad.length ? `\nVERIFY FAILED: ${bad.length} check(s)` : `\nVERIFY OK: ${results.length} checks (GET only)`);
process.exit(bad.length ? 1 : 0);
