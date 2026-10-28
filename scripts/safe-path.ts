// Write-path guard: scripts may write only inside the project root, or inside the folder named by
// SEATBACK_SCRATCH (the session scratchpad). Anything else is refused before a byte is written.
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url));

export function isInside(path: string, root: string): boolean {
  const p = resolve(path), r = resolve(root);
  return p === r || p.startsWith(r.endsWith(sep) ? r : r + sep);
}

export function assertWritable(path: string, env: Record<string, string | undefined> = process.env): string {
  const roots = [PROJECT_ROOT, ...(env.SEATBACK_SCRATCH ? [env.SEATBACK_SCRATCH] : [])];
  if (!roots.some((r) => isInside(path, r))) throw new Error(`Refusing to write outside the project (or SEATBACK_SCRATCH): ${resolve(path)}`);
  return resolve(path);
}
