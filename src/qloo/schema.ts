/** Response-envelope validation. Fields may be omitted (docs), but wrong TYPES are an error. */
import { QlooError } from './types.ts';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function arrayOfObjects(v: unknown, where: string, path: string): void {
  if (v === undefined || v === null) return; // omitted = empty
  if (!Array.isArray(v) || v.some((x) => !isObj(x))) throw new QlooError(`Qloo ${path} returned an unexpected shape for ${where}.`, 200, 'malformed');
}

/** Throws QlooError('malformed') when the envelope for this endpoint is the wrong shape. */
export function validateEnvelope(path: string, json: unknown): void {
  if (!isObj(json)) throw new QlooError(`Qloo ${path} returned JSON that is not an object.`, 200, 'malformed');
  const r = json.results;
  if (r === undefined || r === null) return;
  if (path === '/search') return arrayOfObjects(r, 'results', path);
  if (!isObj(r)) throw new QlooError(`Qloo ${path} returned results that is not an object.`, 200, 'malformed');
  for (const k of ['entities', 'tags', 'demographics', 'trending', 'heatmap']) arrayOfObjects(r[k], `results.${k}`, path);
}

/** Strict entity check used by the contract suite (stricter than runtime). Returns problems. */
export function entityProblems(e: unknown): string[] {
  if (!isObj(e)) return ['entity is not an object'];
  const p: string[] = [];
  if (typeof e.entity_id !== 'string' || !e.entity_id) p.push('entity_id missing or not a string');
  if (typeof e.name !== 'string' || !e.name) p.push('name missing or not a string');
  const q = e.query;
  if (q !== undefined && (!isObj(q) || (q.affinity !== undefined && typeof q.affinity !== 'number'))) p.push('query.affinity not a number');
  if (e.tags !== undefined && !Array.isArray(e.tags)) p.push('tags not an array');
  return p;
}

export function tagProblems(t: unknown): string[] {
  if (!isObj(t)) return ['tag is not an object'];
  return typeof (t.tag_id ?? t.id) === 'string' ? [] : ['tag id missing'];
}
