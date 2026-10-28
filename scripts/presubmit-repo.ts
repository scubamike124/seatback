// Fails if any recorded live Qloo response (or a live-labelled data file) is under the repo root.
// Recordings live ONLY in private KV and in .private/ on the owner's machine; never in git.
//   node scripts/presubmit-repo.ts [root]
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface RepoFinding { file: string; why: string }
const SKIP = new Set(['node_modules', '.git', '.wrangler', 'dist', '.tmp-test']);
const DATA = /\.(json|ndjson|csv|txt|log|html)$/i;
// Source and docs may NAME the constant 'qloo-live'; recorded data would carry it as a value in a data file or as JSON.
// A recorded result carries an evidence ledger whose records have a "facts" array; any such array in a data file is a recording.
const LEDGER = /"evidence"\s*:\s*\[\s*\{[^}]*"facts"\s*:/;
const JSON_LIVE = /"source"\s*:\s*"qloo-live"|"mode"\s*:\s*"live"|"dataLabel"\s*:\s*"LIVE"/;

export function scanRepoForLiveData(root: string): RepoFinding[] {
  const out: RepoFinding[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      if (SKIP.has(n)) continue;
      const p = join(d, n);
      const rel = relative(root, p);
      if (/^example-(live|synthetic)-.*\.json$/i.test(n)) { out.push({ file: rel, why: 'recorded example file (belongs only in .private/ or private KV)' }); continue; }
      if (/^\.private$|\.live\.json$|^probe-.*\.json$|^eval-live/i.test(n)) { out.push({ file: rel, why: 'live-recording filename' }); continue; }
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (statSync(p).size > 5_000_000) continue;
      const isData = DATA.test(n) && !/^package(-lock)?\.json$|^tsconfig\.json$/.test(n);
      const text = readFileSync(p, 'utf8');
      if (isData && LEDGER.test(text) && !rel.startsWith('test' + '/')) out.push({ file: rel, why: 'contains a recorded evidence ledger' });
      else if (JSON_LIVE.test(text) && !rel.startsWith('test' + '/') && !rel.startsWith('scripts' + '/') && !rel.startsWith('src' + '/')) out.push({ file: rel, why: 'contains a live-labelled response/record' });
      else if (isData && /qloo-live/.test(text)) out.push({ file: rel, why: 'data file mentions qloo-live' });
    }
  };
  walk(root);
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url)));
  if (!existsSync(root)) { console.error('no such root'); process.exit(2); }
  const f = scanRepoForLiveData(root);
  if (f.length) { console.log(`presubmit:repo FAILED: ${f.length} live-data finding(s)`); for (const x of f) console.log(`  ${x.file}: ${x.why}`); process.exit(1); }
  console.log('presubmit:repo OK: no recorded live Qloo data under the repo root.');
}
