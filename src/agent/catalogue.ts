/**
 * Parses the programmer's candidate catalogue: the titles they can actually license this cycle.
 * Qloo does not know licence availability, so Seatback ranks what the programmer supplies.
 *
 * Accepted line formats (one title per line, '#' starts a comment):
 *   Paper Comets (2021)
 *   movie: Paper Comets (2021)
 *   tv: Low Tide Detectives
 *   podcast: The Layover Hour
 *   music: Night Ferry
 * or CSV rows exported from a distributor list:  type,title,year
 *   movie,"Paper Comets, Part 2",2024
 */
import type { Domain } from '../qloo/types.ts';

export interface CatalogueItem {
  line: number;
  title: string;
  domain: Domain;
  year?: number;
}

export interface ParsedCatalogue {
  items: CatalogueItem[];
  rejected: { line: number; text: string; reason: string }[];
}

const PREFIX: Record<string, Domain> = {
  movie: 'movie',
  film: 'movie',
  tv: 'tv_show',
  series: 'tv_show',
  show: 'tv_show',
  podcast: 'podcast',
  pod: 'podcast',
  music: 'artist',
  artist: 'artist',
  album: 'artist',
};

export function parseCatalogue(text: string, maxItems: number): ParsedCatalogue {
  const items: CatalogueItem[] = [];
  const rejected: ParsedCatalogue['rejected'] = [];
  const seen = new Set<string>();
  const lines = text.replace(/\r/g, '').split('\n');
  lines.forEach((raw, i) => {
    const line = i + 1;
    const s = raw.trim();
    if (!s || s.startsWith('#')) return;
    let domain: Domain = 'movie';
    let rest = s;
    let year: number | undefined;
    const csv = /^([a-z]+)\s*,/i.exec(s);
    if (/^type\s*,\s*title/i.test(s)) return; // CSV header row
    if (csv && PREFIX[csv[1]!.toLowerCase()]) {
      const f = parseCsvLine(s);
      domain = PREFIX[f[0]!.trim().toLowerCase()]!;
      rest = (f[1] ?? '').trim();
      if (f[2] && /^\d{4}$/.test(f[2].trim())) year = Number(f[2].trim());
    } else {
      const m = /^([a-z]+)\s*:\s*(.+)$/i.exec(s);
      if (m && PREFIX[m[1]!.toLowerCase()]) {
        domain = PREFIX[m[1]!.toLowerCase()]!;
        rest = m[2]!.trim();
      }
    }
    const y = year ? null : /\((\d{4})\)\s*$/.exec(rest);
    if (y) {
      year = Number(y[1]);
      rest = rest.slice(0, y.index).trim();
    }
    rest = rest.replace(/\s+/g, ' ').slice(0, 120);
    if (rest.length < 2) {
      rejected.push({ line, text: s.slice(0, 80), reason: 'too short' });
      return;
    }
    const key = `${domain}|${rest.toLowerCase()}|${year ?? ''}`;
    if (seen.has(key)) {
      rejected.push({ line, text: s.slice(0, 80), reason: 'duplicate' });
      return;
    }
    if (items.length >= maxItems) {
      rejected.push({ line, text: s.slice(0, 80), reason: `over the ${maxItems}-title limit` });
      return;
    }
    seen.add(key);
    items.push({ line, title: rest, domain, ...(year ? { year } : {}) });
  });
  return { items, rejected };
}

export function normalizeTitle(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\(synthetic\)/g, '')
    .replace(/^(the|a|an)\s+/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Minimal RFC 4180 field splitter for one line (quoted fields, doubled quotes). */
export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (q) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * Keep at most `cap` titles, taking them round-robin across domains (in line order within each domain), so a
 * cap never wipes out a whole domain. Dropped titles are returned as rejected lines with the reason.
 */
export function capStratified(parsed: ParsedCatalogue, cap: number): ParsedCatalogue {
  if (parsed.items.length <= cap) return parsed;
  const by = new Map<Domain, CatalogueItem[]>();
  for (const it of parsed.items) by.set(it.domain, [...(by.get(it.domain) ?? []), it]);
  const queues = [...by.values()];
  const keep = new Set<CatalogueItem>();
  for (let i = 0; keep.size < cap; i++) {
    let any = false;
    for (const q of queues) if (q[i] && keep.size < cap) { keep.add(q[i]!); any = true; }
    if (!any) break;
  }
  const items = parsed.items.filter((i) => keep.has(i));
  const dropped = parsed.items.filter((i) => !keep.has(i)).map((i) => ({ line: i.line, text: i.title.slice(0, 80), reason: `over this run's ${cap}-title cap (not read)` }));
  return { items, rejected: [...parsed.rejected, ...dropped] };
}
