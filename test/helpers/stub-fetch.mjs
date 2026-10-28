// Preloaded into child processes by live-guard.test.ts (node --import). Replaces fetch so that no real
// network call can happen. Every attempted call is reported on stderr as "STUB-FETCH <url> headers=<names only>".
// Header VALUES are never printed (the X-Api-Key value must not appear anywhere).
// STUB_FETCH_MODE=401 answers every call with HTTP 401; the default is to refuse with an error.
globalThis.fetch = async (url, init = {}) => {
  const names = Object.keys(init.headers ?? {}).join(',');
  process.stderr.write(`STUB-FETCH ${String(url).split('?')[0]} headers=${names}\n`);
  if (process.env.STUB_FETCH_MODE === '401') return new Response('', { status: 401 });
  throw new Error('stub fetch: no network in tests');
};
