import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// Multi-page app, not an SPA: every HTML file in web/ is its own entry,
// served at the same URL it always had (login.html, setup.html, ...).
const page = (name: string) => resolve(__dirname, 'web', `${name}.html`);

export default defineConfig({
  root: 'web',
  build: {
    // Alongside the backend's tsc output (dist/server.js + dist/web/) so
    // deployment ships one directory. outDir sits outside `root`, which
    // is why emptyOutDir must be opted into explicitly.
    outDir: resolve(__dirname, 'dist/web'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: page('index'),
        login: page('login'),
        setup: page('setup'),
        'totp-prompt': page('totp-prompt'),
        'totp-setup': page('totp-setup'),
        'connect-provider': page('connect-provider'),
        'connect-imap': page('connect-imap'),
      },
    },
  },
  server: {
    // host: true = listen on the LAN too — testing on a real phone over
    // the local network is this project's primary dev loop.
    host: true,
    // The backend (tsx watch, port 3000) owns /api; the Vite dev server
    // owns the pages. http-proxy streams SSE (/api/mail/events) fine.
    proxy: {
      '/api': { target: 'http://localhost:3000' },
    },
    // Vite rejects unknown Host headers by default. The Caddy-fronted
    // dev-domain flow (deploy/setup-dev-server.sh) proxies a real domain
    // here, which needs allow-listing — symptom otherwise is a blank 403.
    allowedHosts: process.env.HEIMDAL_DEV_DOMAIN ? [process.env.HEIMDAL_DEV_DOMAIN] : undefined,
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
    // No test files exist yet — they arrive as modules get extracted out
    // of index.html; a bare `npm test` shouldn't fail until then.
    passWithNoTests: true,
  },
});
