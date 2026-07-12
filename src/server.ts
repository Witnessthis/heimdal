import { existsSync } from 'node:fs';
import { join } from 'node:path';
import fastifyCookie from '@fastify/cookie';
import fastifyHelmet from '@fastify/helmet';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { consumeTotpSeedFile, loadCredentials, setTotpSecret } from './lib/credentials';
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
  // Node's port is never published externally (only Caddy's 80/443 are —
  // see Dockerfile/docker-compose.yml); every request genuinely comes
  // through the local Caddy proxy, so trusting its X-Forwarded-For is safe
  // and required for rate limiting to key on the real client IP.
  const server = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    trustProxy: true,
  });

  await server.register(fastifyCookie);
  // global: false — most routes are behind auth already; only the
  // password/TOTP/setup-token guessing surfaces opt in per-route below.
  await server.register(fastifyRateLimit, { global: false });
  await server.register(fastifyHelmet, {
    // Caddy is the actual TLS-terminating layer and is the one place that
    // genuinely knows whether HTTPS is active (see docker-entrypoint.sh,
    // which only adds Strict-Transport-Security when DOMAIN is set, i.e.
    // when Caddy is actually doing automatic HTTPS). Fastify behind it has
    // no way to know that, so it shouldn't also assert its own HSTS header
    // with a different max-age — one source of truth.
    hsts: false,
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // 'unsafe-inline' is needed for now — every page (index.html
        // included) has a real inline <script>, mostly the synchronous
        // pre-paint theme-init call that has to run before first render
        // to avoid a flash of the wrong theme. Switching to per-page
        // hashes/nonces would close this properly; left as a known
        // follow-up rather than a bigger refactor bundled into this fix.
        scriptSrc: ["'self'", "'unsafe-inline'"],
        // No inline event-handler attributes (onclick=...) exist in the
        // app's own HTML (converted the last few to addEventListener),
        // so this stays at helmet's strict default of 'none'.
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        // http(s): stays open deliberately — remote images in email
        // bodies are blocked by prepareHtmlForRender's own filter, with
        // a user-controlled "load images" opt-in (issue #27); a CSP
        // img-src restriction here would silently defeat that opt-in.
        imgSrc: ["'self'", 'data:', 'http:', 'https:'],
        connectSrc: ["'self'"],
        frameSrc: ["'self'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        // Disabled — Caddy already forces HTTPS in production (and adds
        // HSTS, see docker-entrypoint.sh); this directive would rewrite
        // every http:// request to https://, which breaks the plain-HTTP
        // LAN-IP dev workflow this app is routinely tested against.
        upgradeInsecureRequests: null,
      },
    },
  });

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
  } else {
    // Escape hatch for dev: drop a base32 TOTP secret you already have
    // enrolled elsewhere into data/totp-seed.txt and it's installed
    // right here, skipping the QR-scan/enable flow — see
    // consumeTotpSeedFile for why this is safe to leave lying around
    // (it deletes the file once consumed, so it can't re-seed later).
    const seededSecret = await consumeTotpSeedFile(DATA_DIR);
    if (seededSecret) {
      await setTotpSecret(DATA_DIR, seededSecret);
      console.log(`\n${'='.repeat(52)}`);
      console.log('TOTP secret seeded from data/totp-seed.txt.');
      console.log(`${'='.repeat(52)}\n`);
    }
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
