import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Artifact smoke test: builds the real Dockerfile and boots the shipped
// image, then hits it over HTTP. Unlike every other suite here, this tests
// the thing we actually deploy — compiled backend, Vite-built frontend,
// Caddy, and the entrypoint — not source. Opt-in (needs Docker, and a full
// image build): `npm run test:smoke`.
//
// No DOMAIN env -> the entrypoint serves plain HTTP on :80 via Caddy
// reverse-proxying the node app on :3000, exactly the LAN-dev config.

describe('shipped Docker image', () => {
  let container: StartedTestContainer;
  let baseUrl: string;

  beforeAll(async () => {
    const image = await GenericContainer.fromDockerfile(process.cwd()).build();
    container = await image
      .withExposedPorts(80)
      // login.html is a static asset served regardless of setup state, so a
      // 200 here means backend + static serving + Caddy are all up.
      .withWaitStrategy(Wait.forHttp('/login.html', 80).forStatusCode(200))
      .withStartupTimeout(120_000)
      .start();
    baseUrl = `http://${container.getHost()}:${container.getMappedPort(80)}`;
  }, 600_000);

  afterAll(async () => {
    await container?.stop().catch(() => {});
  });

  it('serves the login page as a static asset', async () => {
    const res = await fetch(`${baseUrl}/login.html`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Heimdal');
  });

  it('carries the Content-Security-Policy header (helmet) through Caddy', async () => {
    const res = await fetch(`${baseUrl}/login.html`);
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
  });

  it('rejects an unauthenticated request to a protected API route', async () => {
    const res = await fetch(`${baseUrl}/api/totp/status`);
    expect(res.status).toBe(401);
  });

  it('reports unconfigured on a fresh data volume', async () => {
    const res = await fetch(`${baseUrl}/api/status`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ configured: false });
  });
});
