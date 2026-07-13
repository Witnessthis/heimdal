import { resolve } from 'node:path';
import { VitePWA } from 'vite-plugin-pwa';
import { defineConfig } from 'vitest/config';

// Multi-page app, not an SPA: every HTML file in web/ is its own entry,
// served at the same URL it always had (login.html, setup.html, ...).
const page = (name: string) => resolve(__dirname, 'web', `${name}.html`);

export default defineConfig({
  root: 'web',
  plugins: [
    // Replaces the hand-rolled web/public/sw.js (already reduced to a
    // transitional cache-clearing worker) with a Workbox worker emitted
    // at the SAME URL/scope — that's the supersede mechanism: browsers
    // refetch a registered SW script on navigation, bypassing the old
    // worker's fetch handler, so even clients still running the ancient
    // cache-first worker get this one. Never rename or drop the sw.js
    // path while old installed clients may exist.
    VitePWA({
      // skipWaiting + clientsClaim + cleanupOutdatedCaches: updates land
      // on the next navigation without a manual "refresh to update" flow.
      registerType: 'autoUpdate',
      // The checked-in web/public/manifest.webmanifest keeps serving as
      // the PWA manifest — the plugin doesn't generate one.
      manifest: false,
      // Registration happens in web/src/pwa.js (which also clears the
      // legacy pre-Workbox cache), not via an injected inline script.
      injectRegister: false,
      workbox: {
        globPatterns: ['**/*.{html,js,css,png,webmanifest,woff2}'],
        // MPA: all pages are precached individually; never rewrite
        // navigations to some fallback document.
        navigateFallback: null,
        // Nothing runtime-cached on purpose: /api must always hit the
        // network — a service worker intercepting the SSE stream
        // (/api/mail/events) is a classic silent hang.
        runtimeCaching: [],
      },
    }),
  ],
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
    // Two independent test projects under one `npm test` (Vitest 4). The
    // frontend and backend need different roots and environments, so they
    // can't share one flat config — jsdom is right for DOM code and wrong
    // for Node code (and vice versa). See the note on each project below.
    projects: [
      {
        // Frontend: browser-shaped code (DOMParser, localStorage, DOM
        // nodes) — needs a simulated DOM. Root stays web/, exactly as the
        // single-project config did, so the existing suite is unchanged.
        root: resolve(__dirname, 'web'),
        test: {
          name: 'web',
          environment: 'jsdom',
          include: ['src/**/*.test.ts'],
          // See test-setup.ts: works around a real Node/jsdom localStorage
          // collision hit while writing the first localStorage-touching tests.
          setupFiles: ['./src/test-setup.ts'],
        },
      },
      {
        // Backend: real Node code (node:crypto, node:fs, argon2's native
        // binding). Runs in the node environment against the real
        // primitives it uses in production — not a jsdom shim — which is
        // the whole point of testing the crypto/auth core here. Fast and
        // Docker-free; the heavier container-backed suite is a separate
        // project (below) so `npm test` never needs Docker.
        root: __dirname,
        test: {
          name: 'server',
          environment: 'node',
          include: ['src/**/*.test.ts'],
          exclude: ['**/*.integration.test.ts', '**/node_modules/**'],
        },
      },
      {
        // Integration: spins up real dependencies (GreenMail via
        // Testcontainers) and needs a Docker daemon, so it's opt-in only —
        // `npm test` runs web+server; `npm run test:integration` runs this.
        // Long timeouts cover JVM container boot.
        root: __dirname,
        test: {
          name: 'integration',
          environment: 'node',
          include: ['src/**/*.integration.test.ts'],
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
      {
        // Smoke: builds and boots the actual Docker image we ship and hits
        // it over HTTP — the only layer that tests the real artifact
        // (compiled backend + built frontend + Caddy + entrypoint), not
        // source. Slowest of all (a full image build), opt-in via
        // `npm run test:smoke`; the long hookTimeout covers that build.
        root: __dirname,
        test: {
          name: 'smoke',
          environment: 'node',
          include: ['src/**/*.smoke.test.ts'],
          testTimeout: 60_000,
          hookTimeout: 600_000,
        },
      },
    ],
    passWithNoTests: true,
  },
});
