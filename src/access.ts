/** Private-preview access gate. With DEMO_ACCESS_TOKEN unset (contest mode) the gate is OFF and nothing here runs.
 *  With it set, every route except /healthz needs the token: once as ?access=<token> (answered with a redirect to the clean
 *  URL and an HttpOnly, Secure, SameSite=Lax cookie), afterwards via the cookie. The cookie holds a SHA-256 of the token, not
 *  the token. Comparisons are constant time. The token is never logged and never appears in a redirect target. */
export const COOKIE = 'seatback_access';

async function sha256Hex(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function constantTimeEqual(a: string, b: string): boolean {
  const n = Math.max(a.length, b.length);
  let x = a.length ^ b.length;
  for (let i = 0; i < n; i++) x |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return x === 0;
}
function cookieValue(header: string | null, name: string): string {
  for (const part of (header ?? '').split(';')) { const i = part.indexOf('='); if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim(); }
  return '';
}

/** Returns a Response when the request must be answered by the gate (redirect or refusal), or null to let it through. */
export async function accessGate(request: Request, token: string | undefined): Promise<Response | null> {
  if (!token) return null;
  const url = new URL(request.url);
  if (url.pathname === '/healthz') return null;
  // iOS fetches the Home Screen icon and manifest without the visitor's cookie; these two static assets carry nothing private.
  if (request.method === 'GET' && (url.pathname === '/apple-touch-icon.png' || url.pathname === '/manifest.webmanifest')) return null;
  const digest = await sha256Hex(token);
  const given = url.searchParams.get('access');
  if (given !== null && request.method === 'GET' && constantTimeEqual(await sha256Hex(given), digest)) {
    url.searchParams.delete('access');
    // Never protocol-relative: backslashes become slashes and leading slashes collapse to one, so Location is always a local path.
    const target = safeLocalPath(url.pathname) + (url.search || '');
    return new Response(null, { status: 302, headers: { location: target, 'set-cookie': `${COOKIE}=${digest}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 7}`, 'cache-control': 'no-store' } });
  }
  if (constantTimeEqual(cookieValue(request.headers.get('cookie'), COOKIE), digest)) return null;
  return new Response('Private preview. Open the access link the owner sent you.', { status: 401, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
}

export function safeLocalPath(pathname: string): string {
  const p = pathname.replace(/\\/g, '/').replace(/^\/+/, '');
  return '/' + p;
}

export const PREVIEW_BANNER = '<div class="private-preview" role="note">PRIVATE PREVIEW</div>'; // styled in styles.ts (the CSP forbids inline styles)
export function withPreviewBanner(html: string): string { return html.replace('<body>', '<body>' + PREVIEW_BANNER); }
