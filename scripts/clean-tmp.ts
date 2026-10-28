// Removes this project's own temp output (.tmp-test/, .private/tmp) and nothing else. Refuses any path that is not
// directly inside the project root. Run by `npm test` at the end and usable on its own: node scripts/clean-tmp.ts
import { existsSync, rmSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export function cleanProjectTmp(root = fileURLToPath(new URL('..', import.meta.url))): string[] {
  const base = resolve(root);
  const removed: string[] = [];
  for (const rel of ['.tmp-test']) {
    const p = resolve(base, rel);
    if (!p.startsWith(base + sep) || p === base) throw new Error('refusing to clean outside the project');
    if (existsSync(p)) { rmSync(p, { recursive: true, force: true }); removed.push(rel); }
  }
  return removed;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(`clean-tmp: removed ${cleanProjectTmp().join(', ') || 'nothing'}`);
