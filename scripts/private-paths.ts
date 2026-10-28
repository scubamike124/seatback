import { resolve, sep } from 'node:path';

/** Recorded examples may be written ONLY under <root>/.private/ (gitignored, never tracked). */
export function privateExamplePath(root: string, mode: string, id: string): string {
  const dir = resolve(root, '.private', 'examples');
  const p = resolve(dir, `example-${mode}-${id}.json`);
  if (!/^[a-z0-9-]+$/i.test(id) || !/^(live|synthetic)$/.test(mode) || !p.startsWith(dir + sep)) throw new Error('Refusing to write a recorded example outside .private/examples/.');
  return p;
}
