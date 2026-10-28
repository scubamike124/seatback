// Presubmit gate for LIVE-required outputs. Refuses (exit 1) if any given file or folder is labelled
// MOCK / synthetic / dry-run, mentions synthetic ids, or contains a credential-shaped string.
//   node scripts/presubmit-live.ts <file-or-dir>... [--health-json '{"mode":"live"}']
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { containsSecret } from '../src/qloo/redact.ts';

export interface LiveFinding { where: string; why: string }
const MOCK_MARKERS: [string, RegExp][] = [
  ['labelled MOCK', /\bMOCK\b|\[QLOO:MOCK\]|Data mode: MOCK/],
  ['labelled dry run', /DRY[- ]RUN|\[QLOO:DRY-RUN\]/],
  ['synthetic source', /synthetic-fixture|\(synthetic\)|"mode"\s*:\s*"synthetic"|\bSYN-[A-Za-z0-9]/i],
];
const TEXT = /\.(md|txt|json|ndjson|csv|html|js|ts)$/i;

export function checkLiveText(text: string, where: string): LiveFinding[] {
  const f: LiveFinding[] = [];
  for (const [why, re] of MOCK_MARKERS) if (re.test(text)) f.push({ where, why: `mock data where live is required: ${why}` });
  if (containsSecret(text)) f.push({ where, why: 'credential-shaped string (value not shown)' });
  return f;
}

export function checkLivePaths(paths: string[]): LiveFinding[] {
  if (!paths.length) return [{ where: '(none)', why: 'no outputs given: nothing proves the outputs are live' }];
  const f: LiveFinding[] = [];
  const visit = (p: string) => {
    if (!existsSync(p)) { f.push({ where: p, why: 'missing' }); return; }
    if (statSync(p).isDirectory()) { for (const n of readdirSync(p)) visit(join(p, n)); return; }
    if (/mock|synthetic/i.test(p)) f.push({ where: p, why: 'file name says mock/synthetic' });
    if (TEXT.test(p)) f.push(...checkLiveText(readFileSync(p, 'utf8'), p));
  };
  paths.forEach(visit);
  return f;
}

export function checkHealth(json: string): LiveFinding[] {
  try { return JSON.parse(json).mode === 'live' ? [] : [{ where: 'health', why: `mode is ${JSON.stringify(JSON.parse(json).mode)}, live required` }]; } catch { return [{ where: 'health', why: 'not JSON' }]; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const hi = a.indexOf('--health-json');
  const health = hi >= 0 ? a.splice(hi, 2)[1] : undefined;
  const findings = [...checkLivePaths(a), ...(health !== undefined ? checkHealth(health) : [])];
  if (findings.length) {
    console.log(`presubmit:live FAILED (${findings.length})`);
    for (const x of findings) console.log(`  ${x.where}: ${x.why}`);
    process.exit(1);
  }
  console.log('presubmit:live OK: no mock labels or secrets in the given outputs.');
}
