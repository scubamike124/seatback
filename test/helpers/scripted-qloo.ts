// A scripted stand-in for the Qloo client with KNOWN effects, for testing the extended validity harness offline.
// Everything is invented and deterministic; it says nothing about Qloo. Titles score from a hash of the title (the same for
// every city), plus a boost when the anchors come from the title's own city, so the true home effect is whatever the test sets.
import type { Domain, InsightsRequest, QlooEntity, QlooResult } from '../../src/qloo/types.ts';
import type { Prereg, ValidityClient } from '../../src/agent/validity-ext.ts';

export interface Script {
  /** Added to a title's score when the anchors come from the title's home city. */
  effect: number;
  /** Fraction of titles (by title hash) whose home effect is reversed: tunes the success rate deterministically. */
  reverseFraction?: number;
  /** Decoys score higher under the anchors of this route end. */
  decoyFavours?: 'origin' | 'destination';
  /** Every title scores identically under every anchor set. */
  allTies?: boolean;
  /** Titles that do not resolve in /search. */
  unresolved?: Set<string>;
}
const frac = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return (h >>> 0) / 4294967296; };

export class ScriptedQloo implements ValidityClient {
  readonly source = 'synthetic-fixture' as const;
  calls = 0;
  readonly #home = new Map<string, string>();
  readonly #decoy = new Map<string, [string, string]>();
  readonly #script: Script;
  constructor(p: Prereg, script: Script) {
    this.#script = script;
    for (const i of p.items) this.#home.set(i.title, i.city);
    for (const d of p.decoys) this.#decoy.set(d.title, d.route.split('|') as [string, string]);
  }
  #wrap(path: string, data: QlooEntity[]): QlooResult<QlooEntity[]> {
    return { data, request: { path, params: {} }, source: 'synthetic-fixture', cached: false, ms: 0 };
  }
  async searchTitle(query: string, domain: Domain) {
    this.calls++;
    if (this.#script.unresolved?.has(query)) return this.#wrap('/search', []);
    return this.#wrap('/search', [{ entity_id: `T|${domain}|${query}`, name: query }]);
  }
  async insights(req: InsightsRequest) {
    this.calls++;
    if (!req.anchorEntityIds) {
      const city = (req.location as { query: string }).query;
      return this.#wrap('/v2/insights', Array.from({ length: 12 }, (_, i) => ({ entity_id: `A|${city}|${req.domain}|${i}`, name: `anchor ${i} of ${city}`, query: { affinity: 0.95 - 0.05 * i } })));
    }
    const city = req.anchorEntityIds[0]!.split('|')[1]!;
    const out: QlooEntity[] = (req.onlyEntityIds ?? []).map((id) => {
      const title = id.split('|')[2]!;
      let a = 0.5;
      if (!this.#script.allTies) {
        a = 0.2 + 0.4 * frac(title) + 0.01 * frac(`${city}|${title}`);
        const home = this.#home.get(title);
        if (home === city) a += this.#script.effect * (frac(`rev|${title}`) < (this.#script.reverseFraction ?? 0) ? -1 : 1);
        const dec = this.#decoy.get(title);
        if (dec && this.#script.decoyFavours && city === (this.#script.decoyFavours === 'origin' ? dec[0] : dec[1])) a += 0.4;
      }
      return { entity_id: id, name: title, query: { affinity: a } };
    });
    return this.#wrap('/v2/insights', out.sort((x, y) => y.query!.affinity! - x.query!.affinity!));
  }
}
