/**
 * Outbound payload guard. Kit submission guide: "Do not send names, email addresses, device
 * identifiers, account IDs, location histories, or other personal data to Qloo merely to make a
 * hackathon demo work." Every request passes through here before it is built into a URL.
 *
 * Rules: (1) only allow-listed parameter NAMES (params.ts also checks per endpoint); (2) free-text
 * parameters must be short place / title / tag words, with no email, phone, URL, device-id,
 * coordinates or long digit strings; (3) ID parameters must be plain identifiers.
 */
import { QlooError } from './types.ts';

/** The only parameter names Seatback ever sends. */
export const OUTBOUND_PARAM_ALLOWLIST: ReadonlySet<string> = new Set([
  'query', 'types', 'take', 'filter.type', 'filter.tags', 'filter.results.entities', 'filter.exclude.entities',
  'filter.release_year.min', 'filter.content_rating', 'filter.parents.types', 'filter.query', 'filter.start_date',
  'filter.end_date', 'filter.geocode.country_code', 'filter.location.query', 'signal.location', 'signal.location.query',
  'signal.interests.entities', 'signal.interests.tags',
]);
const FREE_TEXT = new Set(['query', 'filter.query', 'signal.location.query', 'filter.location.query']);
const ID_LIST = new Set(['filter.tags', 'filter.results.entities', 'filter.exclude.entities', 'signal.interests.entities', 'signal.interests.tags', 'signal.location']);

const PERSONAL: [string, RegExp][] = [
  ['email address', /[^\s@]+@[^\s@]+\.[A-Za-z]{2,}/],
  ['URL', /https?:\/\/|www\./i],
  ['phone-like number', /(?:\+?\d[\s().-]{0,2}){9,}/],
  ['coordinates', /-?\d{1,3}\.\d{3,}\s*[,;]\s*-?\d{1,3}\.\d{3,}/],
  ['device or account id', /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\b[0-9A-F]{32}\b/i],
  ['@handle', /(^|\s)@\w{2,}/],
];

/** Names of personal-data kinds found in a free-text value (empty when clean). */
export function personalDataIn(value: string): string[] {
  return PERSONAL.filter(([, re]) => re.test(value)).map(([n]) => n);
}

export function sanitizeOutbound(path: string, params: Record<string, string>): void {
  for (const [k, v] of Object.entries(params)) {
    if (!OUTBOUND_PARAM_ALLOWLIST.has(k)) throw new QlooError(`Refusing to send parameter "${k}" to Qloo (${path}): not on the outbound allow-list.`, 0, 'invalid_request');
    if (FREE_TEXT.has(k)) {
      const found = personalDataIn(v);
      if (found.length) throw new QlooError(`Refusing to send "${k}" to Qloo (${path}): looks like personal data (${found.join(', ')}). Value not shown.`, 0, 'invalid_request');
      if (v.length > 160) throw new QlooError(`Refusing to send over-long "${k}" to Qloo (${path}).`, 0, 'invalid_request');
    } else if (ID_LIST.has(k)) {
      if (!v.split(',').every((id) => /^[A-Za-z0-9_:.-]{1,80}$/.test(id))) throw new QlooError(`Refusing to send malformed id list in "${k}" (${path}).`, 0, 'invalid_request');
    }
  }
}

/** Replace personal-data-looking spans (email, URL, phone, @handle, coordinates) before text reaches an LLM prompt. */
export function scrubPersonal(text: string): string {
  return text
    .replace(/[^\s@]+@[^\s@]+\.[A-Za-z]{2,}/g, '[removed]')
    .replace(/https?:\/\/\S+|www\.\S+/gi, '[removed]')
    .replace(/(?:\+?\d[\s().-]{0,2}){9,}/g, '[removed]')
    .replace(/-?\d{1,3}\.\d{3,}\s*[,;]\s*-?\d{1,3}\.\d{3,}/g, '[removed]')
    .replace(/(^|\s)@\w{2,}/g, '$1[removed]');
}
