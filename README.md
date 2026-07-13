# Heimdal

Heimdal is an AI-powered mail client frontend designed to cut down on notification
noise and keep your inbox under control.

It connects to your existing mail provider(s) and uses an AI model — your choice of
self-hosted or third-party — to automatically:

- Filter and sort incoming mail based on your own rules and preferences
- Reduce notifications by surfacing only what actually matters
- Draft replies for review, so responding takes less time
- Identify and unsubscribe from promotional/marketing mail

## Goals

- **Installable everywhere**: built as a web app (PWA) that installs on iOS
  (via Safari), Android, Linux, Windows, and macOS, without needing native
  app store releases.
- **Provider-agnostic**: works with Gmail/Google Workspace, Outlook/Microsoft 365,
  and other mail providers, rather than locking you into one ecosystem.
- **AI-agnostic**: supports both self-hosted models and hosted AI providers, so
  you can choose based on cost, privacy, and capability needs.
- **User-configurable filtering**: the rules and intent behind sorting,
  notification suppression, and unsubscribing are driven by your configuration,
  not a fixed black-box policy.

## Architecture

### Scope

Single-user. One person's mail, one set of credentials, one backend instance. Multi-user is not a current goal and the design does not account for it.

### Stack

- **Frontend**: TypeScript PWA, built with Vite (`web/` — a multi-page app: the inbox/compose/settings shell plus standalone auth pages, each its own Vite entry, sharing types with the backend). Biome for lint/format, Vitest for unit tests
- **Backend**: TypeScript/Node.js — chosen for its library ecosystem (WebAuthn, OAuth2, IMAP) and the ability to share type definitions between frontend and backend, which matters for the AI protocol schema
- **AI**: [Vercel AI SDK](https://github.com/vercel/ai) (Apache 2.0) providing a unified interface across local and hosted models — Ollama, Anthropic, OpenAI, and others. The model is configured through the app's settings UI; swapping providers requires no code changes
- **Deployment**: Docker with Caddy handling TLS; backend and frontend in one container

### Authentication

1. Password + optional TOTP on first login
2. TOTP setup uses the `otpauth://` deep link to open the authenticator app directly on mobile, with a QR code fallback for desktop. The code input uses `autocomplete="one-time-code"` for system-level auto-fill (works with iOS built-in authenticator and Google Password Manager; third-party apps like Aegis require manual entry)
3. After initial login, a WebAuthn passkey is registered — subsequent logins use biometrics (Face ID, fingerprint, etc.) instead of password and TOTP

### Mail providers

- **Gmail**: OAuth2 + Gmail API, push notifications via Pub/Sub
- **Outlook**: OAuth2 + Microsoft Graph API, push notifications via webhooks
- **Everything else** (iCloud, Yahoo, Fastmail, self-hosted): generic IMAP with app passwords, `IDLE` for near-realtime events

### AI protocol

The backend acts as a strict intermediary: it extracts structured metadata from each incoming email (sender, subject, snippet, thread context — not raw body by default) and sends it to the model as a typed request. The model returns a typed response — a `ModelDecision` — validated against a schema before any application code sees it. The Vercel AI SDK's `generateObject` enforces this schema at the call site, so the model is a pure function from the application's perspective: structured in, structured out, no direct mail access. Swapping models (local or hosted) requires no application code changes.

#### The "form": `ModelDecision`

`ModelDecision` (`src/ai/types.ts`) is a discriminated union — one member per action the app knows how to carry out, filled out by the model from the email plus whatever context (memories, allowed actions) the request includes. Adding a new capability means adding a new union member; there is deliberately no generic/free-form action, and no send/delete variant exists at all, so a model output can never represent those regardless of what the model tries to produce.

Current + planned members:

- `classify` — labels the email (implemented)
- `prioritize` — urgent/normal/low (implemented)
- `move` — file into a folder (implemented)
- `draftReply` — saves an inert draft for the user to review/edit/send; never auto-sends (implemented)
- `unsubscribe` *(planned)* — flags a promotional email as an unsubscribe candidate
- `acceptMeeting` / `addToCalendar` *(planned)* — flags a calendar-invite email and the app's read on it (accept/decline/tentative, conflicts, etc.)

#### Safety principle: the model classifies, the app supplies facts

For any action where a wrong concrete value would be harmful — a URL that gets clicked, a calendar event that gets created — that value must come from the app's own deterministic extraction, never from the model:

- **Unsubscribe**: the app parses the real `List-Unsubscribe` / `List-Unsubscribe-Post` headers (RFC 8058) itself. The model is only ever asked to classify "is this worth unsubscribing from," never to produce or invent the URL.
- **Calendar invites**: the app parses the real `.ics` / `text/calendar` MIME part itself. The model classifies intent/urgency, never invents event details.

This is a harder guarantee than "the JSON is well-formed" — a model can produce schema-valid output that is still a hallucinated fact. Anything actionable and fact-like is sourced from the app's own parsing; the model's role is limited to judgment calls (classify, prioritize, draft prose, decide relevance).

#### Validation and retry

`generateObject`'s schema enforcement catches structurally invalid output, but a small/local model can still produce validly-shaped JSON with a wrong enum value or a missing piece of required context — this is expected, not exceptional, given the model sizes realistic on self-hosted hardware (see below). The call site wraps `generateObject` in a bounded retry loop: on a validation failure, the error is fed back to the model as a corrective follow-up ("your last response didn't match the schema: `<error>` — try again"), capped at a couple of attempts, then fails gracefully — the email just doesn't get an automated decision that round, rather than retrying forever or crashing the request that triggered it.

#### Tidy plain-text emails — a separate, on-demand call

The classify/route/draft decision above runs for every new email as it arrives — that's the point of the automation. Tidying a plain-text body for readability (see the "Tidy plain-text emails" setting — currently disabled/tagged `AI` in Settings > Reading; a regex-based version was tried and removed as too fragile against real marketing mail) is **not** bundled into that per-arrival call: it only matters for an email the user actually opens, and running it for every arriving message would pay the (CPU-bound, self-hosted) cost for messages nobody reads. It's a separate call, triggered when a card is expanded and the setting is on, using its own small schema (e.g. `{ tidiedText: string }`) — not part of `ModelDecision`.

#### Provider wiring

The model connection uses the Vercel AI SDK's OpenAI-compatible provider pointed at Ollama's OpenAI-compatible endpoint, rather than an Ollama-specific package — the same adapter then works for any other self-hosted OpenAI-compatible server later (vLLM, LM Studio, ...) purely by changing the base URL, keeping the "swap providers with no code changes" promise intact on the self-hosted side. Hosted providers (Anthropic, OpenAI, ...) use their own first-party SDK provider packages; which one is active is a small, contained config choice, not a different code path per feature.

Configuration for now is via environment variables (`OLLAMA_BASE_URL`, `AI_MODEL`) rather than a settings UI — a real settings UI for this is follow-up work, not yet built.

#### Status

Scaffolding exists (`src/ai/types.ts`: `EmailForModel`, `ModelDecision`; `src/ai/apply.ts`: `applyDecision()` turning a `ModelDecision` into `MailProvider` calls) but no live model call site is wired up yet, and the Vercel AI SDK is not yet an installed dependency. Next implementation step is the actual `generateObject` call plus the validation/retry loop described above — built as a standalone, testable-on-its-own function, *not* yet wired into "new mail arrives → auto-classify." Wiring it into that event flow is a separate follow-up once the call site itself is proven out against the real model.

### Local AI models (Ollama)

Ollama is a separate concern — it is not bundled with Heimdal and is set up independently. Think of it like a database: Heimdal connects to it over HTTP, it does not manage it. When running locally, Ollama is defined as an optional service in the Docker Compose file (`docker-compose.yml`) and configured via the environment variables above. If using a hosted provider instead, the Ollama container is simply not started. Ollama can also run on a separate machine entirely — Heimdal only needs a reachable URL.

The Compose service binds Ollama's port to `127.0.0.1` only (not `0.0.0.0`) — it has no authentication of its own, so nothing outside the host should be able to reach it directly; Heimdal reaches it over the Compose network at `http://ollama:11434` regardless.

**Model choice on constrained hardware** (validated on a Raspberry Pi 5, 8GB RAM, CPU-only inference — no GPU/NPU Ollama can use): `gemma4:e2b-it-qat` (Gemma 4's edge-optimized, quantization-aware-trained ~2B-effective-parameter variant, ~4.3GB) is the current recommendation. Google specifically targets this variant at edge devices including Raspberry Pi, and it has native structured-output/function-calling support — relevant given the AI protocol above leans entirely on schema-constrained generation. Larger variants (7B-class and up) give better output quality, especially for `draftReply`, at the cost of noticeably slower CPU inference and less RAM headroom for Heimdal + the OS alongside it; swapping is a one-line config change, not a code change, so it's worth A/B-ing once the call site exists.

Ollama loads a model into RAM on first use and unloads it after an idle timeout (`keep_alive`, default 5 minutes) — it is not a constant background RAM cost, but a bursty one shaped by how often mail actually arrives relative to that window.

## Status

The core mail client — auth, IMAP mail provider, mobile-first read/compose/
reply/forward UI, settings/themes — is implemented and running. The AI layer
is scaffolding only; see the AI protocol "Status" subsection above for where
that stands.

## Local development

`npm run dev` runs the backend (`tsx watch src/server.ts`, the API on
`:3000`) and the Vite dev server (the frontend on `:5173`, proxying `/api`
back to the backend, live reload on save) together. Two ways to reach it,
depending on what you need:

### Quick local test (no domain needed)

To just try it out from a browser or phone on the same network:

```sh
deploy/serve-local.sh
```

This starts both dev servers and prints the URL to use from other devices
on your network (the Vite server, port 5173). No domain, no Caddy, no
certificate needed. The one limitation: without HTTPS, the service worker
won't register (so offline caching won't activate), but the page loads
normally and "Add to Home Screen" still works on iOS/Android.

If Caddy (see below) is currently running, this refuses to start instead of
running alongside it — otherwise it'd also be reachable through your domain,
defeating the point of testing purely locally. Run `deploy/dev-server.sh
stop` first in that case.

### Full setup with your own domain and HTTPS

To run it with live-reload and expose it publicly over HTTPS via
[Caddy](https://caddyserver.com/), both auto-starting on your machine:

```sh
deploy/setup-dev-server.sh yourdomain.com
```

Prerequisites: Arch Linux (pacman), Node.js/npm, a systemd user session, and a
domain whose DNS A record points at your machine's public IP with ports 80/443
forwarded to it.

This installs Caddy, writes `/etc/caddy/Caddyfile` (proxying to the Vite dev
server on `:5173`), installs a `heimdal-dev.service` systemd user unit that
runs `npm run dev`, and enables both to start automatically. Re-run the
script anytime after editing the templates in `deploy/`.

Once set up, control the dev server and Caddy together with:

```sh
deploy/dev-server.sh {start|stop|restart|status}
```

To undo all of that:

```sh
deploy/cleanup-dev-server.sh
```

This stops and disables both services and removes the files the setup script
generated. It leaves the `caddy` package and `node_modules/` installed; the
script prints how to remove those too if you want a fully clean machine.

### Building, testing, and linting

```sh
npm run build      # tsc (backend -> dist/) + vite build (frontend -> dist/web/)
npm start           # runs the production build (node dist/server.js)
npm test            # Vitest — fast unit + integration, no Docker (see below)
npm run typecheck   # tsc --noEmit, backend and frontend
npm run lint        # Biome
npm run format      # Biome, writes fixes
```

#### Test layers

Tests are split into Vitest projects by cost and fidelity. `npm test` runs
the two fast, Docker-free layers; the container-backed layers are opt-in:

```sh
npm test                # web (jsdom) + server (node) — fast, no Docker
npm run test:integration  # ImapProvider vs a real GreenMail server (Testcontainers)
npm run test:smoke        # builds & boots the shipped Docker image, hits it over HTTP
npm run test:all          # all of the above
```

- **web** — frontend logic in jsdom (sanitizer, preview/format helpers,
  address parsing).
- **server** — backend logic in real Node (crypto/AES-GCM, argon2 password
  hashing, sessions, and the Fastify route stack via `.inject()`).
- **integration** (Docker) — the real IMAP/SMTP path: send a message and
  read it back through `ImapProvider` against a live GreenMail container.
- **smoke** (Docker) — the only layer that tests the *artifact we ship*:
  builds the Dockerfile, boots the image (backend + built frontend + Caddy),
  and asserts static serving, security headers, and auth over HTTP.

Backend test files (`*.test.ts` under `src/`) are excluded from the
production build; Docker-backed files use the `*.integration.test.ts` /
`*.smoke.test.ts` suffixes so `npm test` never needs a daemon.

### Docker (distro-agnostic)

For deployment or preview without live-reload. Use `npm run dev` above for
active development with instant browser reload on file changes.

Build and run in a container — the builder stage runs the same
`npm run build` as above; the runtime stage ships only the compiled
output plus Caddy:

**Local (HTTP, no domain needed):**

```sh
docker build -t heimdal .
docker run -d --name heimdal -p 80:80 heimdal
```

**With a domain (HTTPS via Let's Encrypt):**

```sh
docker build -t heimdal .
docker run -d --name heimdal -p 80:80 -p 443:443 -e DOMAIN=witnessthis.eu heimdal
```

The container switches between HTTP and HTTPS mode automatically based on
whether the `DOMAIN` environment variable is set. No distro-specific setup
needed — just Docker.
