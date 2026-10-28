// Automated accessibility basics that run in `npm test` with no browser: text contrast computed from the real
// CSS colour tokens (light and dark), labels, landmarks, tab wiring, focus, motion and target-size rules.
// A real-browser audit (computed contrast of every text node, keyboard walk, 320/375 px overflow, target sizes)
// is tools/a11y-audit.mjs. Neither replaces a screen-reader pass: they cannot judge reading order or wording.
import test from 'node:test';
import assert from 'node:assert/strict';
import { APP_CSS } from '../src/ui/styles.ts';
import { PAGE_HTML } from '../src/ui/page.ts';
import { parseHtml, type FakeEl } from './fake-dom.ts';

const hex = (h: string) => { const x = h.replace('#', ''); const v = x.length === 3 ? x.split('').map((c) => c + c).join('') : x; return [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16)); };
const lum = (h: string) => { const [r, g, b] = hex(h).map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!; };
export const contrast = (a: string, b: string) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const tokens = (css: string) => Object.fromEntries([...css.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{3,6});/g)].map((m) => [m[1]!, m[2]!]));
const [lightCss, darkRest] = APP_CSS.split('@media (prefers-color-scheme: dark)') as [string, string];
const light = tokens(lightCss);
const dark = { ...light, ...tokens(darkRest.split('\n}\n')[0]!) };

// Every text/background pair used for body-size text (small text needs 4.5:1, WCAG 2.2 AA 1.4.3).
const PAIRS: [string, string][] = [
  ['ink', 'bg'], ['ink', 'surface'], ['ink-2', 'surface'], ['ink-2', 'surface-2'], ['ink-3', 'surface'], ['ink-3', 'surface-2'], ['ink-3', 'bg'],
  ['origin', 'surface'], ['origin', 'surface-2'], ['dest-ink', 'surface'], ['dest-ink', 'surface-2'], ['both-ink', 'surface'], ['both-ink', 'surface-2'],
  ['warn-ink', 'warn-bg'], ['err-ink', 'err-bg'], ['navy-ink', 'navy'],
];
for (const [name, t] of [['light', light], ['dark', dark]] as const) {
  test(`${name} theme: every text colour pair has at least 4.5:1 contrast`, () => {
    const bad = PAIRS.filter(([f, b]) => contrast(t[f]!, t[b]!) < 4.5).map(([f, b]) => `${f} on ${b}: ${contrast(t[f]!, t[b]!).toFixed(2)}`);
    assert.deepEqual(bad, []);
  });
}

test('the data-source pills keep 4.5:1 (live: white on green; synthetic: dark on amber)', () => {
  assert.ok(contrast('#ffffff', '#1f7a4d') >= 4.5);
  assert.ok(contrast('#2b1d00', light['accent']!) >= 4.5);
  assert.match(APP_CSS, /\.mode\.live \{ background: #1f7a4d; \}/);
  assert.match(APP_CSS, /\.mode\.synthetic \{ background: var\(--accent\); color: #2b1d00; \}/);
});

test('the brand colours that fail as small text (dest, both) are never used as a text colour', () => {
  assert.ok(contrast(light['dest']!, light['surface']!) < 4.5, 'dest really is too light for text: that is why dest-ink exists');
  assert.doesNotMatch(APP_CSS, /[^-]color:\s*var\(--(dest|both)\)/);
});

const page = parseHtml(PAGE_HTML);
const all = (sel: string) => page.querySelectorAll(sel);

test('document basics: language, viewport, title, one h1, landmarks, skip link', () => {
  assert.equal(all('html')[0]!.getAttribute('lang'), 'en');
  assert.match(PAGE_HTML, /<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">/);
  assert.match(PAGE_HTML, /<title>[^<]+<\/title>/);
  assert.equal(all('h1').length, 1);
  for (const tag of ['header', 'main', 'footer']) assert.equal(all(tag).length, 1, tag);
  assert.ok(all('aside')[0]!.getAttribute('aria-label'), 'the form column is a labelled region');
  const skip = all('a.skip')[0]!;
  assert.ok(page.querySelector(skip.getAttribute('href')!), 'the skip link target exists');
});

test('every form control has a visible label or an aria-label; every button has a name', () => {
  const labelled = (e: FakeEl) => {
    if (e.getAttribute('aria-label')) return true;
    if (e.closest('label')) return true;
    const id = e.id; return !!id && all('label').some((l) => l.getAttribute('for') === id);
  };
  const controls = [...all('input'), ...all('textarea'), ...all('select')].filter((e) => e.getAttribute('type') !== 'hidden');
  assert.ok(controls.length >= 8);
  assert.deepEqual(controls.filter((e) => !labelled(e)).map((e) => e.id || e.tagName), []);
  const nameless = all('button').filter((b) => !b.textContent.trim() && !b.getAttribute('aria-label'));
  assert.deepEqual(nameless.map((b) => b.id), []);
});

test('tabs are wired: each tab controls an existing panel that points back to it; one tab is in the tab order', () => {
  const tabs = all('[role=tab]');
  assert.equal(tabs.length, 6);
  for (const t of tabs) {
    const panel = page.querySelector('#' + t.getAttribute('aria-controls'))!;
    assert.ok(panel && panel.getAttribute('role') === 'tabpanel', t.id);
    assert.equal(panel.getAttribute('aria-labelledby'), t.id);
  }
  assert.equal(tabs.filter((t) => t.getAttribute('tabindex') === '0').length, 1);
  assert.equal(tabs.filter((t) => t.getAttribute('aria-selected') === 'true').length, 1);
});

test('status and errors are announced: a polite status region and an alert region exist', () => {
  assert.ok(all('[role=status]').some((e) => e.getAttribute('aria-live') === 'polite'));
  assert.ok(all('[role=alert]').length >= 1);
  assert.ok(page.querySelector('#results')!.getAttribute('aria-busy') !== null, 'busy state is exposed');
});

test('focus, motion, target size and the phone layout rules are present in the stylesheet', () => {
  assert.match(APP_CSS, /button:focus-visible/);
  assert.match(APP_CSS, /outline: 3px solid/);
  assert.match(APP_CSS, /@media \(prefers-reduced-motion: reduce\) \{ \*, \*::before, \*::after \{ animation: none !important; transition: none !important; scroll-behavior: auto !important; \} \}/);
  assert.match(APP_CSS, /\n summary \{ min-height: 24px;|\nsummary \{ min-height: 24px;/);
  assert.match(APP_CSS, /\.ev \{[^}]*min-height: 24px/);
  assert.match(APP_CSS, /@media \(max-width: 900px\) \{ \.layout \{ grid-template-columns: 1fr;/);
  assert.doesNotMatch(APP_CSS, /order: -1/, 'no CSS reordering: visual order must equal focus order');
  assert.match(APP_CSS, /@media \(max-width: 900px\) \{ \.q-mobile \{ display: block;/);
  assert.match(APP_CSS, /\.hero-ctas \.cta \{ min-height: 44px;/);
});

test('messages scrolled into view get a margin so the sticky banner cannot cover them', () => {
  assert.match(APP_CSS, /\.error, \.confirm, \.answer, \.evrow, #out, \.tabpanel \{ scroll-margin-top: 3\.75rem; \}/);
});

test('keyboard path to the first answer: the skip link targets the results region, which holds the answer buttons', () => {
  const results = page.querySelector('#results')!;
  assert.equal(results.getAttribute('tabindex'), '-1', 'focusable, so the skip link moves focus into it');
  assert.equal(page.querySelector('a.skip')!.getAttribute('href'), '#results');
  assert.ok(results.querySelector('#hero-examples'), 'the answer buttons are inside the region the skip link jumps to');
  // The hero buttons come after the form in the DOM, so the skip link is the short route; keep it the first stop.
  let first: FakeEl | null = null;
  page.walk((e) => { if (!first && ['a', 'button', 'input', 'textarea', 'summary'].includes(e.tagName.toLowerCase()) && e.getAttribute('tabindex') !== '-1') first = e; });
  assert.equal((first as FakeEl | null)?.className, 'skip');
});
