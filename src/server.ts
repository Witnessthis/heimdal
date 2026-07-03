import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCookie from '@fastify/cookie';
import { join } from 'path';
import { setupRoutes } from './routes/setup';
import { authRoutes } from './routes/auth';
import { totpRoutes } from './routes/totp';
import { providerSetupRoutes } from './routes/provider-setup';
import { mailRoutes } from './routes/mail';
import { loadCredentials } from './lib/credentials';
import { generateSetupToken } from './lib/session';
import { mailService } from './mail/registry';

const PORT = parseInt(process.env.PORT ?? '3000', 10);
const DATA_DIR = process.env.DATA_DIR ?? join(__dirname, '..', 'data');
const WEB_DIR = join(__dirname, '..', 'web');

async function main() {
  const server = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });

  await server.register(fastifyCookie);

  // API routes registered before static so they always take priority
  await server.register(setupRoutes, { prefix: '/api', dataDir: DATA_DIR });
  await server.register(authRoutes, { prefix: '/api', dataDir: DATA_DIR });
  await server.register(totpRoutes, { prefix: '/api/totp', dataDir: DATA_DIR });
  await server.register(providerSetupRoutes, { prefix: '/api/provider', dataDir: DATA_DIR });
  await server.register(mailRoutes, { prefix: '/api/mail', dataDir: DATA_DIR });

  await server.register(fastifyStatic, { root: WEB_DIR });

  const credentials = await loadCredentials(DATA_DIR);
  if (!credentials) {
    const token = generateSetupToken();
    console.log('\n' + '='.repeat(52));
    console.log('FIRST RUN — Heimdal has not been configured yet.');
    console.log(`Setup token: ${token}`);
    console.log('Open the app and follow the setup instructions.');
    console.log('='.repeat(52) + '\n');
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
