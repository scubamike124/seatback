// Test temp folder INSIDE the project (gitignored). Tests must use this, never os.tmpdir(), so no test
// can write outside the project root even when TMPDIR is unset or points elsewhere.
import { mkdirSync } from 'node:fs';
const dir = new URL('../../.tmp-test/', import.meta.url).pathname;
export function tmpdir(): string {
  mkdirSync(dir, { recursive: true });
  return dir.replace(/\/$/, '');
}
