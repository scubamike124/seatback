// The exact list of files that may go in the PUBLIC contest repository, and a dry run that checks it.
// Nothing here creates a repo, pushes, or touches the network.
//
//   node scripts/public-allowlist.ts                       dry run: print what would be published; exit 1 on a problem
//   node scripts/public-allowlist.ts --inventory <file>    also write PUBLIC-FILE-INVENTORY.md (path, size, sha256, why)
//   node scripts/public-allowlist.ts --strict              also fail on excluded files (run it on a fresh checkout of what you will push)
//   node scripts/public-allowlist.ts --stage-private <empty folder>   copy the allowlisted files there for a PRIVATE demo repo (Railway)
//   node scripts/public-allowlist.ts --rehearse            copy ONLY allowlisted files into .tmp-test/clone, run typecheck + tests
//                                                          there (offline), report, and delete the clone
//
// A problem is: a file in the tree that is not on the list; a scratch/session path in a listed file; or a placeholder
// other than the three owner-only ones (licence holder, demo URL, repo creation date), which are listed explicitly.
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertWritable } from './safe-path.ts';

export interface Rule { re: RegExp; why: string }
/** Allowed public paths (relative, forward slashes). First match gives the reason. */
export const ALLOW: Rule[] = [
  { re: /^README\.md$/, why: 'project description, run and deploy instructions' },
  { re: /^LICENSE$/, why: 'open-source licence file the rules require (holder is an owner-only placeholder until supplied)' },
  { re: /^NOTICE$/, why: 'licence notice (only exists if the owner approves Apache-2.0)' },
  { re: /^package(-lock)?\.json$/, why: 'dependency manifest and lockfile for npm ci' },
  { re: /^tsconfig\.json$/, why: 'typecheck configuration' },
  { re: /^wrangler\.toml$/, why: 'Cloudflare Workers configuration (fallback host)' },
  { re: /^\.gitignore$/, why: 'keeps keys, recordings and Qloo data out of the repo' },
  { re: /^(Dockerfile|\.dockerignore|railway\.json)$/, why: 'container/Railway start configuration (no secrets)' },
  { re: /^\.dev\.vars\.example$/, why: 'template for local settings (no values)' },
  { re: /^src\/.+\.ts$/, why: 'application source (required to run)' },
  { re: /^deploy\/[^/]+\.ts$/, why: 'hosting entry points and the owner smoke app' },
  { re: /^scripts\/[^/]+\.(ts|sh)$/, why: 'run, test, probe, presubmit and deploy-check scripts' },
  { re: /^test\/.+\.(ts|mjs|json)$/, why: 'tests, fakes and synthetic fixtures (required for npm test)' },
  { re: /^docs\/replay-screenshot\.png$/, why: 'screenshot of the static synthetic replay, shown in the README' },
  { re: /^docs\/(QLOO-NOTES|REQUEST-TO-RESULT\.MOCK-SAMPLE|FIXTURES|THIRD-PARTY-AND-PROVENANCE|DEPLOY-RAILWAY|IPHONE-DEMO-INSTRUCTIONS)\.md$/, why: 'documentation the README and judges rely on' },
  { re: /^docs\/test-counts\.json$/, why: 'last real test and mutation counts (checked against the docs)' },
  { re: /^prereg\/validity-prereg\.template\.json$/, why: 'empty pre-registration template used by the validity scripts and tests' },
];
/** Deliberately NOT public, with the reason (for the printout). */
/** Files copied ONLY into the private demo source (never published). */
export const PRIVATE_ONLY = ['docs/OWNER-RAILWAY-5-STEPS.md'];
export const EXCLUDED: Rule[] = [
  { re: /^docs\/OWNER-RAILWAY-5-STEPS\.md$/, why: 'private-only owner checklist (goes into the private demo source, not the public repo)' },
  { re: /^prereg\/.*CANDIDATE/, why: 'unsealed candidate pre-registration (private planning)' },
  { re: /^BUILD-LOG\.md$/, why: 'internal build log' },
  { re: /^docs\/PILOT-PLAN\.md$/, why: 'internal plan, not needed to run the entry' },
  { re: /^docs\/LICENSE-CANDIDATES\//, why: 'unapplied licence candidates (decision pending)' },
  { re: /^eval-output\//, why: 'local generated output' },
  { re: /^\.tmp-test\//, why: 'temporary test output' },
  { re: /^\.private\//, why: 'private recordings' },
  { re: /^\.dev\.vars$/, why: 'local secrets' },
  { re: /^node_modules\//, why: 'installed by npm ci' },
];
const SKIP_DIRS = new Set(['node_modules', '.git', '.tmp-test', 'eval-output', '.private', '.wrangler', 'dist']);

export const OWNER_ONLY: { id: string; re: RegExp }[] = [
  { id: 'licence holder (LICENSE)', re: /\[LICENSE HOLDER[^\]]*\]/g },
  { id: 'hosted demo URL (README)', re: /\[OWNER: the hosted demo URL[^\]]*\]/g },
  { id: 'repo creation date (README)', re: /\[OWNER TO FILL IN before publishing: the date[^\]]*\]/g },
];
const BLOCKING = /\[OWNER|\[LIVE-GATED|\[COPYRIGHT HOLDER|\[BLOCKED|PASTE_ID_HERE|\bTODO\b|FILL AFTER LIVE RUN/;
const SCRATCH = /\/tmp\/claude-0\/|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/scratchpad/;
const TEXT = /\.(md|ts|mjs|json|toml|sh|example|txt)$|^LICENSE$|^NOTICE$|^\.gitignore$/;
// Files that legitimately contain the marker words as patterns/examples are not scanned for placeholders.
const PATTERN_FILES = /^(scripts\/(public-allowlist|check-doc-counts|presubmit-check|presubmit-live|presubmit-repo|predeploy-check|mutate-guards)\.|test\/)/;

export interface Entry { path: string; size: number; sha256: string; why: string }
export interface Report { files: Entry[]; unlisted: { path: string; why: string }[]; keptOut: { path: string; why: string }[]; scratch: string[]; blocking: string[]; ownerOnly: { id: string; where: string }[] }

function walk(root: string): string[] {
  const out: string[] = [];
  const rec = (dir: string) => {
    for (const n of readdirSync(dir)) {
      if (SKIP_DIRS.has(n)) continue;
      const p = join(dir, n);
      if (lstatSync(p).isDirectory()) rec(p); else out.push(relative(root, p).split(sep).join('/'));
    }
  };
  rec(root);
  return out.sort();
}

export function scanPublic(root: string): Report {
  const rep: Report = { files: [], unlisted: [], keptOut: [], scratch: [], blocking: [], ownerOnly: [] };
  for (const rel of walk(root)) {
    const rule = ALLOW.find((r) => r.re.test(rel));
    const ex = EXCLUDED.find((r) => r.re.test(rel));
    if (!rule) { (ex ? rep.keptOut : rep.unlisted).push({ path: rel, why: ex?.why ?? 'not on the allowlist' }); continue; }
    const buf = readFileSync(join(root, rel));
    rep.files.push({ path: rel, size: buf.length, sha256: createHash('sha256').update(buf).digest('hex'), why: rule.why });
    if (!TEXT.test(rel)) continue;
    let text = buf.toString('utf8');
    text.split('\n').forEach((line, i) => { if (SCRATCH.test(line) && !/^scripts\/public-allowlist|^scripts\/check-doc-counts|^test\//.test(rel)) rep.scratch.push(`${rel}:${i + 1}`); });
    for (const o of OWNER_ONLY) { for (const _ of text.matchAll(o.re)) rep.ownerOnly.push({ id: o.id, where: rel }); text = text.replace(o.re, ''); }
    if (!PATTERN_FILES.test(rel)) text.split('\n').forEach((line, i) => { if (BLOCKING.test(line)) rep.blocking.push(`${rel}:${i + 1}: ${line.trim().slice(0, 100)}`); });
  }
  return rep;
}

export function problems(r: Report, strict = false): string[] {
  return [...(strict ? r.keptOut : []).map((u) => `NOT ON LIST: ${u.path} (${u.why})`), ...r.unlisted.map((u) => `NOT ON LIST: ${u.path} (${u.why})`), ...r.scratch.map((s) => `SCRATCH PATH: ${s}`), ...r.blocking.map((b) => `PLACEHOLDER: ${b}`)];
}

export function inventoryMarkdown(r: Report): string {
  const total = r.files.reduce((n, f) => n + f.size, 0);
  const L = ['# Public file inventory (generated by scripts/public-allowlist.ts; do not edit by hand)', '', `<!-- current --> ${r.files.length} files, ${total} bytes. Generated from the allowlist; a file not listed here is not published.`, '', '| path | bytes | sha256 | why required |', '|---|---|---|---|'];
  for (const f of r.files) L.push(`| \`${f.path}\` | ${f.size} | \`${f.sha256.slice(0, 16)}...\` | ${f.why} |`);
  L.push('', '## Owner-only placeholders still in the tree (expected until the owner supplies them)');
  for (const o of r.ownerOnly) L.push(`- ${o.id}: ${o.where}`);
  L.push('', '## Deliberately excluded (present in the working folder, not published)', ...r.keptOut.map((k) => `- \`${k.path}\`: ${k.why}`));
  L.push('', '## Excluded patterns', ...EXCLUDED.map((e) => `- \`${e.re.source}\`: ${e.why}`));
  const p = problems(r);
  L.push('', `## Problems blocking publication (${p.length})`, ...(p.length ? p.map((x) => `- ${x}`) : ['- none']));
  return L.join('\n') + '\n';
}

/** Copy only allowlisted files into <root>/.tmp-test/<name>; refuses anything else. */
export function stage(root: string, name = 'clone'): string {
  const dest = resolve(root, '.tmp-test', name);
  if (!dest.startsWith(resolve(root, '.tmp-test') + sep)) throw new Error('refusing to stage outside .tmp-test');
  rmSync(dest, { recursive: true, force: true });
  for (const f of scanPublic(root).files) { const to = join(dest, f.path); mkdirSync(dirname(to), { recursive: true }); cpSync(join(root, f.path), to); }
  return dest;
}

/** Private-demo source folder: the same allowlisted files plus a short README, written ONLY to an empty/nonexistent folder. */
export function stagePrivate(root: string, dest: string): string[] {
  // returns the allowlisted paths; the private-only files and RAILWAY-README.txt are added on top
  const d = assertWritable(dest);
  if (existsSync(d) && readdirSync(d).length) throw new Error(`refusing to stage into a non-empty folder: ${d}`);
  const files = scanPublic(root).files;
  for (const f of files) { const to = join(d, f.path); mkdirSync(dirname(to), { recursive: true }); cpSync(join(root, f.path), to); }
  for (const rel of PRIVATE_ONLY) { const from = join(root, rel); if (existsSync(from)) { const to = join(d, rel); mkdirSync(dirname(to), { recursive: true }); cpSync(from, to); } }
  writeFileSync(join(d, 'RAILWAY-README.txt'), 'Private demo source. Create a NEW private repository from this folder, connect it to a NEW Railway project, and follow docs/DEPLOY-RAILWAY.md.\nDo not add .dev.vars, .private, .data or any recorded Qloo data. Set DEMO_ACCESS_TOKEN in the Railway dashboard only.\n');
  return files.map((f) => f.path);
}

function rehearse(root: string): number {
  const dest = stage(root);
  try {
    symlinkSync(join(root, 'node_modules'), join(dest, 'node_modules'));
    const run = (label: string, cmd: string, args: string[]) => {
      const r = spawnSync(cmd, args, { cwd: dest, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME }, maxBuffer: 64 << 20 });
      const tail = (r.stdout + r.stderr).trim().split('\n').slice(-2).join(' | ');
      console.log(`  ${r.status === 0 ? 'OK  ' : 'FAIL'} ${label}: ${tail.slice(0, 160)}`);
      return r.status === 0;
    };
    console.log(`clean-clone rehearsal in ${relative(root, dest)} (${scanPublic(root).files.length} allowlisted files, no network):`);
    const ok1 = run('typecheck', process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json']);
    const ok2 = run('npm test', process.execPath, ['scripts/run-tests.ts']);
    return ok1 && ok2 ? 0 : 1;
  } finally { rmSync(dest, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const args = process.argv.slice(2);
  const rep = scanPublic(root);
  console.log(`Would publish ${rep.files.length} files (${rep.files.reduce((n, f) => n + f.size, 0)} bytes). Dry run: nothing is created, copied or pushed.`);
  for (const f of rep.files) console.log(`  ${f.path}  (${f.size} B)`);
  console.log(`Kept out on purpose (${rep.keptOut.length}): ${rep.keptOut.map((k) => k.path).join(', ') || 'none'}`);
  console.log('Owner-only placeholders (expected until supplied):');
  for (const id of OWNER_ONLY.map((o) => o.id)) console.log(`  ${id}: ${rep.ownerOnly.some((o) => o.id === id) ? 'STILL PRESENT' : 'filled'}`);
  let code = 0;
  const p = problems(rep, args.includes('--strict'));
  if (p.length) { console.log(`PROBLEMS (${p.length}):`); p.forEach((x) => console.log('  ' + x)); code = 1; } else console.log('No problems found.');
  const inv = args.indexOf('--inventory');
  if (inv >= 0 && args[inv + 1]) { const out = assertWritable(args[inv + 1]!); writeFileSync(out, inventoryMarkdown(rep)); console.log(`wrote ${out}`); }
  const sp = args.indexOf('--stage-private');
  if (sp >= 0 && args[sp + 1]) { const n = stagePrivate(root, args[sp + 1]!); console.log(`staged ${n.length} allowlisted files + the private-only checklist + RAILWAY-README.txt into ${args[sp + 1]} (nothing pushed, no repo created)`); }
  if (args.includes('--rehearse')) code = Math.max(code, rehearse(root));
  process.exit(code);
}
