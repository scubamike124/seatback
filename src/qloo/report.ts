/** REQUEST-TO-RESULT.md generator (kit submission guide: "a redacted request-to-result explanation,
 *  including any entity/tag choices"). Fed from a GuardedQlooClient trace plus resolution decisions. */
import { MODE_LABEL, type QlooHandle } from './client.ts';
import { redactSecrets } from './redact.ts';
import type { Resolution } from './resolve.ts';

export const LIMITATIONS = [
  'Entity and tag choices use a name-similarity heuristic; ambiguous matches are listed, not auto-picked.',
  'Affinity scores are Qloo relative scores for the queried location and signals, not audience counts.',
  'trending and demographics are not documented for the hackathon host; if absent they are reported as unavailable, never invented.',
  'Quota is unknown; every run is capped by a call budget and uses a private server-side cache.',
];
export const CLEAN_ENV_SETUP = [
  'Node >= 22.18. `npm ci` (only @types/node and typescript as dev dependencies).',
  'Copy `.dev.vars.example` to `.dev.vars` (gitignored). With QLOO_API_KEY empty the app runs on synthetic fixtures and labels every output as such.',
  'For LIVE: put the event-issued key in `.dev.vars` locally, or `npx wrangler secret put QLOO_API_KEY` for the Worker. Never commit it.',
  '`npm test` (all suites), `npm run dev` (local server). With a key, `CONTRACT_LIVE=1 node --test test/contract.test.ts` runs the contract suite against the live host.',
];

export function buildRequestToResult(h: QlooHandle, opts: { title?: string; choices?: Resolution[]; secrets?: (string | undefined)[]; outcome?: string; workflow?: string; plannerDecisions?: { step: number; action: string; reason: string; result: string; status: string }[] } = {}): string {
  const L: string[] = [];
  L.push(`# ${opts.title ?? 'Request to result'}`, '');
  L.push(`**Data mode: ${h.mode}.** ${MODE_LABEL[h.mode]}`, '');
  if (h.mode !== 'LIVE') L.push('> This file was generated from MOCK/dry-run data. It is a template. It must be regenerated in LIVE mode before submission (npm run presubmit:live refuses it otherwise).', '');
  L.push(`${h.counter.line(h.mode)}`, '', '## 1. Requests sent (redacted: the key travels in a header and is never recorded)', '');
  L.push('| # | call | path | parameters | mode | cached | results |', '|---|---|---|---|---|---|---|');
  for (const t of h.client.trace) {
    const params = Object.entries(t.params).map(([k, v]) => `${k}=${v}`).join('; ') || '-';
    L.push(`| ${t.n} | ${t.call} | ${t.path} | ${params.replace(/\|/g, '/')} | ${t.mode} | ${t.cached ? 'yes' : 'no'} | ${t.error ? `error: ${t.error.kind}` : t.unavailable ? t.unavailable : t.count} |`);
  }
  L.push('', '## 2. Entity and tag choices', '');
  if (!opts.choices?.length) L.push('No resolution steps recorded.');
  for (const r of opts.choices ?? []) {
    L.push(`- "${r.query}": **${r.status}**. ${r.note}`);
    for (const c of r.candidates.slice(0, 5)) L.push(`  - ${c.id === r.chosen?.id ? '(chosen) ' : ''}${c.name} [${c.id}] confidence ${c.confidence}`);
  }
  L.push('', '## 2b. Agent decisions (which step was chosen, why, and what Qloo returned)', '');
  if (opts.workflow) L.push(`Workflow: ${opts.workflow}.`, '');
  if (!opts.plannerDecisions?.length) L.push('No LLM planner decisions: this run used the scripted workflow (fixed rule), so there is nothing to explain beyond the requests in section 1.');
  for (const d of opts.plannerDecisions ?? []) L.push(`${d.step}. \`${d.action}\` (${d.status}). Stated reason: ${d.reason || '(none)'}. Result: ${d.result}`);
  L.push('', '## 3. Result', '', opts.outcome ?? 'See the trace above; ranked output is produced from these responses by the scripted workflow (no LLM), or by the LLM planner (the calls it chose) when an LLM is configured, with plain arithmetic scoring.');
  L.push('', '## 4. Limitations', '', ...LIMITATIONS.map((x) => `- ${x}`));
  L.push('', '## 5. Clean-environment setup', '', ...CLEAN_ENV_SETUP.map((x, i) => `${i + 1}. ${x}`), '');
  return redactSecrets(L.join('\n'), opts.secrets ?? []);
}
