// A very small DOM, just enough to run the real client script (src/ui/app.ts) against the real page
// markup (src/ui/page.ts) in Node. Not a browser: layout, CSS and scrolling are not simulated (the
// 375 px / 1366 px checks are done in a real headless browser). It supports the selectors and
// properties the client script uses.
import { PAGE_HTML } from '../src/ui/page.ts';
import { APP_JS } from '../src/ui/app.ts';

export class FakeText {
  data: string;
  parent: FakeEl | null = null;
  constructor(data: string) { this.data = data; }
  get textContent() { return this.data; }
}

const VOID = new Set(['meta', 'link', 'input', 'br', 'hr', 'img', 'path', 'rect', 'circle', 'line']);

/** ids of elements scrolled into view, in order (tests clear it) */
export const scrollLog: string[] = [];

export class FakeEl {
  children: (FakeEl | FakeText)[] = [];
  parent: FakeEl | null = null;
  attrs: Record<string, string> = {};
  listeners: Record<string, ((e: unknown) => void)[]> = {};
  hidden = false;
  open = false;
  value = '';
  checked = false;
  disabled = false;
  style = { setProperty() {} };
  scrollIntoView() { scrollLog.push(this.attrs['id'] ?? this.tagName); }
  focus() {}
  tagName: string;
  constructor(tagName: string) { this.tagName = tagName; }
  get className() { return this.attrs['class'] ?? ''; }
  set className(v: string) { this.attrs['class'] = v; }
  get id() { return this.attrs['id'] ?? ''; }
  get classList() {
    const self = this;
    const list = () => self.className.split(/\s+/).filter(Boolean);
    return {
      add: (c: string) => { if (!list().includes(c)) self.className = [...list(), c].join(' '); },
      remove: (c: string) => { self.className = list().filter((x) => x !== c).join(' '); },
      contains: (c: string) => list().includes(c),
      toggle: (c: string, on?: boolean) => { const has = list().includes(c); const want = on ?? !has; if (want && !has) self.className = [...list(), c].join(' '); if (!want && has) self.className = list().filter((x) => x !== c).join(' '); },
    };
  }
  get firstChild(): FakeEl | FakeText | null { return this.children[0] ?? null; }
  appendChild<T extends FakeEl | FakeText>(c: T): T { c.parent = this; this.children.push(c); return c; }
  removeChild(c: FakeEl | FakeText) { this.children = this.children.filter((x) => x !== c); return c; }
  setAttribute(k: string, v: string) {
    this.attrs[k] = String(v);
    if (k === 'hidden') this.hidden = true;
    if (k === 'open') this.open = true;
    if (k === 'value') this.value = String(v);
    if (k === 'checked') this.checked = true;
  }
  getAttribute(k: string) { return k in this.attrs ? this.attrs[k]! : null; }
  addEventListener(t: string, f: (e: unknown) => void) { (this.listeners[t] ??= []).push(f); }
  dispatch(t: string, extra: Record<string, unknown> = {}) {
    const ev = { type: t, key: '', preventDefault() {}, currentTarget: this, target: this, ...extra };
    for (const f of this.listeners[t] ?? []) f(ev);
  }
  click() { this.dispatch('click'); }
  get textContent(): string { return this.children.map((c) => c.textContent).join(''); }
  set textContent(v: string) { this.children = []; if (v) this.appendChild(new FakeText(String(v))); }
  isHidden(): boolean { return this.hidden || (this.parent?.isHidden() ?? false); }
  walk(fn: (e: FakeEl) => void) { for (const c of this.children) if (c instanceof FakeEl) { fn(c); c.walk(fn); } }
  querySelectorAll(sel: string): FakeEl[] {
    const out: FakeEl[] = [];
    const parts = sel.trim().split(/\s+/);
    this.walk((e) => { if (matchChain(e, parts, this)) out.push(e); });
    return out;
  }
  querySelector(sel: string) { return this.querySelectorAll(sel)[0] ?? null; }
  closest(sel: string): FakeEl | null { for (let e: FakeEl | null = this; e; e = e.parent) if (matchSimple(e, sel)) return e; return null; }
}

function matchSimple(e: FakeEl, sel: string): boolean {
  const re = /(#[\w-]+)|(\.[\w-]+)|(\[[^\]]+\])|(:not\(\[[^\]]+\]\))|([a-zA-Z][\w-]*)/g;
  let rest = sel;
  for (const m of sel.matchAll(re)) {
    const tok = m[0];
    rest = rest.replace(tok, '');
    if (tok.startsWith('#')) { if (e.id !== tok.slice(1)) return false; }
    else if (tok.startsWith('.')) { if (!e.classList.contains(tok.slice(1))) return false; }
    else if (tok.startsWith(':not(')) { if (attrMatch(e, tok.slice(6, -2))) return false; }
    else if (tok.startsWith('[')) { if (!attrMatch(e, tok.slice(1, -1))) return false; }
    else if (e.tagName.toLowerCase() !== tok.toLowerCase()) return false;
  }
  return rest.trim() === '';
}
function attrMatch(e: FakeEl, a: string): boolean {
  const [k, v] = a.split('=');
  if (k === 'hidden') return e.hidden;
  if (v === undefined) return k! in e.attrs;
  return e.attrs[k!] === v.replace(/^["']|["']$/g, '');
}
function matchChain(e: FakeEl, parts: string[], root: FakeEl): boolean {
  if (!matchSimple(e, parts[parts.length - 1]!)) return false;
  let i = parts.length - 2;
  for (let a = e.parent; a && i >= 0; a = a.parent) {
    if (a === root.parent) break;
    if (matchSimple(a, parts[i]!)) i--;
  }
  return i < 0;
}

export function parseHtml(html: string): FakeEl {
  const root = new FakeEl('#root');
  let cur = root;
  const body = html.replace(/<!doctype[^>]*>/i, '').replace(/<!--[\s\S]*?-->/g, '');
  for (const m of body.matchAll(/<\/([a-zA-Z0-9]+)\s*>|<([a-zA-Z0-9]+)((?:\s+[^\s>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+)/g)) {
    if (m[1]) { if (cur.parent && cur.tagName.toLowerCase() === m[1].toLowerCase()) cur = cur.parent; }
    else if (m[2]) {
      const el = new FakeEl(m[2]);
      for (const a of (m[3] ?? '').matchAll(/([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) el.setAttribute(a[1]!, a[2] ?? a[3] ?? a[4] ?? '');
      if (el.tagName === 'option') el.value = el.attrs['value'] ?? '';
      cur.appendChild(el);
      if (!m[4] && !VOID.has(m[2].toLowerCase())) cur = el;
    } else if (m[5] && m[5].trim()) cur.appendChild(new FakeText(m[5]));
  }
  return root;
}

export interface App {
  doc: FakeDoc;
  fetchLog: string[];
  $: (id: string) => FakeEl;
  text: (id: string) => string;
  settle: () => Promise<void>;
}
class FakeDoc {
  root: FakeEl;
  constructor(root: FakeEl) { this.root = root; }
  createElement(t: string) { return new FakeEl(t); }
  createElementNS(_ns: string, t: string) { return new FakeEl(t); }
  createTextNode(s: string) { return new FakeText(s); }
  getElementById(id: string) { return this.root.querySelector('#' + id); }
  querySelector(s: string) { return this.root.querySelector(s); }
  querySelectorAll(s: string) { return this.root.querySelectorAll(s); }
  documentElement = { clientWidth: 375 };
}

/** Boot the real page and client script. `routes` answers fetch() by URL; unknown URLs reject. */
export async function bootApp(routes: Record<string, (init?: RequestInit) => Response | Promise<Response>>, opts: { small?: boolean } = {}): Promise<App> {
  const root = parseHtml(PAGE_HTML);
  const doc = new FakeDoc(root);
  const fetchLog: string[] = [];
  const fakeFetch = async (url: string, init?: RequestInit) => {
    fetchLog.push(url);
    const h = routes[url] ?? Object.entries(routes).find(([k]) => k.endsWith('*') && url.startsWith(k.slice(0, -1)))?.[1];
    if (!h) throw new Error('no route for ' + url);
    return h(init);
  };
  const win = { matchMedia: (q: string) => ({ matches: /reduced-motion/.test(q) || (!!opts.small && /max-width/.test(q)) }), scrollTo() {} };
  new Function('document', 'window', 'fetch', 'URL', 'Blob', APP_JS)(doc, win, fakeFetch, { createObjectURL: () => '', revokeObjectURL() {} }, class {});
  const app: App = {
    doc,
    fetchLog,
    $: (id) => doc.getElementById(id)!,
    text: (id) => doc.getElementById(id)!.textContent,
    settle: async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 5)); },
  };
  await app.settle();
  return app;
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
