// Mutation check on the critical guards. Copies the project into .tmp-test/mut/ (project-local, deleted
// afterwards), applies ONE small mutation at a time to the COPY, runs the relevant test files, and requires
// at least one failure ("killed"). A mutation that no test notices "survives" and fails this script.
//   node scripts/mutate-guards.ts
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { saveCounts } from './check-doc-counts.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const work = join(root, '.tmp-test', 'mut');
const T = ['test/gemini-fallback.test.ts', 'test/mobile-ux.test.ts', 'test/node-host.test.ts', 'test/caps.test.ts', 'test/hardening.test.ts', 'test/hardening2.test.ts', 'test/planner.test.ts', 'test/qloo-guard.test.ts', 'test/narrative.test.ts', 'test/failure-modes.test.ts', 'test/worker.test.ts', 'test/ambiguity-ui.test.ts'];
interface M { id: string; file: string; find: string; replace: string; tests?: string[] }
const M_: M[] = [
  { id: 'B4 retries not charged per attempt', file: 'src/qloo/http-client.ts', find: '        this.#onNetworkCall?.(path);\n        this.networkCalls++;', replace: '        this.networkCalls++;' },
  { id: 'B4 cache.put failure not swallowed', file: 'src/qloo/http-client.ts', find: '    } catch {\n      // swallow: the data is good, only the cache write failed\n    }', replace: '    } catch (e) {\n      throw e;\n    }' },
  { id: 'B3 call cap ignores global total', file: 'src/ratelimit.ts', find: 'if ((await this.#c.add(k.g, n, ttl)) > this.#daily)', replace: 'if ((await this.#c.add(k.g, n, ttl)) > Infinity)' },
  { id: 'B3 unused reservation not refunded', file: 'src/ratelimit.ts', find: 'const refund = Math.max(0, reserved - used);', replace: 'const refund = 0;' },
  { id: 'B3 kill switch removed', file: 'src/worker.ts', find: "if (env.LIVE_ENABLED !== '1') return json({ error: 'Custom live runs", replace: "if (false) return json({ error: 'Custom live runs" },
  { id: 'B3 singleflight removed', file: 'src/worker.ts', find: 'let p = inflightExamples.get(flightKey);', replace: 'let p: Promise<SlateResult | null> | undefined;' },
  { id: 'B3 disconnect not honoured at start', file: 'src/worker.ts', find: 'let aborted = request.signal?.aborted ?? false;', replace: 'let aborted = false;' },
  { id: 'S1 content-type check removed', file: 'src/worker.ts', find: "!/^application\\/json\\b/i.test(request.headers.get('content-type') ?? '')", replace: 'false' },
  { id: 'S1 origin check removed', file: 'src/worker.ts', find: 'if (origin && origin !== url.origin)', replace: 'if (false)' },
  { id: 'S2 personal lines not dropped', file: 'src/worker.ts', find: 'if (personalDataIn(line).length) droppedPersonalLines++;', replace: 'if (false) droppedPersonalLines++;' },
  { id: 'S4 recencyYear not clamped', file: 'src/worker.ts', find: 'Math.max(1900, Math.min(2100, Math.floor(Number(raw.recencyYear))))', replace: 'Math.floor(Number(raw.recencyYear))' },
  { id: 'S3 whole-token number check removed', file: 'src/agent/narrative.ts', find: 'if (nums.some((n: string) => !factNumbers.has(n))) continue;', replace: '' },
  { id: 'S3 unquoted sentences allowed', file: 'src/agent/narrative.ts', find: 'if (!quoted.length && !ends.some(', replace: 'if (false && !ends.some(' },
  { id: 'S3 instruction filter removed', file: 'src/agent/narrative.ts', find: '|| INSTRUCTION_LIKE.test(text)) continue;', replace: ') continue;' },
  { id: 'B1 finish accepts unseen anchor ids', file: 'src/agent/planner.ts', find: 'if (bad.length) return { ok: false, error: `anchors.', replace: 'if (false) return { ok: false, error: `anchors.' },
  { id: 'B1 unseen tag ids accepted', file: 'src/agent/planner.ts', find: "if (action === 'read_location' && out.tag_id && !seen.tagIds.has(out.tag_id))", replace: 'if (false)' },
  { id: 'B1 step cap removed', file: 'src/agent/planner.ts', find: 'step <= maxSteps; step++', replace: 'step <= maxSteps + 50; step++' },
  { id: 'B1 per-attempt call cap removed', file: 'src/agent/planner.ts', find: 'if (calls >= maxCalls) {', replace: 'if (false) {' },
  { id: 'B1 invalid-call limit removed', file: 'src/agent/planner.ts', find: 'if (invalid >= maxInvalid)', replace: 'if (false)' },
  { id: 'B1 data delimiter not neutralised', file: 'src/agent/planner.ts', find: ".replace(/DATA/g, 'D4TA')", replace: '' },
  { id: 'B1 personal data not scrubbed in prompts', file: 'src/agent/planner.ts', find: 'const t = scrubPersonal(String(s ?? \'\'))', replace: 'const t = String(s ?? \'\')' },
  { id: 'B1 planner abstain ignored', file: 'src/agent/pipeline.ts', find: "if (plannerOutcome.status === 'abstained') throw", replace: "if (false) throw" },
  { id: 'budget gate removed (no degrade)', file: 'src/agent/pipeline.ts', find: 'if (budgetLeft() >= n) return true;', replace: 'return true;' },
  { id: 'degraded runs not flagged', file: 'src/agent/pipeline.ts', find: "degraded: ledger.records.filter((e) => e.path === 'error').map(", replace: 'degraded: [].map(' },
  { id: 'memo removed', file: 'src/qloo/client.ts', find: 'const hit = this.#memo.get(key);', replace: 'const hit = undefined as never;' },
  { id: 'outbound email check removed', file: 'src/qloo/outbound.ts', find: "['email address', /[^\\s@]+@[^\\s@]+\\.[A-Za-z]{2,}/],", replace: "['email address', /(?!)/]," },
  { id: 'no-LLM label lies', file: 'src/agent/pipeline.ts', find: "'scripted workflow (no LLM)'", replace: "'agent'" },
  { id: 'N4 recorder accepts degraded runs', file: 'src/export.ts', find: "if (result.degraded?.length) return", replace: "if (false) return" },
  { id: 'N4 recorder accepts skipped steps', file: 'src/export.ts', find: "if (result.skipped?.length) return", replace: "if (false) return" },
  { id: 'N4 recorder accepts wrong workflow', file: 'src/export.ts', find: "if (got !== want) return", replace: "if (false) return" },
  { id: 'N4 worker warm-up ignores the gate', file: 'src/worker.ts', find: "const gate = admin || !llmConfigured ? recordable(", replace: "const gate = true ? { ok: true as const } : recordable(" },
  { id: 'N4 visitor runs recorded when LLM configured', file: 'src/worker.ts', find: ": { ok: false as const, why: 'visitor-triggered run with an LLM configured' };", replace: ": { ok: true as const };" },
  { id: 'N4 export id/mode not validated', file: 'scripts/private-paths.ts', find: "!/^[a-z0-9-]+$/i.test(id) || ", replace: "" },
  { id: 'N4 export script skips trim', file: 'scripts/export-examples.ts', find: "JSON.stringify(trimForRecording(result))", replace: "JSON.stringify(result)" },
  { id: 'N1 swap runs without the planner', file: 'src/agent/pipeline.ts', find: "llm: plannerUsed ? opts.llm : null, planner: plannerUsed ? opts.planner : undefined,", replace: "llm: null, planner: undefined," },
  { id: 'N1 mismatched swap accepted', file: 'src/agent/pipeline.ts', find: "plannerUsed && swappedKind !== 'llm-planner' ?", replace: "false ?" },
  { id: 'N2 hostile ids reach the prompt', file: 'src/agent/planner.ts', find: "return list.filter((e) => e.entity_id && ID.test(e.entity_id)).slice(0, n).map((e) => `${neutralize(e.entity_id, 80)} |", replace: "return list.slice(0, n).map((e) => `${e.entity_id} |" },
  { id: 'N3 per-run LLM cap removed', file: 'src/llm/budget.ts', find: "if (this.used >= this.#perRun) throw", replace: "if (false) throw" },
  { id: 'N3 per-day LLM ledger removed', file: 'src/llm/budget.ts', find: "if (this.#ledger) {", replace: "if (false as boolean) {" },
  { id: 'N3 visitor examples spend LLM calls', file: 'src/worker.ts', find: "const useLlm = admin;", replace: "const useLlm = true;" },
  { id: 'N3 custom runs uncapped', file: 'src/worker.ts', find: "llm: llmFor(env, visitor, llmRunCap(env)),", replace: "llm: providerFromEnv(env)," },
  { id: 'N3 budget label lies', file: 'src/agent/pipeline.ts', find: "'scripted workflow (LLM budget reached)'", replace: "'LLM planner'" },
  { id: 'N5 Gemini 429 not recognised', file: 'src/llm/provider.ts', find: "if (res.status === 429) throw", replace: "if (false) throw" },
  { id: 'N5 truncated reply accepted', file: 'src/llm/provider.ts', find: "if (cand?.finishReason === 'MAX_TOKENS') throw", replace: "if (false) throw" },
  { id: 'N5 blocked prompt accepted', file: 'src/llm/provider.ts', find: "if (j?.promptFeedback?.blockReason) throw", replace: "if (false) throw" },
  { id: 'N5 thinking not disabled', file: 'src/llm/provider.ts', find: "...(/2\\.5-flash/.test(model) ? { thinkingConfig: { thinkingBudget: 0 } } : {}),", replace: "" },
  { id: 'Deno store skips chunking', file: 'src/storage/deno-kv.ts', find: "if (bytes.length <= CHUNK_BYTES) op.set(", replace: "if (true) op.set(" },
  { id: 'Deno store skips checksum', file: 'src/storage/deno-kv.ts', find: "|| (await sha256Hex(all)) !== head.sha", replace: "" },
  { id: 'Deno store accepts incomplete chunk sets', file: 'src/storage/deno-kv.ts', find: "if (!(c instanceof Uint8Array)) throw", replace: "if (false) throw" },
  { id: 'Deno overwrite leaves old chunks', file: 'src/storage/deno-kv.ts', find: "if (isManifest(old)) for (let i = 0; i < old.n; i++) op.delete([NS, 'kvc', key, old.gen, i]); // overwrite", replace: "// overwrite" },
  { id: 'Deno put without versionstamp check', file: 'src/storage/deno-kv.ts', find: ".atomic().check({ key: [NS, 'kv', key], versionstamp: oldEntry.versionstamp });", replace: ".atomic();" },
  { id: 'Deno delete without versionstamp check', file: 'src/storage/deno-kv.ts', find: ".atomic().check({ key: [NS, 'kv', key], versionstamp: entry.versionstamp });", replace: ".atomic();" },
  { id: 'Deno reads not explicitly strong', file: 'src/storage/deno-kv.ts', find: "const STRONG = { consistency: 'strong' } as const;", replace: "const STRONG = undefined;" },
  { id: 'worker lets a replay read error become a 500', file: 'src/worker.ts', find: "return json({ error: 'Replay unavailable:", replace: "throw new Error('x'); return json({ error: 'Replay unavailable:" },
  { id: 'worker loses the result when put fails', file: 'src/worker.ts', find: "notStored = 'storage write failed';", replace: "throw new Error('put failed');" },
  { id: 'smoke app serves with placeholder token', file: 'src/storage/kv-smoke-handler.ts', find: "d.token.length < 16 || d.token === TOKEN_PLACEHOLDER || d.token.startsWith(TOKEN_PLACEHOLDER)", replace: "false" },
  { id: 'smoke app ignores the path token', file: 'src/storage/kv-smoke-handler.ts', find: "parts.length !== 2 || !tokenOk(parts[0]!)", replace: "parts.length !== 2" },
  { id: 'smoke app sleep not clamped', file: 'src/storage/kv-smoke-handler.ts', find: "Math.min(Math.max(Number(new URL(req.url).searchParams.get('s')) || 1, 1), MAX_SLEEP_S)", replace: "Math.max(Number(new URL(req.url).searchParams.get('s')) || 1, 1)" },
  { id: 'smoke app long requests uncapped', file: 'src/storage/kv-smoke-handler.ts', find: "if (longRunning >= MAX_LONG_REQUESTS)", replace: "if (false)" },
  { id: 'smoke app /kv not rate limited', file: 'src/storage/kv-smoke-handler.ts', find: "if (now() - lastKv < KV_MIN_INTERVAL_MS)", replace: "if (false)" },
  { id: 'example trace claims a recording for computed fixtures', file: 'src/worker.ts', find: "isLive(env) ? 'stored-recording' : 'computed-synthetic';", replace: "'stored-recording';" },
  { id: 'doc checker skips a whole line on a history word', file: 'scripts/check-doc-counts.ts', find: "line.split(/((?<=[.;])\\s+)/)", replace: "[line]" },
  { id: 'doc checker ignores "N of N" mutation pairs', file: 'scripts/check-doc-counts.ts', find: "if (MUTATION_LINE.test(seg) && counts.mutations !== undefined)", replace: "if (false)" },
  { id: 'doc checker ignores bare "N pass"', file: 'scripts/check-doc-counts.ts', find: "[/\\b(\\d+) pass\\b/g, 'pass'],", replace: "[/\\((\\d+) pass\\b/g, 'pass']," },
  { id: 'doc checker ignores unqualified "agent"', file: 'scripts/check-doc-counts.ts', find: "if (AGENT.test(line) && !AGENT_OK.test(line))", replace: "if (false)" },
  { id: 'smoke app leaks the KV error text', file: 'src/storage/kv-smoke-handler.ts', find: "error: 'Deno KV could not be opened (details withheld from this public URL; see the deployment logs).'", replace: "error: String((e as Error).message)" },
  { id: 'page privacy text drops the 14-day storage fact', file: 'src/ui/page.ts', find: "cached privately for up to 14 days", replace: "cached privately" },
  { id: 'synthetic trace claims Qloo chose the anchors', file: 'src/agent/pipeline.ts', find: "synthetic ? 'the synthetic fixture\\'s open read (not Qloo)' :", replace: "false ? 'x' :" },
  { id: 'doc checker ignores scratch paths', file: 'scripts/check-doc-counts.ts', find: "if (SCRATCH.test(line)) out.push", replace: "if (false) out.push" },
  { id: 'page hint claims a stored replay without a key', file: 'src/ui/page.ts', find: "computed from synthetic fixtures when you click", replace: "a stored replay" },
  { id: 'gate off when token set', file: 'src/access.ts', find: "if (!token) return null;", replace: "return null;" },
  { id: 'gate accepts any cookie', file: 'src/access.ts', find: "if (constantTimeEqual(cookieValue(request.headers.get('cookie'), COOKIE), digest)) return null;", replace: "if (cookieValue(request.headers.get('cookie'), COOKIE) !== undefined) return null;" },
  { id: 'gate leaves the token in the redirect', file: 'src/access.ts', find: "url.searchParams.delete('access');", replace: "" },
  { id: 'gate cookie not HttpOnly', file: 'src/access.ts', find: "${digest}; HttpOnly; Secure;", replace: "${digest}; Secure;" },
  { id: 'gate cookie stores the raw token', file: 'src/access.ts', find: "`${COOKIE}=${digest};", replace: "`${COOKIE}=${token};" },
  { id: 'gate accepts the query token on POST', file: 'src/access.ts', find: "given !== null && request.method === 'GET' &&", replace: "given !== null &&" },
  { id: 'file store serves a foreign envelope', file: 'src/storage/file-store.ts', find: "|| env.key !== key ||", replace: "||" },
  { id: 'file store has no value cap', file: 'src/storage/file-store.ts', find: "if (bytes > MAX_VALUE_BYTES) throw", replace: "if (false) throw" },
  { id: 'file store has no file-count cap', file: 'src/storage/file-store.ts', find: "if (files.length >= MAX_FILES) throw", replace: "if (false) throw" },
  { id: 'file counter forgets on restart', file: 'src/storage/file-store.ts', find: "this.#file = dir ? join(dir, 'counters.json') : null;", replace: "this.#file = null;" },
  { id: 'adapter accepts a junk client address from the trusted header', file: 'src/server/node-adapter.ts', find: "return ip && /^[0-9a-fA-F:.]{3,45}$/.test(ip) ? ip : fallback;", replace: "return ip ?? fallback;" },
  { id: 'adapter trusts proxy headers without opt-in', file: 'src/server/node-adapter.ts', find: "if (mode === 'x-real-ip') ip = pick(headers['x-real-ip']);", replace: "ip = pick(headers['x-real-ip']);" },
  { id: 'adapter ignores Content-Length over the cap', file: 'src/server/node-adapter.ts', find: "if (declared > maxBody) {", replace: "if (false) {" },
  { id: 'adapter ignores the body cap', file: 'src/server/node-adapter.ts', find: "if (size > maxBody) {", replace: "if (false) {" },
  { id: 'adapter takes the first XFF hop', file: 'src/server/node-adapter.ts', find: ".split(',').pop()?.trim()", replace: ".split(',')[0]?.trim()" },
  { id: 'phone reveal leaves the build form open', file: 'src/ui/app.ts', find: "var b = $('build'); if (b && b.open) b.open = false;", replace: "" },
  { id: 'phone reveal scrolls past the Answer card', file: 'src/ui/app.ts', find: "(ans || (tw && !tw.hidden ? tw : $('out'))).scrollIntoView", replace: "((tw && !tw.hidden ? tw : $('out'))).scrollIntoView" },
  { id: 'Gemini has no model fallback', file: 'src/llm/provider.ts', find: "this.#models = [...new Set([...(model ? [model] : []), ...GEMINI_FALLBACK_MODELS])];", replace: "this.#models = [model ?? GEMINI_FALLBACK_MODELS[0]];" },
  { id: 'Gemini retries a blocked prompt on other models', file: 'src/llm/provider.ts', find: "if (e.kind === 'blocked') throw e;", replace: "" },
  { id: 'doc checker allows the stale call figure', file: 'scripts/check-doc-counts.ts', find: "if (STALE_CALLS.test(line) && !HISTORY.test(line))", replace: "if (false)" },
  { id: 'doc checker lets owner-fact regressions through', file: 'scripts/check-doc-counts.ts', find: "if (STALE_OWNER.test(line) && !STALE_OWNER_OK.test(line))", replace: "if (false)" },
  { id: 'doc checker lets unconditional agentic claims through', file: 'scripts/check-doc-counts.ts', find: "if (/agentic/i.test(line) && !AGENTIC_OK.test(line))", replace: "if (false)" },
  { id: 'gate exempts every path, not just icon and manifest', file: 'src/access.ts', find: "(url.pathname === '/apple-touch-icon.png' || url.pathname === '/manifest.webmanifest')", replace: "(url.pathname.length > 0)" },
  { id: 'redirect can be protocol-relative', file: 'src/access.ts', find: "const p = pathname.replace(/\\\\/g, '/').replace(/^\\/+/, '');", replace: "const p = pathname.slice(1);" },
  { id: 'short token accepted silently', file: 'src/server/node-adapter.ts', find: "if (token.length < 24) return { ok: true, warning:", replace: "if (false) return { ok: true, warning:" },
  { id: 'short token allowed in production', file: 'src/server/node-adapter.ts', find: "if (token.length < 16 && production) return { ok: false,", replace: "if (false) return { ok: false," },
  { id: 'slow clients held for the default timeout', file: 'src/server/node-adapter.ts', find: "server.requestTimeout = 30_000;", replace: "server.requestTimeout = 300_000;" },
  { id: 'file store never purges expired files', file: 'src/storage/file-store.ts', find: "    this.purgeExpired();\n    const files", replace: "    const files" },
  { id: 'synthetic config reports live enabled', file: 'src/worker.ts', find: "liveEnabled: isLive(env) && env.LIVE_ENABLED === '1',", replace: "liveEnabled: !isLive(env) || env.LIVE_ENABLED === '1'," },
  { id: 'status bar shows the example budget next to a smaller cap', file: 'src/ui/app.ts', find: "q.line.replace(/(\\d+)\\/\\d+/, '$1')", replace: "q.line" },
  { id: 'synthetic status bar shows Qloo calls next to fixture calls', file: 'src/ui/app.ts', find: "var qline = q && mode === 'MOCK' ?", replace: "var qline = false ?" },
  { id: 'Deno counter not atomic', file: 'src/storage/deno-kv.ts', find: ".atomic().check({ key: k, versionstamp: cur.versionstamp })", replace: ".atomic()" },
  { id: 'worker ignores injected COUNTER', file: 'src/worker.ts', find: "const counter = env.COUNTER ?? (env.CACHE_KV ? new KvCounter(env.CACHE_KV) : memCounter);\n  return new CallBudgetLedger(counter, num(env.DAILY_CALL_CAP", replace: "const counter = (env.CACHE_KV ? new KvCounter(env.CACHE_KV) : memCounter);\n  return new CallBudgetLedger(counter, num(env.DAILY_CALL_CAP" },
  { id: 'doc checker ignores stale rules claims', file: 'scripts/check-doc-counts.ts', find: "if (STALE_OK.test(line)) return;", replace: "return;", tests: ['test/rules-facts.test.ts'] },
  { id: 'README drops the verified demo duration', file: 'README.md', find: "until the Judging Period ends (Nov 5, 2026, 11:45 pm ET)", replace: "through the judging period", tests: ['test/rules-facts.test.ts'] },
];

if (existsSync(work)) rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
for (const d of ['src', 'scripts', 'test', 'docs', 'prereg', 'deploy']) cpSync(join(root, d), join(work, d), { recursive: true });
for (const f of ['package.json', 'tsconfig.json', 'wrangler.toml', '.dev.vars.example', '.gitignore', 'README.md', 'LICENSE']) cpSync(join(root, f), join(work, f));
// Control: the UNMUTATED copy must pass, otherwise "killed" would mean nothing.
const control = spawnSync(process.execPath, ['--test', ...T], { cwd: work, encoding: 'utf8', env: { PATH: process.env.PATH } });
if (control.status !== 0) { console.log('CONTROL FAILED: the unmutated copy does not pass its tests; no mutation result is meaningful.\n' + control.stdout.split('\n').filter((l) => /^not ok|error:/.test(l)).slice(0, 8).join('\n')); rmSync(work, { recursive: true, force: true }); process.exit(2); }
let survived = 0;
const rows: string[] = [];
for (const m of M_) {
  if (m.tests && m.tests.length === 0) continue; // documented no-op control, skipped
  const path = join(work, m.file);
  const orig = readFileSync(path, 'utf8');
  if (!orig.includes(m.find)) { rows.push(`| ${m.id} | NOT APPLIED (pattern missing) |`); survived++; continue; }
  writeFileSync(path, orig.replace(m.find, m.replace));
  const r = spawnSync(process.execPath, ['--test', ...(m.tests ?? T)], { cwd: work, encoding: 'utf8', env: { PATH: process.env.PATH } });
  writeFileSync(path, orig);
  const killed = r.status !== 0;
  if (!killed) survived++;
  rows.push(`| ${m.id} | ${killed ? 'killed' : 'SURVIVED'} |`);
}
rmSync(work, { recursive: true, force: true });
console.log('| mutation | result |\n|---|---|\n' + rows.join('\n'));
saveCounts({ mutations: rows.length, killed: rows.length - survived }, root);
console.log(`\ncontrol (unmutated copy): pass\n${rows.length} mutations, ${rows.length - survived} killed, ${survived} survived.`);
process.exit(survived ? 1 : 0);
