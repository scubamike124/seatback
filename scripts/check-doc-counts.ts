// Fails when a document states a test or mutation count that differs from the last real run.
// Counts come from docs/test-counts.json, written by `npm test` (scripts/run-tests.ts) and `node scripts/mutate-guards.ts`.
//   node scripts/check-doc-counts.ts [file ...]              check (default: the submission-facing files); exit 1 on a stale [current] count
//                                                            or on an UNTAGGED count sentence in those files
//   node scripts/check-doc-counts.ts --fix [file ...]        DRY RUN: show what would change
//   node scripts/check-doc-counts.ts --fix --write [file ...]  rewrite ONLY sentences tagged [current] in submission-facing, non-log files
// Tags: [current] or <!-- current -->  checked and fixable; [history] or <!-- history -->  never checked, never written (see the DESIGN note below).
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Counts { files?: number; tests?: number; pass?: number; skipped?: number; workspacePass?: number; workspaceSkipped?: number; publicPass?: number; publicSkipped?: number; mutations?: number; killed?: number; fail?: number; publishedFiles?: number }
export interface CountFinding { file: string; line: number; stated: string; actual: string; kind?: 'untagged'; col?: number }
/** Only used by the stale-call-figure check below (not by the count check). */
const HISTORY = /\b(round \d|before|was|were|earlier|previously|from \d+ to|baseline)\b|->/i;

/** [pattern, key]. The first capture group is the number to compare. Forms: "N tests", "N test files", "N files", "N pass/passed/passing", "N skipped/skips/skip",
 *  "N mutations", "N killed", "N published/allowlisted/public files|paths", the generated "N files, M bytes", and (below) "N of M mutations" and "N/M" pairs. */
const PATTERNS: [RegExp, keyof Counts][] = [
  [/\b(\d+) (?:test )?files?\b(?!, \d+ bytes)/g, 'files'],
  [/\bAll (\d+) test files passed/g, 'files'],
  [/\b(\d+) tests?\b(?! (?:files?|per|in the|that|which))/g, 'tests'],
  [/\b(\d+) passing (?:assertions|tests)/g, 'tests'],
  [/\b(\d+) pass(?:ed)?\b/g, 'pass'],
  [/\b(\d+) passing\b(?! (?:assertions|tests))/g, 'pass'],
  [/\b(\d+) skip(?:s|ped|ping)?\b/g, 'skipped'],
  [/\b(\d+) (?:one-line )?mutations\b/g, 'mutations'],
  [/\b(\d+) killed\b/g, 'killed'],
  [/\b(\d+) (?:fail|failed|failing|failures?)\b/g, 'fail'],
  [/\b(\d+) (?:published|allowlisted|public) (?:files|paths)\b/g, 'publishedFiles'],
  [/\b(\d+) files, \d+ bytes\b/g, 'publishedFiles'],
];
/** "57 of 57" in a clause about mutations: both numbers are the mutation count. */
const OF_PAIR = /\b(\d+) of (\d+)\b/g;
/** "434/9" (pass/skipped) or, in a clause about mutations, "105/105" (killed/mutations). Only count-shaped pairs: the first number at least 100 and the second at most 100. */
const SLASH_PAIR = /(?<![\d\/.])(\d{3,})\/(\d{1,3})(?![\w\/])/g;
const MUTATION_LINE = /\bmutations?\b|killed|caught/i;

/** 'agent' used as a product claim must carry the qualifier (no-LLM scripted workflow / LLM planner when configured). */
const AGENT = /(?<![\/\w.-])agents?\b(?![\/-]|\.ts)/i;
const AGENT_OK = /no[- ]LLM|scripted|when an LLM|LLM is configured|LLM planner|LLM configured|not an agent|workflow|user agent|User-Agent|Agentic Hackathon|agentic/i;

/** Session scratch paths (and their random session ids) must never appear in submission-facing docs. */
const SCRATCH = /\/tmp\/claude-0\/|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/scratchpad/;
export function checkScratchPaths(file: string): CountFinding[] {
  const out: CountFinding[] = [];
  readFileSync(file, 'utf8').split('\n').forEach((line, i) => { if (SCRATCH.test(line)) out.push({ file, line: i + 1, stated: 'a scratchpad/session path', actual: 'use "<working folder>" or a repo-relative path' }); });
  return out;
}

/** Claims about the event that the official rules (fetched 2026-10-25) contradict or never made. */
const STALE_RULE: [RegExp, string][] = [
  [/Nov(?:ember)? 2 (?:to|-|–) (?:Nov(?:ember)? )?16\b/i, 'judging runs Nov 2 to Nov 5, 2026 (not Nov 16)'],
  [/winners?[^.\n]{0,40}(?:Nov(?:ember)? 23|23 Nov)/i, 'winners are announced on or around Nov 5, 2026 (not Nov 23)'],
  [/must fall in Sep 30 to Oct 30/i, 'the rules do not require the repository creation date to fall in the period'],
  [/how long the demo must stay up/i, 'the rules say: until the Judging Period ends (Nov 5, 2026, 11:45 pm ET)'],
  [/official (?:Devpost )?rules(?: page| text)?[^.;\n]{0,30}(?:returned 403|NOT READ|unread)/i, 'the official rules page was read on 2026-10-25'],
];
const STALE_OK = /superseded|corrected|\bwrong\b|stale|no longer|used to say|earlier (?:note|draft)|secondary (?:sources? )?(?:said|gave|reported)/i;
export function checkStaleRules(file: string): CountFinding[] {
  const out: CountFinding[] = [];
  readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    if (STALE_OK.test(line)) return;
    for (const [re, fix] of STALE_RULE) if (re.test(line)) out.push({ file, line: i + 1, stated: 'a rules claim the official text contradicts', actual: fix });
  });
  return out;
}

/** Owner facts: registered, key application SUBMITTED. No doc may tell the owner to do those again. */
const STALE_OWNER = /\bjoin the hackathon\b|request the key today|submit the (?:official |Qloo |API |key )*(?:form|request|application)|apply for (?:a|the|an) (?:Qloo |hackathon )?(?:API )?key|owner must request|request (?:a|the|your) (?:Qloo )?(?:API )?key|key application is pending|ask for (?:a|the) key/i;
const STALE_OWNER_OK = /\bDONE\b|already|submitted|reapplied|awaiting|awaited|not needed|registered|if no key|resubmit|do not|never/i;
export function checkOwnerFacts(file: string): CountFinding[] {
  const out: CountFinding[] = [];
  readFileSync(file, 'utf8').split('\n').forEach((line, i) => { if (STALE_OWNER.test(line) && !STALE_OWNER_OK.test(line)) out.push({ file, line: i + 1, stated: 'tells the owner to register or request the key again', actual: 'say: registered; key application submitted 2026-10-25, awaiting key (STATUS.md)' }); });
  return out;
}

/** "agentic" may name the hackathon; as a claim about this product it needs a live planner trace (R9), so it must be conditional. */
const AGENTIC_OK = /Agentic Hackathon|Agentic Track|\[LIVE-GATED|LLM planner|when an LLM|LLM is configured|live planner trace|not agentic|until a live|only if|R8|R11|R9|conditional|must be agentic/i;
export function checkAgenticClaims(file: string): CountFinding[] {
  const out: CountFinding[] = [];
  readFileSync(file, 'utf8').split('\n').forEach((line, i) => { if (/agentic/i.test(line) && !AGENTIC_OK.test(line)) out.push({ file, line: i + 1, stated: 'an unconditional "agentic" claim', actual: 'make it conditional on a live planner trace (LLM planner, when an LLM is configured)' }); });
  return out;
}

/** The pre-reduction call figure is stale; current mock-measured figures are examples 82-98, custom runs 55-58, replays 0. */
const STALE_CALLS = /\b13[01]\s*(?:-|–|to|and)\s*19[0-2]\b|\b19[0-2] (?:Qloo )?calls\b/i;
export function checkStaleCalls(file: string): CountFinding[] {
  const out: CountFinding[] = [];
  readFileSync(file, 'utf8').split('\n').forEach((line, i) => { if (STALE_CALLS.test(line) && !HISTORY.test(line)) out.push({ file, line: i + 1, stated: 'the stale "130-190 calls" figure', actual: 'current mock-measured: examples 82-98, custom runs 55-58, replays 0' }); });
  return out;
}

export function checkAgentWording(file: string): CountFinding[] {
  const out: CountFinding[] = [];
  readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    if (AGENT.test(line) && !AGENT_OK.test(line)) out.push({ file, line: i + 1, stated: 'the word "agent" without a qualifier', actual: 'say "scripted workflow (no LLM)" or "LLM planner (when an LLM is configured)"' });
  });
  return out;
}

/** DESIGN (inverted after two reviews found endless date/phrase variants that still got rewritten): nothing is written by default and
 *  no wording heuristic decides what is history. A sentence that states a test/file/mutation count must carry an explicit tag:
 *    [current]  (or <!-- current -->)  the count is checked against the last real run, and only such a sentence is ever rewritten by --fix --write;
 *    [history]  (or <!-- history -->)  a record of a past run: never checked, never rewritten.
 *  A tag inside a sentence tags that sentence; a tag that opens a line (after list/table marks) tags every untagged sentence on that line.
 *  In the fixed list of submission-facing files an untagged count sentence is an ERROR (file:line). Log files (STATUS, BUILD-LOG, ...) and
 *  history sections/blocks are never checked or written. */
export const HISTORY_FILE = /(^|[\\/])(STATUS|BUILD-LOG|OVERNIGHT-[^\\/]*|READINESS-[^\\/]*|CHANGES-[^\\/]*|INDEPENDENT-REVIEW[^\\/]*|REPO-REVIEW[^\\/]*|JUDGE-REVIEW|RESEARCH-AND-SELECTION|PUBLIC-SAFETY-PROPOSAL|PUBLIC-DEMO-CONTROLS-NOTES|[^\\/]*-AUDIT|[^\\/]*-REPORT[^\\/]*)\.md$/i;
const HISTORY_HEADING = /^(#{1,6})\s+.*\b(?:history|archive|changelog|superseded|old\b|previous|prior|earlier|legacy)/i;
export function isHistoryFile(file: string): boolean { return HISTORY_FILE.test(file); }
/** true for each line inside a history file, a history block (<!-- history:start --> ... <!-- history:end -->) or a history section (a heading naming history/old/previous/prior/earlier/legacy, until the next heading of the same or a higher level). */
export function historyMask(lines: string[], wholeFile = false): boolean[] {
  const mask: boolean[] = [];
  let level = 0, block = false;
  for (const line of lines) {
    if (/<!--\s*history:start\s*-->/i.test(line)) block = true;
    const h = /^(#{1,6})\s/.exec(line);
    if (h) { if (level && h[1]!.length <= level) level = 0; if (HISTORY_HEADING.test(line)) level = level || h[1]!.length; }
    mask.push(wholeFile || block || level > 0);
    if (/<!--\s*history:end\s*-->/i.test(line)) block = false;
  }
  return mask;
}
interface Tok { key: keyof Counts | 'pair'; start: number; end: number; n: number; m?: number; kind: 'num' | 'of' | 'slash' }
/** Every count the check knows about in a clause, with exact character positions (only the number itself is ever rewritten). */
function tokens(text: string): Tok[] {
  const out: Tok[] = [];
  const mut = MUTATION_LINE.test(text);
  for (const [re, key] of PATTERNS) for (const m of text.matchAll(new RegExp(re.source, 'gd'))) {
    const [s, e] = (m as RegExpMatchArray & { indices: [number, number][] }).indices[1]!;
    const n = Number(m[1]); if (key === 'files' && n < 5) continue; // "3 test files named LIVE-..." style phrases
    out.push({ key, start: s, end: e, n, kind: 'num' });
  }
  if (mut) for (const m of text.matchAll(new RegExp(OF_PAIR.source, 'gd'))) { const ix = (m as RegExpMatchArray & { indices: [number, number][] }).indices; out.push({ key: 'pair', start: ix[0]![0], end: ix[0]![1], n: Number(m[1]), m: Number(m[2]), kind: 'of' }); }
  for (const m of text.matchAll(new RegExp(SLASH_PAIR.source, 'gd'))) {
    const ix = (m as RegExpMatchArray & { indices: [number, number][] }).indices;
    if (Number(m[2]) > (mut ? 999 : 100)) continue;
    out.push({ key: 'pair', start: ix[0]![0], end: ix[0]![1], n: Number(m[1]), m: Number(m[2]), kind: 'slash' });
  }
  return out.sort((a, b) => a.start - b.start);
}
/** Character ranges that never count as markup: inline code (`...`), double-quoted text and curly-quoted text. A tag inside them is only text. */
function quotedRanges(line: string): [number, number][] {
  const out: [number, number][] = [];
  for (const re of [/`[^`]*`/g, /"[^"]*"/g, /“[^”]*”/g]) for (const m of line.matchAll(re)) out.push([m.index!, m.index! + m[0].length]);
  return out;
}
const TAG_RE = /\[current\]|\[history\]|<!--\s*(?:current|history)\s*-->/gi;
/** Clause boundaries: a clause ends at a full stop or semicolon followed by space or the end of the line, and a parenthesis opens or closes a clause of its own. */
function clauseBounds(line: string): number[] {
  const cuts: number[] = [0];
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if ((c === '.' || c === ';') && (i + 1 === line.length || /\s/.test(line[i + 1]!)) && !/\b(?:Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)$/.test(line.slice(Math.max(0, i - 4), i))) cuts.push(i + 1);
    else if (c === '(') cuts.push(i);
    else if (c === ')') cuts.push(i + 1);
  }
  cuts.push(line.length);
  return [...new Set(cuts)].sort((a, b) => a - b);
}

export function checkDocCounts(file: string, counts: Counts, fix = false, strict = false): { findings: CountFinding[]; text: string } {
  const lines = readFileSync(file, 'utf8').split('\n');
  const findings: CountFinding[] = [];
  const hist = historyMask(lines, isHistoryFile(file));
  let fence = false;
  const out = lines.map((line, i) => {
    if (/^\s*```/.test(line)) { fence = !fence; return line; }
    if (hist[i]) return line; // history files, sections and blocks are never checked and never rewritten
    const quoted = fence ? [[0, line.length] as [number, number]] : quotedRanges(line);
    const inQuote = (idx: number) => quoted.some(([a, b]) => idx >= a && idx < b);
    const tags = [...line.matchAll(TAG_RE)].filter((t) => !inQuote(t.index!)).map((t) => ({ at: t.index!, hist: /history/i.test(t[0]) }));
    const bounds = clauseBounds(line);
    const edits: { start: number; end: number; to: string }[] = [];
    let carry = ''; // public/workspace context set in one clause also covers the next one when the line was split at a semicolon, never across a full stop
    for (let c = 0; c + 1 < bounds.length; c++) {
      const cs = bounds[c]!, ce = bounds[c + 1]!;
      const text = line.slice(cs, ce);
      const own = /\b(?:public repo|fresh clone)\b/i.test(text) ? 'public' : /\bfull workspace\b/i.test(text) ? 'workspace' : '';
      const prevSemi = c > 0 && line[cs - 1] === ';';
      const ctx = own || (prevSemi ? carry : '');
      carry = ctx;
      const tok = tokens(text);
      if (!tok.length) continue;
      // The tag covers from itself to the end of ITS clause: counts before the tag, in the next sentence, after a semicolon or inside a parenthesis are not covered.
      const inClause = tags.filter((t) => t.at >= cs && t.at < ce);
      for (const t of tok) {
        const abs = cs + t.start;
        const tg = [...inClause].reverse().find((x) => x.at < abs);
        if (tg?.hist) continue;
        if (!tg) { if (strict) findings.push({ file, line: i + 1, stated: 'a count with no [current] or [history] tag in its clause', actual: 'put [current] or [history] before it in the same sentence or parenthesis', kind: 'untagged', col: cs }); continue; }
        const want = (k: keyof Counts) => counts[k];
        const pk = (base: 'Pass' | 'Skipped'): keyof Counts => (ctx ? (`${ctx}${base}` as keyof Counts) : (base === 'Pass' ? 'pass' : 'skipped'));
        if (t.kind === 'num') {
          const key = t.key as keyof Counts;
          const k2 = key === 'pass' ? pk('Pass') : key === 'skipped' ? pk('Skipped') : key;
          const w = want(k2);
          if (w === undefined || t.n === w) continue;
          findings.push({ file, line: i + 1, stated: `${t.n} ${key}`, actual: `${w}` });
          edits.push({ start: abs, end: cs + t.end, to: String(w) });
        } else if (t.kind === 'of') {
          if (counts.mutations === undefined || (t.n === counts.killed && t.m === counts.mutations)) continue;
          findings.push({ file, line: i + 1, stated: `${t.n} of ${t.m} mutations`, actual: `${counts.killed} of ${counts.mutations}` });
          edits.push({ start: abs, end: cs + t.end, to: `${counts.killed} of ${counts.mutations}` });
        } else { // slash pair: pass/skipped, or killed/mutations in a mutation clause
          const mut = MUTATION_LINE.test(text);
          const [a, b] = mut ? [counts.killed, counts.mutations] : [want(pk('Pass')), want(pk('Skipped'))];
          if (a === undefined || b === undefined || (t.n === a && t.m === b)) continue;
          findings.push({ file, line: i + 1, stated: `${t.n}/${t.m} ${mut ? 'killed/mutations' : 'pass/skipped'}`, actual: `${a}/${b}` });
          edits.push({ start: abs, end: cs + t.end, to: `${a}/${b}` });
        }
      }
    }
    if (!fix || !edits.length) return line;
    let l = line;
    for (const e of edits.sort((a, b) => b.start - a.start)) l = l.slice(0, e.start) + e.to + l.slice(e.end);
    return l;
  });
  return { findings, text: out.join('\n') };
}

/** Submission-facing docs: README, docs/*.md here, and (when present, in the working folder) the drafts and plans next to the repo. */
export function submissionDocs(root: string): string[] {
  const out: string[] = [];
  const add = (dir: string, names: string[]) => { for (const n of names) { const p = resolve(dir, n); if (existsSync(p)) out.push(p); } };
  add(root, ['README.md']);
  if (existsSync(resolve(root, 'docs'))) add(resolve(root, 'docs'), readdirSync(resolve(root, 'docs')).filter((n) => n.endsWith('.md')));
  const up = resolve(root, '..');
  add(up, ['PUBLIC-FILE-INVENTORY.md', 'FINAL-TEXT-DRAFT.md', 'SUBMISSION-PACKAGE-CHECKLIST.md', 'QLOO-KEY-BLOCKER-ANALYSIS.md', 'SUBMISSION-DRAFT.md', 'DEVPOST-SECTIONS-DRAFT.md', 'DEPLOY-PLAN.md', 'LIVE-RUNBOOK.md', 'KEY-ARRIVAL-PLAN.md', 'DEMO-SCRIPT.md', 'OWNER-SMOKE-DENO.md', 'JUDGE-WALKTHROUGH.md', 'OWNER-NEEDS.md', 'OWNER-DECISIONS.md', 'RULES-CHECK.md']);
  if (existsSync(resolve(up, 'JUDGE-PACKAGE'))) add(resolve(up, 'JUDGE-PACKAGE'), readdirSync(resolve(up, 'JUDGE-PACKAGE')).filter((n) => n.endsWith('.md')));
  return out;
}

export function loadCounts(root = fileURLToPath(new URL('..', import.meta.url))): Counts {
  const p = resolve(root, 'docs', 'test-counts.json');
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as Counts) : {};
}
export function saveCounts(patch: Counts, root = fileURLToPath(new URL('..', import.meta.url))): void {
  // BUILD-LOG.md is not published, so its presence means the full workspace; its absence means the public tree.
  if (patch.pass !== undefined && patch.skipped !== undefined) {
    const t = existsSync(resolve(root, 'BUILD-LOG.md')) ? 'workspace' : 'public';
    if (t === 'workspace') { patch.workspacePass = patch.pass; patch.workspaceSkipped = patch.skipped; } else { patch.publicPass = patch.pass; patch.publicSkipped = patch.skipped; }
  }
  writeFileSync(resolve(root, 'docs', 'test-counts.json'), JSON.stringify({ ...loadCounts(root), ...patch }, null, 2) + '\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  // --fix alone is a DRY RUN: it prints the lines it would change. Writing needs --fix --write, and only submission-facing,
  // non-history files are ever written (an explicit path outside that list is refused).
  const fix = args.includes('--fix');
  const write = args.includes('--write');
  if (write && !fix) { console.error('--write needs --fix'); process.exit(64); }
  const files = args.filter((a) => !a.startsWith('--'));
  const root = process.env.DOC_COUNTS_ROOT ? resolve(process.env.DOC_COUNTS_ROOT) : fileURLToPath(new URL('..', import.meta.url)); // DOC_COUNTS_ROOT is for tests
  const fixable = new Set(submissionDocs(root).filter((f) => !isHistoryFile(f)).map((f) => resolve(f)));
  if (!files.length) files.push(...submissionDocs(root));
  const counts = loadCounts(root);
  if (!Object.keys(counts).length) { console.error('No docs/test-counts.json: run npm test first.'); process.exit(2); }
  // The number of published files is read from the allowlist itself, never from a saved file.
  try { const { scanPublic } = await import('./public-allowlist.ts'); counts.publishedFiles = scanPublic(root).files.length; } catch { /* leave undefined: such a count is then not checked */ }
  let bad = 0, refused = 0, untagged = 0;
  for (const f of files) {
    for (const x of checkStaleCalls(resolve(f))) { bad++; console.log(`STALE-CALLS ${x.file}:${x.line}: ${x.stated}; ${x.actual}`); }
    for (const x of checkOwnerFacts(resolve(f))) { bad++; console.log(`STALE-OWNER-FACT ${x.file}:${x.line}: ${x.stated}; ${x.actual}`); }
    for (const x of /OWNER-DECISIONS|STATUS\.md/.test(f) ? [] : checkAgenticClaims(resolve(f))) { bad++; console.log(`AGENTIC ${x.file}:${x.line}: ${x.stated}; ${x.actual}`); }
    for (const x of checkScratchPaths(resolve(f))) { bad++; console.log(`SCRATCH-PATH ${x.file}:${x.line}: ${x.stated}; ${x.actual}`); }
    for (const x of checkStaleRules(resolve(f))) { bad++; console.log(`STALE-RULE ${x.file}:${x.line}: ${x.stated}; ${x.actual}`); }
    for (const x of checkAgentWording(resolve(f))) { bad++; console.log(`UNQUALIFIED ${x.file}:${x.line}: ${x.stated}; ${x.actual}`); }
    const r = checkDocCounts(resolve(f), counts, fix, fixable.has(resolve(f)));
    const canFix = fix && fixable.has(resolve(f));
    if (fix && !canFix && r.findings.some((x) => x.kind !== 'untagged')) { console.log(`REFUSED ${resolve(f)}: not a current submission-facing document (history files and files outside the list are never rewritten); edit by hand`); }
    if (canFix && write && r.findings.length) writeFileSync(resolve(f), r.text);
    for (const x of r.findings) {
      bad++;
      if (x.kind === 'untagged') { untagged++; console.log(`UNTAGGED ${x.file}:${x.line}: ${x.stated}; ${x.actual}`); continue; }
      if (fix && !canFix) refused++;
      const verb = !fix ? 'STALE' : !canFix ? 'REFUSED' : write ? 'fixed' : 'would fix';
      console.log(`${verb} ${x.file}:${x.line}: states ${x.stated}, last run had ${x.actual}`);
    }
  }
  console.log(bad ? (fix ? `check-doc-counts: ${write ? 'fixed' : 'would fix (dry run; add --write)'} ${bad}` : `check-doc-counts FAILED: ${bad} stale count(s)`) : 'check-doc-counts OK');
  process.exit((bad && !(fix && write)) || refused || untagged ? 1 : 0);
}
