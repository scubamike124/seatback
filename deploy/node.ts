// Plain Node host (Railway or any container). Start: `node deploy/node.ts` (Node >= 22.18 runs TypeScript directly).
// Reads settings from environment variables only (names in docs/DEPLOY-RAILWAY.md); no value is printed.
import { checkAccessToken, createNodeServer, envFromProcess, installGracefulShutdown, proxyTrustAdvice } from '../src/server/node-adapter.ts';

const env = envFromProcess(process.env);
const tokenCheck = checkAccessToken(env.DEMO_ACCESS_TOKEN, process.env.NODE_ENV === 'production');
if (tokenCheck.warning) console.warn(tokenCheck.warning);
if (!tokenCheck.ok) process.exit(1);
const proxyAdvice = proxyTrustAdvice(process.env.TRUST_PROXY_HEADER, process.env.NODE_ENV === 'production');
if (proxyAdvice) console.warn(`WARNING: ${proxyAdvice}`);
const port = Number(process.env.PORT ?? 8787);
const server = createNodeServer(env, { trustProxyHeader: process.env.TRUST_PROXY_HEADER });
const stop = installGracefulShutdown(server);
process.on('SIGTERM', () => void stop('SIGTERM'));
process.on('SIGINT', () => void stop('SIGINT'));
server.listen(port, '0.0.0.0', () => {
  const live = !!env.QLOO_API_KEY && env.FORCE_SYNTHETIC !== '1';
  console.log(`Seatback listening on :${port} (${live ? 'Qloo key configured' : 'synthetic fixtures'}; live custom runs ${env.LIVE_ENABLED === '1' ? 'ON' : 'OFF'}; access gate ${env.DEMO_ACCESS_TOKEN ? 'ON' : 'off'}; storage ${process.env.DATA_DIR ? 'files' : 'memory'})`);
});
