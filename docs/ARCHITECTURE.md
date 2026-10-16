# TestHarvest architecture

The stack:
- **Client:** React, Vite, Tailwind and shadcn/ui.
- **Server:** Express and TypeScript.
- **Database:** Drizzle on PostgreSQL.
- **Browser automation:** Playwright with Chromium.

## PostgreSQL is the queue

There is no Redis. Runs are rows in the database.

**How a worker takes a run.** It claims one with
`UPDATE ... WHERE id = (SELECT id ... WHERE status='queued' FOR UPDATE SKIP LOCKED LIMIT 1)`.
While it works, it holds a lease (`lease_expires_at`) and renews it with heartbeats.

**Stuck runs.** A reaper checks for runs whose lease has lapsed. It puts each one back in the queue once; if it lapses again, the run finishes as an infrastructure error.

**Scheduling.** Each due time of a schedule gets an idempotency key (`schedule:{dueAt}:{caseId}`), and a unique index on that key means two schedulers can't queue the same run twice. On top of that, only the instance holding a PostgreSQL advisory lock runs the scheduler loop.

This means one less service to deploy. A dedicated queue such as BullMQ could replace the claim query later without changing the run model.

## Processes

- **`web`**: the API, sign-in, live run progress (Server-Sent Events) and the static UI.
- **`worker`**: the scheduler loop, claiming runs, and Playwright. Run as many workers as you need.
- **Development**: both run in one process (`RUN_WORKER=true`).

## Database

The app connects through `pg` (node-postgres) and Drizzle, with any PostgreSQL connection string.

Migrations are numbered SQL files in `migrations/`. They are applied in order by `npm run db:migrate` and recorded in `schema_migrations`. `0000_init.sql` creates the whole schema; later changes go in new files.

The tables:

| Area | Tables |
|---|---|
| Accounts | `users`, `sessions`, `password_tokens` |
| Workspaces | `workspaces`, `memberships` (role), `invitations` |
| Sites | `environments` (base URL, allowed hosts), `secrets` (AES-256-GCM; values never returned) |
| Tests | `test_suites`; `test_cases` (environment, timeout, retries, draft and published state); `test_steps`; `case_versions` (immutable published step lists, which runs execute) |
| Scheduling | `schedules` (cron plus IANA timezone, next run, paused) |
| Runs | `test_executions` (trigger, idempotency key, attempt, worker lease, cancel flag, error category, final status); `step_executions` (per attempt, with a sanitized log and a `warning` status for soft checks); `run_events` (ordered, feed the live view); `artifacts` (screenshots, traces); `worker_heartbeats` |
| Alerts | `notification_rules`, `incidents`, `notification_deliveries` |
| Audit and system | `audit_events`, `ai_requests`, `system_state` (emergency stop) |

## Steps

One validated schema (Zod) is shared by the client and the server.

| Kind | Actions |
|---|---|
| Navigation | `navigate`, `refresh`, `switch_to_new_tab`, `switch_to_main_tab` |
| Interaction | `click`, `fill`, `clear`, `select`, `check`, `uncheck`, `press`, `scroll`, `hover` |
| Waits | `wait`, `wait_for_text`, `wait_for_text_gone`, `wait_for_element`, `wait_for_element_gone` |
| Checks | `assert_text`, `assert_url`, `assert_value`, `assert_visible`, `assert_hidden` |
| Other | `screenshot`, `script` |

Locators can be `role`, `label`, `text`, `placeholder`, `test_id`, `css`, `xpath` or `id`. A step can name an iframe; otherwise the runner also searches same-origin iframes.

A soft check (`continueOnFailure`) records a **warning**, never a silent pass.

## Runner safety

- **Isolation:** each run gets its own browser context, closed in `finally`.
- **Secrets:** `{{secrets.NAME}}` is filled in only inside the worker. Every secret value is masked in logs, errors and events.
- **Network:** navigation is limited to the environment's allowed hosts, and private network addresses are blocked by default.
- **Script steps:** off unless a private runner sets `ALLOW_SCRIPT_STEPS=true`.
- **Limits:** there are step, test and queue timeouts. Cancellation is checked between steps and enforced by closing the context.

## Notifications

Rules are set per test, per suite, or for the whole workspace. Channels are email (SMTP via Nodemailer), SMS (Twilio) and webhooks.

Incidents prevent duplicate alerts: one alert when a test starts failing (or after N failures in a row), and one when it recovers. Every send becomes a `notification_deliveries` row with its status and any error.

Nothing is sent unless `NOTIFICATIONS_ENABLED=true`. When it's off, deliveries are recorded as `suppressed`.

## AI

AI is off unless the server sets `AI_ENABLED` and a key, and each workspace switches it on. Claude is called through the Anthropic SDK, on the server only.

- **Draft a test from a description.** The output is structured and validated against the step schema. It is saved as a draft for review; AI never publishes or schedules anything.
- **Explain a failed run.** The answer is based on that run's step results, errors, logs and screenshot. It is labelled "AI suggestion — not verified".

Requests, tokens and estimated cost are logged per workspace against a monthly budget. Page text and logs go into prompts as untrusted data, and secret values are removed first.
