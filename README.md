# TestHarvest

Self-hosted browser testing and monitoring. Build tests from steps in the browser (no code), run them on a schedule against your own sites in real Chromium, and get told when something breaks and when it recovers.

A new install starts empty: no accounts, workspaces, sites or tests. You create the first owner from the command line, then add the sites you want to test.

## What it does

- **Workspaces and roles.** Owner, admin, editor, runner and viewer roles, with invitations by link. Every workspace is isolated: data from another workspace returns 404.
- **Environments.** Each environment has a base URL and a list of allowed hosts. The runner refuses to navigate anywhere else, and blocks private networks unless you allow them.
- **Secrets.** Encrypted at rest (AES-256-GCM). Steps refer to them as `{{secrets.NAME}}`, and the values never appear in tests, exports, logs, AI requests or API responses.
- **Builder.** Three panes: steps, the selected step, and the last run's result for that step. Drafts save automatically, with undo and redo. Publishing creates an immutable version, and runs always use a published version.
- **Runner.** Playwright and Chromium, running in separate worker processes. Locators use role, label, text, placeholder, test id, CSS, XPath or id, inside iframes too. Soft checks, new-tab handling, retries, timeouts, cancellation, screenshots, and traces on failure.
- **Durable queue and scheduler on Postgres.** No Redis. Workers take leases and send heartbeats. A run from a worker that dies is requeued once. Schedules use cron and timezones, fire once per due time even with several schedulers, and don't replay a backlog after an outage.
- **Honest results.** Results are passed, failed, timed out, cancelled or infrastructure error. Pass rates exclude infrastructure errors and cancellations, and say so.
- **Test health, analytics, reports.** Pass rate, failure streaks, flakiness, P50/P95 duration and the steps that fail most, all computed from stored runs. Reports can be printed or exported as CSV/JSON.
- **Alerts.** Email, SMS (Twilio) or webhook. One alert when a test starts failing (optionally after N failures) and one when it recovers. Every delivery is logged. Nothing is sent unless `NOTIFICATIONS_ENABLED=true`.
- **Audit log** of security-relevant changes, and an **emergency stop** that halts all runs and schedules across the server.
- **Optional AI assistance**, off by default. Draft steps from a plain-language description, and explain a failed run. Both are suggestions that a person reviews (see [AI](#ai-assistance)).

## Quick start with Docker

```bash
cp .env.example .env
# Fill in POSTGRES_PASSWORD and APP_URL, plus:
#   SESSION_SECRET      openssl rand -base64 48
#   APP_ENCRYPTION_KEY  openssl rand -base64 32

docker compose up -d --build

# Create the first owner. Prints a one-time link to set the password.
docker compose run --rm web node dist/scripts/admin.js create-owner \
  --email you@example.com --workspace "QA" --system-admin
```

Open the link, set a password, then add an environment and your first test.

The compose file runs five services:
- **`db`**: Postgres 16.
- **`migrate`**: applies migrations once, then exits.
- **`web`**: the UI and API on port 5000.
- **`worker`**: runs the tests and the scheduler.
- **Volume**: holds screenshots and traces.

To run more tests in parallel, start more workers: `docker compose up -d --scale worker=3`.

## Local development

You need Node 22 and PostgreSQL 16 or newer.

```bash
npm ci
npx playwright install chromium           # once
cp .env.example .env                      # set DATABASE_URL, SESSION_SECRET, APP_ENCRYPTION_KEY
openssl rand -base64 32                   # a value for APP_ENCRYPTION_KEY
npm run dev                               # migrates, serves on :5000, runs a worker in-process
npm run admin -- create-owner --email you@example.com --workspace "QA" --system-admin
```

To try the runner without touching a real site, run the bundled fictional app with `npm run sample-app`. It serves on `http://127.0.0.1:4400` and you sign in as `grower@fieldnote.test` with password `correct-horse-battery`. Then set `ALLOW_PRIVATE_NETWORK=true`, because the app is on localhost.

| Command | What it does |
|---|---|
| `npm run dev` | Web, API and Vite with hot reload; migrates on start |
| `npm run worker` | A separate worker process (scheduler + runner) |
| `npm run build` / `npm start` / `npm run start:worker` | Production build and processes |
| `npm run db:migrate` | Apply pending migrations (production refuses to start with any pending) |
| `npm run admin -- <cmd>` | `gen-key`, `create-owner`, `reset-link`, `system-admin`, `users` |
| `npm run check` | Type-check client and server |
| `npm test` | All tests (needs Postgres; see below) |

## Tests

```bash
TEST_DATABASE_URL=postgres://postgres@localhost:5432/testharvest_test npm test
```

The test database is dropped and recreated on each run, so its name must contain `test`. The suite covers:
- **Unit:** crypto, redaction, network policy, cron and DST, step validation.
- **API:** authentication, roles and cross-workspace isolation, secrets never returned, the scheduler (exactly-once firing, no backfill, emergency stop), and AI features with the model stubbed out.
- **End to end:** the real worker and Chromium against the sample app (logins with secrets, iframes, new tabs, dialogs, soft checks, timeouts, cancellation, the network guard, lease recovery, incidents and alerts).

CI runs the same suite on every push (`.github/workflows/ci.yml`) and builds the Docker image.

## Configuration

Every setting is documented in [`.env.example`](.env.example). In production the app refuses to start without `SESSION_SECRET` (at least 32 characters), without `APP_ENCRYPTION_KEY`, or with pending migrations.

Keep `APP_ENCRYPTION_KEY` safe and backed up. Workspace secrets can't be decrypted without it.

## Testing your first site

1. **Add the site.** In Settings → Environments, add its address, for example `https://staging.example.com`. The runner only visits that host, plus any others you list, such as a sign-in provider the site redirects to.
2. **Add logins.** Add any test-account passwords in Settings → Secrets, and use them in fill steps as `{{secrets.NAME}}`.
3. **Build a test.** In Tests, create a suite and a test, then add steps in the builder (or use "Draft with AI" if it's on). Finish with a check, such as "Check text is shown", so the test can actually fail.
4. **Publish and run it.** Publishing saves a version. Run it, open the result, and fix any step that didn't find its element.
5. **Schedule it and add an alert.** Give it a schedule, and an alert so failures reach someone.

Use one workspace per team, product or client. Each has its own members, sites, secrets and alerts. Only test sites you own or are authorized to test.

## AI assistance

AI assistance is off unless the server sets `AI_ENABLED=true` and `ANTHROPIC_API_KEY`, and a workspace admin turns it on in Settings. Each workspace has a monthly budget, and requests stop once it's reached.

- **Draft steps.** In the builder, describe a journey and get back draft steps to review. The AI only sees:
  - the description;
  - the environment's address;
  - your secret names (never the values).

  It doesn't visit the site, so labels and wording are guesses, and it lists those guesses. Drafts are checked against the step schema, can't contain script steps, and stay unpublished until a person publishes them.
- **Explain a failure.** On a failed run, the AI reads:
  - the steps and logs;
  - the failure screenshot;
  - the last passing run.

  Secret values are removed first. Page content is passed as data, not instructions. The answer is labelled "AI suggestion — not verified" and stored, so viewing it again is free.

Every request is logged with tokens and estimated cost (`ai_requests`) and audited. The default model is `claude-opus-5-5`; set `AI_MODEL` to change it. Requests use the API's server-side refusal fallback where the model supports it.

## How it fits together

```
browser ── web (Express + React) ──┐
                                   ├── PostgreSQL: data, sessions, run queue, schedules, audit
worker(s) (scheduler + Chromium) ──┘
                │
                └── artifacts directory (screenshots, traces)
```

- **The web process:**
  - handles the API, the UI, and live run progress (Server-Sent Events read from `run_events`, so this works across processes);
  - never runs a browser unless `RUN_WORKER=true`.
- **Workers:**
  - claim queued runs with `FOR UPDATE SKIP LOCKED`, respecting per-workspace concurrency;
  - renew a 60-second lease every 10 seconds;
  - one worker leads the scheduler through a Postgres advisory lock.

[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) explains the design decisions. [`docs/COMPLETION_REPORT.md`](docs/COMPLETION_REPORT.md) lists what was built, how it was verified, and its known limits.

## Operations

- **Emergency stop:** System page (system admins). It cancels queued runs, stops running ones at the next step, and stops schedules from firing. Resuming doesn't replay missed times.
- **Health:** `GET /api/health` (process up) and `GET /api/ready` (database reachable, migrations applied).
- **Backups:** back up Postgres and `APP_ENCRYPTION_KEY`. Artifacts are pruned after `ARTIFACT_RETENTION_DAYS`.
- **Logs:** JSON lines on stdout/stderr, with request ids. Secrets and tokens are redacted.
