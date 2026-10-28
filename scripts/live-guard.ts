// Shared guard for the live scripts (live-probe.ts, eval.ts --live).
//
// Guarantees, each covered by test/live-guard.test.ts:
//   1. With no QLOO_API_KEY (environment or .dev.vars) a live run refuses, exit code 2, before any
//      client is built, so no network call is possible.
//   2. `--dry-run` never reads the key's value into any output, never calls the network (fetch is
//      replaced by a function that throws) and never writes a file. It prints what a live run would do.
//   3. The key's value is never printed or written by this module. `redact` is available to scrub
//      any text that might contain it.
//   4. Live output goes only to the gitignored folders listed in PRIVATE_OUTPUT_DIRS; the dry run
//      checks that .gitignore still lists them.
import { existsSync, readFileSync } from 'node:fs';

export const NO_KEY_MESSAGE = 'No QLOO_API_KEY in the environment or .dev.vars. Nothing was called and nothing was written.';
export const EXIT_NO_KEY = 2;
export const HACKATHON_BASE = 'https://hackathon.api.qloo.com';
/** Folders (relative to the project root) where live output may be written. Both must stay gitignored. */
export const PRIVATE_OUTPUT_DIRS = ['.private/', 'eval-output/'] as const;

export function isDryRun(argv: readonly string[]): boolean {
  return argv.includes('--dry-run');
}

/** The key from the environment, else from the .dev.vars file; undefined when neither has a non-empty value. */
export function findKey(env: Record<string, string | undefined>, varsPath: URL | string): string | undefined {
  if (env.QLOO_API_KEY) return env.QLOO_API_KEY;
  if (existsSync(varsPath)) {
    const m = /^[ \t]*QLOO_API_KEY[ \t]*=[ \t]*(.*?)[ \t]*$/m.exec(readFileSync(varsPath, 'utf8'));
    // [ \t] not \s: an empty `QLOO_API_KEY=` line must not swallow the next line as its value.
    const v = m?.[1]?.replace(/^["']|["']$/g, '');
    if (v) return v;
  }
  return undefined;
}

/** Live path: returns the key or exits with code 2 and the clear message. Never prints the key. */
export function requireKey(env: Record<string, string | undefined>, varsPath: URL | string, exit: (code: number) => never = process.exit): string {
  const k = findKey(env, varsPath);
  if (!k) {
    console.error(NO_KEY_MESSAGE);
    return exit(EXIT_NO_KEY);
  }
  return k;
}

/** Replace every occurrence of the key in a text. */
export function redact(text: string, key: string | undefined): string {
  return key ? text.split(key).join('[key hidden]') : text;
}

/** After this call any use of fetch throws. Used by the dry run as a second line of defence. */
export function blockNetwork(): void {
  globalThis.fetch = (() => {
    throw new Error('Network is blocked in dry-run mode.');
  }) as typeof fetch;
}

/** Which of the private output folders are missing from a .gitignore text. */
export function missingIgnores(gitignoreText: string): string[] {
  const lines = gitignoreText.split('\n').map((l) => l.trim());
  return PRIVATE_OUTPUT_DIRS.filter((d) => !lines.includes(d));
}

/** The dry-run report. Says whether a key is present (yes/no only), never its value. */
export function dryRunLines(opts: { script: string; keyPresent: boolean; plan: string[]; outputFiles: string[]; gitignoreText: string }): string[] {
  const missing = missingIgnores(opts.gitignoreText);
  return [
    `DRY RUN of ${opts.script}: no network call, no file written.`,
    `Qloo base URL a live run would use: ${HACKATHON_BASE}`,
    `QLOO_API_KEY: ${opts.keyPresent ? 'present (value not shown)' : 'NOT SET. A live run would refuse with exit code 2.'}`,
    'A live run would:',
    ...opts.plan.map((p) => `  - ${p}`),
    `Output files a live run would write (only these): ${opts.outputFiles.join(', ') || 'none'}`,
    `Private output folders ignored by git: ${missing.length ? 'MISSING from .gitignore: ' + missing.join(', ') : PRIVATE_OUTPUT_DIRS.join(', ') + ' (both listed)'}`,
  ];
}
