/** Redaction helpers. Keys live only in the server environment; nothing prints or returns them. */
import type { QlooMode } from './types.ts';

/** Shapes that look like credentials, scrubbed even when the exact key is unknown. */
const SHAPES: RegExp[] = [
  /(X-Api-Key["']?\s*[:=]\s*["']?)[A-Za-z0-9._~+/-]{8,}/gi,
  /\b((?:QLOO|GEMINI)_API_KEY|ADMIN_TOKEN)(\s*[:=]\s*["']?)[A-Za-z0-9._~+/-]{8,}/g,
  /(Bearer\s+)[A-Za-z0-9._~+/-]{16,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
];
export const REDACTED = '[redacted]';

export function redactSecrets(text: string, knownSecrets: readonly (string | undefined)[] = []): string {
  let out = text;
  for (const k of knownSecrets) if (k && k.length >= 4) out = out.split(k).join(REDACTED);
  out = out.replace(SHAPES[0]!, `$1${REDACTED}`).replace(SHAPES[1]!, `$1$2${REDACTED}`).replace(SHAPES[2]!, `$1${REDACTED}`).replace(SHAPES[3]!, REDACTED);
  return out;
}

/** True when text still contains a known secret or a credential-shaped string. */
export function containsSecret(text: string, knownSecrets: readonly (string | undefined)[] = []): boolean {
  return redactSecrets(text, knownSecrets) !== text;
}

/** Throws if value (any JSON-able thing, error or string) carries a secret. For response/log choke points. */
export function assertNoSecret(value: unknown, knownSecrets: readonly (string | undefined)[] = []): void {
  const text = value instanceof Error ? `${value.name} ${value.message} ${value.stack ?? ''}` : typeof value === 'string' ? value : JSON.stringify(value);
  if (containsSecret(text, knownSecrets)) throw new Error('A secret-shaped string was about to leave the server.');
}

/** Every log line carries the mode, so mock output is never mistaken for live. */
export function qlooLog(mode: QlooMode, message: string, secrets: readonly (string | undefined)[] = [], sink: (line: string) => void = console.log): void {
  sink(`[QLOO:${mode}] ${redactSecrets(message, secrets)}`);
}
