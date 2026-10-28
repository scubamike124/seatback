// Pre-submit check for the Devpost text and the screenshots meant for upload.
//
//   npm run presubmit                      (defaults below)
//   npm run presubmit -- <text-file> [--shots <dir>] [--shots <dir2>]
//
// Exits 1 and prints every problem left (file, line, what) if the text still carries a fill
// marker, a placeholder, an unchosen PASS/FAIL variant, a "(synthetic)" label or a TODO, or if the
// screenshot folder is missing, empty, or contains anything labelled synthetic. Exits 0 only when
// nothing is left. It reads text and file names only: it cannot see inside an image, so look at
// each screenshot (banner, pill, any key) before uploading.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkDocCounts, loadCounts } from './check-doc-counts.ts';

export interface Finding {
  rule: string;
  where: string;
  detail: string;
}

interface Rule {
  rule: string;
  re: RegExp;
  why: string;
}

/** Text rules, each tested per line. Brackets are handled separately (links are allowed). */
const TEXT_RULES: Rule[] = [
  { rule: 'fill-marker', re: /FILL AFTER LIVE RUN/, why: 'unresolved "FILL AFTER LIVE RUN" block' },
  { rule: 'end-fill', re: /END FILL/, why: 'leftover "END FILL" marker' },
  { rule: 'open-marker', re: />>>/, why: 'leftover ">>>" marker' },
  { rule: 'close-marker', re: /<<</, why: 'leftover "<<<" marker' },
  { rule: 'variant', re: /\b(PASS|FAIL)\s+version\b|^\s*(?:[-*]\s*)?(PASS|FAIL)\s*\(|^\s*(?:[-*]\s*)?(NOT\s+)?WARMED(\s+LIVE)?\s*:|keep exactly one/i, why: 'unchosen PASS/FAIL (or WARMED/NOT WARMED) variant' },
  { rule: 'synthetic', re: /\(synthetic\)/i, why: '"(synthetic)" label in text meant for submission' },
  { rule: 'todo', re: /\bTODO\b/, why: 'TODO marker' },
  { rule: 'secret', re: /AIza[0-9A-Za-z_-]{30,}|\b(QLOO_API_KEY|GEMINI_API_KEY|ADMIN_TOKEN)\s*[=:]\s*["']?[A-Za-z0-9_-]{12,}/, why: 'something that looks like a key (value not shown)' },
];

/** A [bracketed] span that is a placeholder, not a markdown link, a task box or a footnote number. */
export function bracketPlaceholders(line: string): string[] {
  const out: string[] = [];
  for (const m of line.matchAll(/\[([^\]\n]{1,80})\](?!\(|:)/g)) {
    const inner = m[1]!;
    if (inner === ' ') continue; // markdown task box (empty)
    if (/^\d{1,3}$/.test(inner)) continue; // footnote number
    out.push(m[0]);
  }
  return out;
}

export function checkText(text: string, name: string): Finding[] {
  const found: Finding[] = [];
  text.split('\n').forEach((line, i) => {
    const where = `${name}:${i + 1}`;
    for (const r of TEXT_RULES) {
      if (r.re.test(line)) found.push({ rule: r.rule, where, detail: r.rule === 'secret' ? r.why : `${r.why}: ${clip(line)}` });
    }
    for (const b of bracketPlaceholders(line)) found.push({ rule: 'placeholder', where, detail: `unfilled placeholder ${b}` });
  });
  return found;
}

const IMAGE = /\.(png|jpe?g|webp|gif)$/i;

export function checkShots(dir: string): Finding[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [{ rule: 'shots-missing', where: dir, detail: 'screenshot folder does not exist' }];
  const found: Finding[] = [];
  let images = 0;
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (/synthetic/i.test(e.name)) found.push({ rule: 'synthetic', where: p, detail: 'file or folder name says synthetic: not for upload' });
      if (e.isDirectory()) walk(p);
      else if (IMAGE.test(e.name)) images++;
      else if (/\.(txt|md|json|csv)$/i.test(e.name)) found.push(...checkText(readFileSync(p, 'utf8'), p).filter((f) => f.rule === 'synthetic' || f.rule === 'secret' || f.rule === 'fill-marker'));
    }
  };
  if (/synthetic/i.test(basename(resolve(dir)))) found.push({ rule: 'synthetic', where: dir, detail: 'folder name says synthetic: not for upload' });
  walk(dir);
  if (images === 0) found.push({ rule: 'shots-empty', where: dir, detail: 'no screenshots in the folder' });
  return found;
}

export function formatReport(findings: Finding[], checked: string[]): string {
  if (!findings.length) return `presubmit OK: nothing left in ${checked.join(', ')}.\nStill look at every screenshot yourself (banner, LIVE pill, no key); this check cannot read images.`;
  const by = new Map<string, Finding[]>();
  for (const f of findings) by.set(f.rule, [...(by.get(f.rule) ?? []), f]);
  const lines = [`presubmit FAILED: ${findings.length} thing(s) left in ${checked.join(', ')}`];
  for (const [rule, list] of by) {
    lines.push('', `${rule} (${list.length})`);
    for (const f of list) lines.push(`  ${f.where}  ${f.detail}`);
  }
  lines.push('', 'Fix each item above, then run this again. It must print "presubmit OK".');
  return lines.join('\n');
}

function clip(s: string): string {
  const t = s.trim();
  return t.length > 90 ? `${t.slice(0, 87)}...` : t;
}

/** Run the check for a text file and screenshot folders. Returns the process exit code. */
export function runCheck(textFile: string, shotDirs: string[], print: (s: string) => void = console.log): number {
  const findings: Finding[] = [];
  if (!existsSync(textFile)) findings.push({ rule: 'text-missing', where: textFile, detail: 'final submission text file not found: save the filled text there, or pass its path' });
  else {
    const text = readFileSync(textFile, 'utf8');
    if (!text.trim()) findings.push({ rule: 'text-missing', where: textFile, detail: 'file is empty' });
    findings.push(...checkText(text, textFile));
    const counts = loadCounts();
    if (Object.keys(counts).length) for (const c of checkDocCounts(textFile, counts).findings) findings.push({ rule: 'stale-count', where: `${textFile}:${c.line}`, detail: `states ${c.stated}, the last real run had ${c.actual}` });
  }
  for (const d of shotDirs) findings.push(...checkShots(d));
  print(formatReport(findings, [textFile, ...shotDirs]));
  return findings.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const shots: string[] = [];
  const files: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--shots' && args[i + 1]) shots.push(args[++i]!);
    else files.push(args[i]!);
  }
  const root = fileURLToPath(new URL('..', import.meta.url));
  const text = files[0] ?? resolve(root, '../seatback-internal/FINAL-DEVPOST-TEXT.md');
  const dirs = shots.length ? shots : [resolve(root, '../seatback-internal/screenshots-LIVE')];
  process.exit(runCheck(text, dirs));
}
