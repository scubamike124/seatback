// Guards for the facts read from the official Devpost rules (the official rules page, fetched 2026-10-25).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from './helpers/tmp.ts';
import { fileURLToPath } from 'node:url';
import { checkStaleRules } from '../scripts/check-doc-counts.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const work = join(root, '..'); // the competition working folder, absent in the published repo

test('stale or unsupported rules claims are found; sourced history lines are not', () => {
  const d = mkdtempSync(join(tmpdir(), 'rules-'));
  try {
    const f = join(d, 'doc.md');
    writeFileSync(f, [
      'Judging Nov 2 to 16, winners about Nov 23.',
      'The date must fall in Sep 30 to Oct 30, 2026.',
      '[OWNER TO CONFIRM: how long the demo must stay up]',
      'The official rules page returned 403 and was NOT READ.',
      'Judging runs Nov 2 to Nov 5, 2026.',
      'Secondary sources said judging ran Nov 2 to 16; that was wrong.',
    ].join('\n'));
    assert.deepEqual(checkStaleRules(f).map((x) => x.line), [1, 1, 2, 3, 4]);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('README states the verified demo duration and does not leave the uptime question open', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  assert.match(readme, /until the Judging Period ends \(Nov 5, 2026, 11:45 pm ET\)/);
  assert.ok(!/how long the demo must stay up/i.test(readme));
});

test('every verbatim rules quote in OFFICIAL-RULES-VERIFIED.md occurs in the saved snapshot', { skip: !existsSync(join(work, 'research', 'OFFICIAL-RULES-VERIFIED.md')) && 'working folder not present (published repo)' }, () => {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  const doc = readFileSync(join(work, 'research', 'OFFICIAL-RULES-VERIFIED.md'), 'utf8');
  const snap = norm(readFileSync(join(work, 'research', 'DEVPOST-RULES-SNAPSHOT-2026-10-25.txt'), 'utf8'));
  const quotes = [...doc.matchAll(/Q: "([^"]+)"/g)].map((m) => norm(m[1]!));
  assert.ok(quotes.length >= 30, `expected at least 30 quotes, found ${quotes.length}`);
  for (const q of quotes) assert.ok(snap.includes(q), `quote not in snapshot: ${q.slice(0, 80)}`);
  for (const must of ['11:45 pm Eastern Time', 'November 5, 2026', 'equally weighted', 'free of charge and without any restriction', 'agentic tool']) {
    assert.ok(quotes.some((q) => q.includes(must)), `the facts file must quote: ${must}`);
  }
});
