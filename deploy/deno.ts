// Alternative host entry (Deno Deploy), kept as a hedge in case the Workers free plan's CPU limit
// is too tight for custom live runs. Not typechecked by tsconfig (Deno globals). Verify Deno
// Deploy's current free-tier limits before choosing it; needs the owner's approval like any deploy.
//   deployctl deploy --project=seatback deploy/deno.ts   (set env vars in the Deno Deploy dashboard)
import worker, { type Env } from '../src/worker.ts';
import { DenoKvCounter, DenoKvStore } from '../src/storage/deno-kv.ts';

declare const Deno: {
  openKv(path?: string): Promise<any>;
  env: { get(k: string): string | undefined };
  serve(h: (r: Request, info: { remoteAddr: { hostname: string } }) => Promise<Response>): void;
};

const env: Env = {};
for (const k of ['QLOO_API_KEY', 'GEMINI_API_KEY', 'LLM_PROVIDER', 'GEMINI_MODEL', 'MAX_QLOO_CALLS_PER_RUN', 'LIVE_ENABLED', 'DAILY_CALL_CAP', 'PER_VISITOR_CALL_CAP', 'EXAMPLE_CALL_BUDGET', 'PLANNER_ENABLED', 'SCORING_MODE', 'ADMIN_TOKEN', 'LLM_CALLS_PER_RUN', 'EXAMPLE_LLM_CALLS', 'PER_VISITOR_LLM_CALL_CAP', 'DAILY_LLM_CALL_CAP']) {
  const v = Deno.env.get(k);
  if (v) (env as Record<string, string>)[k] = v;
}
// Private replay storage + response cache + an ATOMIC counter for the call caps (Deno KV). UNTESTED against real Deno.
const kv = await Deno.openKv();
env.CACHE_KV = new DenoKvStore(kv) as unknown as Env['CACHE_KV'];
env.COUNTER = new DenoKvCounter(kv);
// Rate limits key on cf-connecting-ip; here it is overwritten with the real socket address so a
// client cannot choose its own bucket (x-forwarded-for is never trusted).
Deno.serve((req, info) => {
  const headers = new Headers(req.headers);
  headers.set('cf-connecting-ip', info.remoteAddr.hostname);
  return worker.fetch(new Request(req, { headers }), env, { waitUntil: () => {} });
});
