# TestHarvest v1: completion report

TestHarvest is a self-hostable browser testing platform. This report covers what was built, how it was verified, and its known limits. The work was done in this order:
- security, real execution, durable scheduling and honest reporting;
- the builder and UI, notifications, and AI behind flags;
- packaging.

A new install starts empty, with no accounts, workspaces, sites or tests. Earlier versions carried code and documents for one customer's old prototype database; all of it has been removed. The design decisions are in [`ARCHITECTURE.md`](ARCHITECTURE.md).

## What changed

| Area | Files | Summary |
|---|---|---|
| Schema and migrations | `migrations/0000_init.sql`, `server/db/*`, `shared/schema.ts` | One migration creates the whole, empty schema: users, workspaces, memberships, invitations, environments, encrypted secrets, suites, tests, immutable versions, schedules, runs, run events, artifacts, worker heartbeats, alert rules, incidents, deliveries, audit events, AI requests, system state. The migration runner uses an advisory lock and runs from source or from the production build. |
| Server | `server/config.ts`, `server/http/*`, `server/lib/*`, `server/services/*` | Express 5 with helmet, a CSRF header plus origin check, rate limits, structured redacted logs, Postgres sessions, role-based authorization scoped to workspaces, and audit logging. |
| Runner | `server/runner/engine.ts`, `worker.ts`, `scheduler.ts`, `server/worker-main.ts` | Playwright step engine with a network guard. Postgres queue with leases, heartbeats and recovery of orphaned runs. Retries, timeouts and cancellation. Leader-elected cron scheduler with idempotent firing and no backfill. Emergency stop. |
| Alerts | `server/services/incidents.ts`, `channels.ts` | One alert when a failure streak reaches its threshold, one on recovery. Email (SMTP), SMS (Twilio) and webhook. Each delivery is logged, and recorded as `suppressed` when sending is off. |
| AI | `server/services/ai.ts`, `server/http/routes/ai.ts`, `client/src/components/ai.tsx` | Draft steps from a description, and explain a failed run. Off by default, budgeted per workspace, secret values scrubbed, page content treated as data, output validated and labelled as unverified. |
| Web app | `client/src/**` | Rebuilt UI covering:<br>• sign-in, invitation and password flows<br>• workspace switcher and command palette<br>• overview, tests, three-pane builder with autosave, undo and versions<br>• runs with live progress and evidence<br>• schedules, test health, analytics, reports<br>• alerts, settings (environments, secrets, members, audit), account and system pages<br>• light and dark themes; works at phone width |
| Admin CLI | `server/scripts/admin.ts`, `migrate.ts` | `gen-key`, `create-owner`, `reset-link`, `system-admin`, `users`; `migrate`. |
| Sample site | `sample-app/server.ts` | A fictional app ("Fieldnote") for end-to-end tests, so nothing contacts a real site. |
| Tests | `tests/**`, `vitest.config.ts` | Unit, API, scheduler, AI (model stubbed) and end-to-end runner tests. |
| Packaging | `Dockerfile`, `docker-compose.yml`, `.dockerignore`, `.env.example`, `.github/workflows/ci.yml`, `README.md` | One image for web and worker, built on the Playwright base image. Compose runs Postgres, migrate, web and worker. CI runs type-check, tests, build and a Docker build. |

## How it was verified

All commands ran in this environment against PostgreSQL 16 and Playwright's Chromium 1194.

| Check | Command | Result |
|---|---|---|
| Type-check, client and server | `npm run check` | No errors |
| Full test suite | `TEST_DATABASE_URL=… npm test` | **63 passed, 0 failed**, 5 files |
| Production build | `npm run build` | Client, server, worker and CLI built |
| Production migrate on an empty database | `node dist/scripts/migrate.js` | `0000_init.sql` applied; zero users, workspaces, sites and tests; schema identical to the one the app was tested against |
| Production server | `node dist/index.js` | `/api/health` OK; UI served |
| GitHub Actions CI | every push | Type-check, all tests with Postgres and Chromium, build, and `docker build` of the Dockerfile |
| Docker image and compose stack | `docker build`, `docker compose up` | Built; stack healthy; a real test passed in the worker container (see "Docker") |
| UI review | Playwright screenshots of every page (desktop light and dark, 390 px phone) against seeded data and real runs on the sample site | No console errors, no horizontal overflow on the phone pages checked. Fixed: wrapping search label, cut-off Publish button on phones, squeezed name column in Test health, duplicated email in Members. |

The test files cover:

- `tests/unit/core.test.ts` (12)
  - encryption round trip and tampering
  - log redaction
  - network policy
  - cron, including a DST change
  - step validation
- `tests/api/permissions.test.ts` (26)
  - 401 for anonymous requests, 404 across workspaces
  - each role's limits
  - secrets never returned
  - CSRF header required
  - invitations
- `tests/api/scheduler.test.ts` (8)
  - one run per due time with two schedulers
  - no backfill after an outage
  - paused schedules
  - emergency stop and resume without a burst
- `tests/api/ai.test.ts` (7)
  - server and workspace flags
  - roles and isolation
  - drafts validated and never saved
  - script steps rejected
  - secret values scrubbed from the description and the evidence
  - untrusted-evidence framing
  - refusals logged
  - budget stop
- `tests/e2e/runner.test.ts` (10), real Chromium against the sample site:
  - login through secrets
  - iframes, new tabs, delayed dialogs, selects and checkboxes
  - soft checks and timeouts
  - cancellation
  - network guard, including redirects and new tabs
  - incidents and alerts
  - lease recovery after a worker dies

## Docker

The image builds from the Playwright base image, so Chromium and its libraries match `playwright@1.56.1`. It is about 4 GB, mostly the browser image.

Verified here:
- **Build.** `docker build` succeeds. The sandbox only reaches npm through a TLS-inspecting proxy, so the local build used a copy of the Dockerfile that adds that proxy's CA. The committed Dockerfile is unchanged and needs no proxy. CI builds it on a clean runner.
- **Compose stack.** `docker compose up` brought up all four services:
  - Postgres healthy;
  - `migrate` applied the schema and exited;
  - `web` answered `/api/ready`;
  - `worker` started and took scheduler leadership.
- **CLI in the container.** `create-owner` and `reset-link` ran in the web image.
- **A real test in the worker container.** Through the API: set a password, signed in, created an environment, suite and test, published, ran it. The run passed in Chromium inside the worker container, and its screenshot downloaded from the web container through the shared volume.

The smoke test caught three production-only bugs, fixed on this branch:
1. **`vite` imported in production.** The production bundle pulled in the dev-only Vite setup, so `web` crashed once dev dependencies were pruned. Static serving now lives in `server/static.ts`, and Vite loads lazily only in development.
2. **Sign-in failed over plain http.** The session cookie was always `Secure` in production. It now follows `APP_URL`: secure when that is HTTPS.
3. **Blank UI over plain http.** Helmet's default `upgrade-insecure-requests` made browsers fetch the app's own assets over HTTPS. That directive and HSTS are now sent only when `APP_URL` is HTTPS.

## Known limitations

- **Only tested against the bundled sample site.** The runner was exercised end to end against a fictional local app, never a real customer site. Expect to tune locators and timeouts on your first real tests.
- **Network guard gaps.** The guard checks every request the page makes, every navigation, and redirects of the main document. Two gaps remain:
  - **Redirects of subresources.** Playwright doesn't route the follow-up requests of a redirected image, script or fetch, so they aren't re-checked.
  - **DNS rebinding.** Host names are resolved and checked before the browser resolves them again.

  Both matter only when a tested site is hostile. On shared deployments, run workers on a network that can't reach internal services, not just behind the in-app guard.
- **AI not exercised against the live API here.** No API key was available. The AI features are covered by tests with the model stubbed out, and a request with a placeholder key reached the API and failed authentication as expected. The first real request will confirm the request shape:
  - structured output;
  - adaptive effort;
  - server-side refusal fallback.

  The SDK passes enum constraints to the model as hints; the server re-validates every response and rejects anything that doesn't fit.
- **Alerts not sent for real.** Tests check that one alert is recorded per failure streak and one on recovery, with sending suppressed. No email, SMS or webhook was actually delivered here. Configure SMTP, Twilio or a webhook and use "Send test" on an alert before relying on it.
- **Artifacts are on local disk.** Several worker hosts need a shared volume. S3-style storage isn't implemented.
- **Accounts.** Email and password plus invitations only. SSO and two-factor sign-in aren't implemented.
- **Script steps** run JavaScript in the page under test when `ALLOW_SCRIPT_STEPS=true`. Leave them off on servers where not every editor is trusted.
- **Client bundle** is about 1 MB minified (290 KB gzipped) in one chunk. Route-level code splitting would speed up first load.
- **Phones.** Every page works at phone width, but the builder is designed for a desktop screen.
