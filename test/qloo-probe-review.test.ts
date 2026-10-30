// Adopted verbatim from the independent review competitions/qloo/QLOO-PROBE-REVIEW-extra-tests.test.ts (reviewer a2d070ae).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runProbe, MAX_CALLS } from '../scripts/qloo-minimal-probe.ts';
import { HttpQlooClient } from '../src/qloo/http-client.ts';
const KEY='FAKEQLOOKEY-a1B2c3D4e5F6g7H8';
test('cap literal is 5', () => assert.equal(MAX_CALLS, 5));
test('cap enforced in code: 6th call throws, via the same wiring as the probe', async () => {
  let used=0; const urls:string[]=[];
  const f=(async(u:string)=>{urls.push(u);return new Response(JSON.stringify({success:true,results:[]}),{status:200});}) as any;
  const c=new HttpQlooClient({apiKey:KEY,fetchImpl:f,maxRetries:0,onNetworkCall:()=>{used++; if(used>MAX_CALLS) throw new Error('cap');}});
  for(let i=0;i<MAX_CALLS;i++) await c.searchLocality('Q'+i);
  await assert.rejects(()=>c.searchLocality('Q9'));
  assert.equal(urls.length,MAX_CALLS);
});
test('host override env is not honoured', async () => {
  process.env.QLOO_BASE_URL='https://evil.example'; process.env.QLOO_BASE='https://evil.example';
  const urls:string[]=[]; const f=(async(u:string)=>{urls.push(u);return new Response('{"success":true,"results":[]}',{status:200});}) as any;
  await new HttpQlooClient({apiKey:KEY,fetchImpl:f,maxRetries:0}).searchLocality('X');
  assert.ok(urls.every(u=>u.startsWith('https://hackathon.api.qloo.com/')));
});
test('redirect mode: fetch init must not follow redirects', async () => {
  let init:any; const f=(async(_u:string,i:any)=>{init=i;return new Response('{"success":true,"results":[]}',{status:200});}) as any;
  await new HttpQlooClient({apiKey:KEY,fetchImpl:f,maxRetries:0}).searchLocality('X');
  assert.ok(init.redirect==='manual'||init.redirect==='error','redirect not restricted: '+init.redirect);
});
