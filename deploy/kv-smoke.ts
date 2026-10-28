// OWNER SMOKE TEST for Deno Deploy + Deno KV. No Qloo key, no LLM key, no secrets: it reads no environment variables.
// 1. Change TOKEN below to a random string of at least 16 characters (the app refuses to serve until you do).
// 2. Deploy this file as its own tiny app. Open https://<url>/<TOKEN>/kv , /<TOKEN>/stream , /<TOKEN>/sleep?s=90 .
// 3. DO NOT SHARE THE URL, and DELETE THE DEPLOYMENT WITHIN THE HOUR.
// Not typechecked by tsconfig (Deno globals). Handler logic and limits live in src/storage/kv-smoke-handler.ts (tested against a fake).
import { makeSmokeHandler } from '../src/storage/kv-smoke-handler.ts';

declare const Deno: { openKv(): Promise<any>; serve(h: (r: Request) => Promise<Response> | Response): void };

const TOKEN = 'CHANGE-ME';

Deno.serve(makeSmokeHandler({ token: TOKEN, openKv: () => Deno.openKv() }));
