import { existsSync } from 'node:fs';
import { join } from 'node:path';
import fastifyCookie from '@fastify/cookie';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { loadCredentials } from './lib/credentials';
import { generateSetupToken } from './lib/session';
import { mailService } from './mail/registry';
import { authRoutes } from './routes/auth';
import { mailRoutes } from './routes/mail';
import { providerSetupRoutes } from './routes/provider-setup';
import { setupRoutes } from './routes/setup';
import { totpRoutes } from './routes/totp';

const PORT = parseInt(process.env.PORT ?? '3000', 10);
const DATA_DIR = process.env.DATA_DIR ?? join(__dirname, '..', 'data');
// The Vite-built frontend, emitted next to the compiled backend: running
// dist/server.js resolves this to dist/web. In dev there's nothing there
// (tsx runs from src/, and the frontend is served by the Vite dev server
// on :5173 instead), so static serving is skipped — see below.
const WEB_DIR = process.env.WEB_DIR ?? join(__dirname, 'web');

async function main() {
  const server = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });

  await server.register(fastifyCookie);
  // global: false — most routes are behind auth already; only the
  // password/TOTP/setup-token guessing surfaces opt in per-route below.
  await server.register(fastifyRateLimit, { global: false });

  // API routes registered before static so they always take priority
  await server.register(setupRoutes, { prefix: '/api', dataDir: DATA_DIR });
  await server.register(authRoutes, { prefix: '/api', dataDir: DATA_DIR });
  await server.register(totpRoutes, { prefix: '/api/totp', dataDir: DATA_DIR });
  await server.register(providerSetupRoutes, { prefix: '/api/provider', dataDir: DATA_DIR });
  await server.register(mailRoutes, { prefix: '/api/mail', dataDir: DATA_DIR });

  // @fastify/static throws on a missing root, so guard: in dev the built
  // frontend doesn't exist and the Vite dev server (with its /api proxy
  // back to this process) serves the pages instead.
  if (existsSync(WEB_DIR)) {
    await server.register(fastifyStatic, { root: WEB_DIR });
  } else {
    server.log.warn(
      { webDir: WEB_DIR },
      'web dir not found; serving API only (use the Vite dev server for the frontend)',
    );
  }

  const credentials = await loadCredentials(DATA_DIR);
  if (!credentials) {
    const token = generateSetupToken();
    console.log(`\n${'='.repeat(52)}`);
    console.log('FIRST RUN — Heimdal has not been configured yet.');
    console.log(`Setup token: ${token}`);
    console.log('Open the app and follow the setup instructions.');
    console.log(`${'='.repeat(52)}\n`);
  }

  await mailService.init(DATA_DIR).catch((err) => {
    server.log.error(err, 'Failed to initialize mail provider on startup');
  });

  await server.listen({ port: PORT, host: '::' });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
