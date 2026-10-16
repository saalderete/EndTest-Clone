// The test worker: claims queued runs from PostgreSQL, executes them in an
// isolated browser context per attempt, records step results, events and
// evidence, then finalizes once and hands off to incident notifications.
import os from "node:os";
import { randomBytes } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { and, eq, inArray } from "drizzle-orm";
import { config } from "../config";
import { db, pool } from "../db/client";
import {
  caseVersions,
  environments,
  secrets as secretsTable,
  stepExecutions,
  testCases,
  testExecutions,
  workerHeartbeats,
  type TestExecution,
} from "@shared/schema";
import { secretNames, stepsSchema, type Step } from "@shared/steps";
import { decryptSecret } from "../lib/crypto";
import { errorFields, log } from "../lib/log";
import { hostAllowed, isBlockedAddress } from "../lib/netpolicy";
import { addEvent } from "../services/runs";
import { saveArtifact, pruneArtifacts } from "../services/artifacts";
import { onRunFinished } from "../services/incidents";
import { classify, makeMasker, StepFailure, runStep, type ErrorCategory, type RunState } from "./engine";
import { startScheduler } from "./scheduler";

const LEASE_SECONDS = 60;
const HEARTBEAT_MS = 10_000;
const VERSION = process.env.npm_package_version ?? "1.0.0";

type Outcome = { status: "passed" | "failed" | "timed_out" | "cancelled" | "infrastructure_error"; error?: string; category?: ErrorCategory; failedStepIndex?: number; warnings: number };

export async function startWorker(): Promise<() => Promise<void>> {
  const workerId = `${os.hostname()}-${process.pid}-${randomBytes(3).toString("hex")}`;
  let browser: Browser | null = null;
  let browserOk: boolean | null = null;
  let stopping = false;
  const active = new Map<number, { cancelled: boolean; contexts: Set<BrowserContext> }>();

  async function getBrowser(): Promise<Browser> {
    if (browser?.isConnected()) return browser;
    browser = await chromium.launch({
      headless: true,
      executablePath: config.CHROMIUM_PATH || undefined,
      args: ["--disable-dev-shm-usage", "--no-default-browser-check"],
    });
    browser.on("disconnected", () => {
      browserOk = false;
    });
    browserOk = true;
    return browser;
  }

  async function heartbeat() {
    await db
      .insert(workerHeartbeats)
      .values({ workerId, hostname: os.hostname(), version: VERSION, heartbeatAt: new Date(), currentExecutionId: [...active.keys()][0] ?? null, browserOk })
      .onConflictDoUpdate({ target: workerHeartbeats.workerId, set: { heartbeatAt: new Date(), currentExecutionId: [...active.keys()][0] ?? null, browserOk } });
    if (active.size) {
      const ids = [...active.keys()];
      await pool.query(`UPDATE test_executions SET lease_expires_at = now() + interval '${LEASE_SECONDS} seconds', heartbeat_at = now() WHERE id = ANY($1) AND worker_id = $2`, [ids, workerId]);
      // Pick up cancellation requests made through the API.
      const { rows } = await pool.query("SELECT id FROM test_executions WHERE id = ANY($1) AND status = 'cancel_requested'", [ids]);
      for (const r of rows) {
        const a = active.get(r.id);
        if (a && !a.cancelled) {
          a.cancelled = true;
          for (const c of a.contexts) void c.close().catch(() => {});
        }
      }
    }
  }

  /** Runs whose worker stopped heartbeating: requeue once, then give up. */
  async function reap() {
    const { rows } = await pool.query(
      `SELECT id, status, (SELECT count(*) FROM run_events v WHERE v.execution_id = e.id AND v.type = 'requeued')::int AS requeues
       FROM test_executions e WHERE status IN ('starting','running','cancel_requested') AND lease_expires_at < now() - interval '15 seconds'
       LIMIT 20`,
    );
    for (const r of rows) {
      if (r.status === "cancel_requested") {
        await finalize(r.id, { status: "cancelled", error: "Cancelled (the worker running it stopped)", category: "cancelled", warnings: 0 }, null);
      } else if (r.requeues === 0) {
        const u = await pool.query(`UPDATE test_executions SET status = 'queued', worker_id = NULL, lease_expires_at = NULL WHERE id = $1 AND lease_expires_at < now() RETURNING id`, [r.id]);
        if (u.rowCount) await addEvent(r.id, { type: "requeued", status: "queued", message: "The worker running this test stopped responding; queued again." });
      } else {
        await finalize(r.id, { status: "infrastructure_error", error: "The worker stopped responding twice while running this test.", category: "infrastructure", warnings: 0 }, null);
      }
    }
  }

  async function claim(): Promise<TestExecution | null> {
    const { rows } = await pool.query(
      `UPDATE test_executions SET status = 'starting', worker_id = $1, lease_expires_at = now() + interval '${LEASE_SECONDS} seconds',
         heartbeat_at = now(), start_time = coalesce(start_time, now())
       WHERE id = (
         SELECT e.id FROM test_executions e
         WHERE e.status = 'queued'
           AND (SELECT count(*) FROM test_executions r WHERE r.workspace_id = e.workspace_id AND r.status IN ('starting','running','cancel_requested')) < $2
         ORDER BY e.queued_at FOR UPDATE SKIP LOCKED LIMIT 1)
       RETURNING id`,
      [workerId, config.WORKSPACE_MAX_CONCURRENCY],
    );
    if (!rows.length) return null;
    const [run] = await db.select().from(testExecutions).where(eq(testExecutions.id, rows[0].id));
    return run;
  }

  async function finalize(runId: number, o: Outcome, startedAt: number | null) {
    const end = new Date();
    const [run] = await db
      .update(testExecutions)
      .set({
        status: o.status,
        endTime: end,
        duration: startedAt ? end.getTime() - startedAt : null,
        errorMessage: o.error?.slice(0, 4000) ?? null,
        errorCategory: o.category ?? null,
        failedStepIndex: o.failedStepIndex ?? null,
        warnings: o.warnings,
        leaseExpiresAt: null,
      })
      .where(and(eq(testExecutions.id, runId), inArray(testExecutions.status, ["starting", "running", "cancel_requested"])))
      .returning();
    if (!run) return; // already final (reaped or emergency-stopped)
    await addEvent(runId, { type: "status", status: o.status, message: o.error ?? (o.status === "passed" ? `Passed${o.warnings ? ` with ${o.warnings} warning(s)` : ""}` : o.status) });
    await onRunFinished(run).catch((err) => log.error("notification processing failed", { runId, ...errorFields(err) }));
  }

  async function execute(run: TestExecution) {
    const flags = { cancelled: false, contexts: new Set<BrowserContext>() };
    active.set(run.id, flags);
    const startedAt = Date.now();
    try {
      // ---- load what the run needs
      const [c] = await db.select().from(testCases).where(eq(testCases.id, run.caseId));
      const [version] = await db.select().from(caseVersions).where(and(eq(caseVersions.caseId, run.caseId), eq(caseVersions.version, run.caseVersion ?? -1)));
      const [env] = run.environmentId ? await db.select().from(environments).where(eq(environments.id, run.environmentId)) : [];
      if (!c || !version || !env) {
        return await finalize(run.id, { status: "infrastructure_error", error: "The test, its published version, or its environment no longer exists.", category: "configuration", warnings: 0 }, startedAt);
      }
      const parsed = stepsSchema.safeParse(version.steps);
      if (!parsed.success) return await finalize(run.id, { status: "failed", error: `The published version is invalid: ${parsed.error.issues[0]?.message}`, category: "configuration", warnings: 0 }, startedAt);
      const steps = parsed.data;
      const secretValues = new Map<string, string>();
      const needed = secretNames(steps.filter((s) => s.enabled));
      if (needed.length) {
        if (!config.encryptionKey) return await finalize(run.id, { status: "failed", error: "This test uses secrets but the runner has no APP_ENCRYPTION_KEY.", category: "configuration", warnings: 0 }, startedAt);
        const rows = await db.select().from(secretsTable).where(and(eq(secretsTable.workspaceId, run.workspaceId), inArray(secretsTable.name, needed)));
        for (const r of rows) secretValues.set(r.name, decryptSecret(r.ciphertext, config.encryptionKey));
      }
      const mask = makeMasker(secretValues);

      await db.update(testExecutions).set({ status: "running" }).where(and(eq(testExecutions.id, run.id), eq(testExecutions.status, "starting")));
      await addEvent(run.id, { type: "status", status: "running", message: `Running on ${workerId}` });

      const deadline = startedAt + c.timeoutMs;
      let outcome: Outcome = { status: "infrastructure_error", warnings: 0 };
      for (let attempt = run.attempt; attempt <= run.maxAttempts; attempt++) {
        if (attempt > run.attempt) {
          await db.update(testExecutions).set({ attempt }).where(eq(testExecutions.id, run.id));
          await addEvent(run.id, { type: "attempt", attempt, message: `Retrying (attempt ${attempt} of ${run.maxAttempts})` });
        }
        outcome = await runAttempt({ run, attempt, steps, env, stepTimeoutMs: c.stepTimeoutMs, timeoutMs: c.timeoutMs, deadline, secretValues, mask, flags });
        if (outcome.status === "passed" || outcome.status === "cancelled" || flags.cancelled || stopping) break;
        if (Date.now() > deadline) break;
      }
      await finalize(run.id, outcome, startedAt);
    } catch (err) {
      log.error("run crashed", { runId: run.id, ...errorFields(err) });
      await finalize(run.id, { status: "infrastructure_error", error: `The runner hit an internal error: ${(err as Error).message}`, category: "infrastructure", warnings: 0 }, startedAt);
    } finally {
      active.delete(run.id);
    }
  }

  async function runAttempt(a: {
    run: TestExecution;
    attempt: number;
    steps: Step[];
    env: { baseUrl: string; allowedHosts: string[] };
    stepTimeoutMs: number;
    timeoutMs: number;
    deadline: number;
    secretValues: Map<string, string>;
    mask: (s: string) => string;
    flags: { cancelled: boolean; contexts: Set<BrowserContext> };
  }): Promise<Outcome> {
    const { run, attempt, steps, mask, flags } = a;
    let context: BrowserContext | null = null;
    let state: RunState | null = null;
    const consoleErrors: string[] = [];
    const failedRequests: string[] = [];
    const tracing = config.TRACE_ON_FAILURE && a.secretValues.size === 0;
    let warnings = 0;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void context?.close().catch(() => {});
    }, Math.max(1_000, a.deadline - Date.now()));

    try {
      const b = await getBrowser().catch((err) => {
        throw new StepFailure(`Couldn't start the browser: ${(err as Error).message}`, "infrastructure");
      });
      context = await b.newContext({ viewport: { width: 1366, height: 900 }, acceptDownloads: true, ignoreHTTPSErrors: false, userAgent: undefined });
      flags.contexts.add(context);
      if (tracing) await context.tracing.start({ screenshots: true, snapshots: true });
      const page: Page = await context.newPage();
      const blockedCache = new Map<string, boolean>();
      let currentIndex = 0;
      const s: RunState = {
        context,
        page,
        mainPage: page,
        baseUrl: a.env.baseUrl,
        allowedHosts: a.env.allowedHosts,
        secrets: a.secretValues,
        allowScripts: config.ALLOW_SCRIPT_STEPS,
        isCancelled: () => flags.cancelled || timedOut,
        policyViolation: null,
        screenshot: async (label) => {
          const data = await s.page.screenshot({ fullPage: true, timeout: 15_000 });
          await saveArtifact({ workspaceId: run.workspaceId, executionId: run.id, attempt, stepIndex: currentIndex, kind: "screenshot", contentType: "image/png", ext: "png", data });
          await addEvent(run.id, { type: "artifact", attempt, stepIndex: currentIndex, message: `Screenshot: ${label}` });
        },
      };
      state = s;

      // Network guard: no private addresses (SSRF), and top-level navigation only to allowed hosts.
      await context.route("**/*", async (route) => {
        try {
          const req = route.request();
          let url: URL;
          try {
            url = new URL(req.url());
          } catch {
            return await route.abort();
          }
          if (!/^https?:$/.test(url.protocol)) return await route.continue();
          // A new tab's first request has no frame yet; it is a top-level navigation.
          let topLevel = false;
          if (req.isNavigationRequest()) {
            try {
              const f = req.frame();
              topLevel = f === f.page().mainFrame();
            } catch {
              topLevel = true;
            }
          }
          if (!config.ALLOW_PRIVATE_NETWORK) {
            let blocked = blockedCache.get(url.hostname);
            if (blocked === undefined) blockedCache.set(url.hostname, (blocked = await isBlockedAddress(url.hostname)));
            if (blocked) {
              if (topLevel) s.policyViolation = `Blocked ${url.hostname}: private network addresses can't be tested from this runner.`;
              return await route.abort("blockedbyclient");
            }
          }
          if (topLevel && !hostAllowed(url.hostname, a.env.allowedHosts)) {
            s.policyViolation = `The page tried to open ${url.hostname}, which isn't in this environment's allowed hosts. Add it to the environment if it's expected.`;
            return await route.abort("blockedbyclient");
          }
          await route.continue();
        } catch {
          // The page or context closed mid-request.
        }
      });
      // Redirects are followed by the browser without passing through route(),
      // so also check where each tab actually lands.
      const watchNavigation = (p: Page) =>
        p.on("framenavigated", (frame) => {
          if (frame !== p.mainFrame()) return;
          let url: URL;
          try {
            url = new URL(frame.url());
          } catch {
            return;
          }
          if (!/^https?:$/.test(url.protocol)) return;
          if (!hostAllowed(url.hostname, a.env.allowedHosts)) {
            s.policyViolation = `The page ended up on ${url.hostname} (through a redirect), which isn't in this environment's allowed hosts.`;
            void p.goto("about:blank").catch(() => {});
          } else if (!config.ALLOW_PRIVATE_NETWORK) {
            void isBlockedAddress(url.hostname).then((blocked) => {
              if (!blocked) return;
              s.policyViolation = `The page ended up on a private network address (${url.hostname}).`;
              void p.goto("about:blank").catch(() => {});
            });
          }
        });
      watchNavigation(page);
      context.on("page", (p) => {
        watchNavigation(p);
        p.on("console", (m) => m.type() === "error" && consoleErrors.push(mask(m.text()).slice(0, 300)));
        p.on("requestfailed", (r) => failedRequests.push(`${r.method()} ${mask(r.url()).slice(0, 200)} ${r.failure()?.errorText ?? ""}`));
      });
      page.on("console", (m) => m.type() === "error" && consoleErrors.push(mask(m.text()).slice(0, 300)));
      page.on("requestfailed", (r) => failedRequests.push(`${r.method()} ${mask(r.url()).slice(0, 200)} ${r.failure()?.errorText ?? ""}`));

      for (let i = 0; i < steps.length; i++) {
        currentIndex = i + 1;
        const step = steps[i];
        const started = new Date();
        if (!step.enabled) {
          await db.insert(stepExecutions).values({ executionId: run.id, attempt, stepIndex: i + 1, stepName: step.name, action: step.action, status: "skipped", duration: 0, log: "Step is turned off", startedAt: started });
          continue;
        }
        if (flags.cancelled) throw new StepFailure("Cancelled", "cancelled");
        await addEvent(run.id, { type: "step_started", attempt, stepIndex: i + 1, message: step.name });
        try {
          const line = await runStep(s, step, a.stepTimeoutMs);
          if (s.policyViolation) throw new StepFailure(s.policyViolation, "policy");
          const ms = Date.now() - started.getTime();
          await db.insert(stepExecutions).values({ executionId: run.id, attempt, stepIndex: i + 1, stepName: step.name, action: step.action, status: "passed", duration: ms, log: mask(line), startedAt: started });
          await addEvent(run.id, { type: "step_finished", status: "passed", attempt, stepIndex: i + 1, message: `${step.name} · ${ms} ms` });
        } catch (err) {
          const f = timedOut ? new StepFailure(`The test exceeded its ${Math.round(a.timeoutMs / 1000)}s time limit.`, "timeout") : classify(err, s);
          const ms = Date.now() - started.getTime();
          const soft = step.options.continueOnFailure && f.category !== "cancelled" && f.category !== "infrastructure" && !timedOut;
          const evidence = soft ? "" : await collectEvidence(s, run, attempt, i + 1, consoleErrors, failedRequests, mask);
          await db.insert(stepExecutions).values({
            executionId: run.id,
            attempt,
            stepIndex: i + 1,
            stepName: step.name,
            action: step.action,
            status: soft ? "warning" : "failed",
            duration: ms,
            errorMessage: mask(f.message).slice(0, 2000),
            log: evidence || null,
            startedAt: started,
          });
          await addEvent(run.id, { type: "step_finished", status: soft ? "warning" : "failed", attempt, stepIndex: i + 1, message: mask(f.message).slice(0, 500) });
          if (soft) {
            warnings++;
            continue;
          }
          if (tracing && context) await saveTrace(context, run, attempt, i + 1);
          const status = f.category === "cancelled" ? "cancelled" : timedOut || (f.category === "timeout" && Date.now() > a.deadline) ? "timed_out" : f.category === "infrastructure" ? "infrastructure_error" : "failed";
          return { status, error: `Step ${i + 1} (${step.name}): ${mask(f.message)}`, category: f.category, failedStepIndex: i + 1, warnings };
        }
      }
      // Evidence of the final state on success.
      const finalShot = await s.page.screenshot({ timeout: 10_000 }).catch(() => null);
      if (finalShot) await saveArtifact({ workspaceId: run.workspaceId, executionId: run.id, attempt, stepIndex: null, kind: "screenshot", contentType: "image/png", ext: "png", data: finalShot });
      return { status: "passed", warnings };
    } catch (err) {
      const f = classify(err, state);
      const status = f.category === "cancelled" ? "cancelled" : timedOut ? "timed_out" : "infrastructure_error";
      return { status, error: mask(f.message), category: timedOut ? "timeout" : f.category, warnings };
    } finally {
      clearTimeout(timer);
      if (context) {
        flags.contexts.delete(context);
        await context.close().catch(() => {});
      }
    }
  }

  async function collectEvidence(s: RunState, run: TestExecution, attempt: number, stepIndex: number, consoleErrors: string[], failedRequests: string[], mask: (x: string) => string) {
    const lines = [`URL: ${mask(s.page.url())}`];
    try {
      const data = await s.page.screenshot({ fullPage: true, timeout: 10_000 });
      await saveArtifact({ workspaceId: run.workspaceId, executionId: run.id, attempt, stepIndex, kind: "screenshot", contentType: "image/png", ext: "png", data });
    } catch {
      lines.push("Screenshot: not available (the page was closed)");
    }
    if (consoleErrors.length) lines.push("Console errors:", ...consoleErrors.slice(-10).map((e) => `  ${e}`));
    if (failedRequests.length) lines.push("Failed requests:", ...failedRequests.slice(-10).map((e) => `  ${e}`));
    return lines.join("\n");
  }

  async function saveTrace(context: BrowserContext, run: TestExecution, attempt: number, stepIndex: number) {
    const file = path.join(os.tmpdir(), `th-trace-${run.id}-${attempt}-${Date.now()}.zip`);
    try {
      await context.tracing.stop({ path: file });
      const data = await readFile(file);
      await saveArtifact({ workspaceId: run.workspaceId, executionId: run.id, attempt, stepIndex, kind: "trace", contentType: "application/zip", ext: "zip", data });
    } catch (err) {
      log.warn("trace save failed", { runId: run.id, ...errorFields(err) });
    } finally {
      await rm(file, { force: true }).catch(() => {});
    }
  }

  // ---- loops
  const slots = config.WORKER_CONCURRENCY;
  let running = 0;
  const loops: NodeJS.Timeout[] = [];

  async function pump() {
    if (stopping) return;
    while (running < slots) {
      const paused = await pool.query("SELECT value FROM system_state WHERE key = 'dispatch_paused'");
      if (paused.rows[0]?.value === true) return;
      const run = await claim();
      if (!run) return;
      running++;
      void execute(run).finally(() => {
        running--;
        void pump().catch((err) => log.error("pump failed", errorFields(err)));
      });
    }
  }

  await getBrowser()
    .then(() => log.info("worker browser ready", { workerId }))
    .catch((err) => {
      browserOk = false;
      log.error("browser launch failed; runs will be marked infrastructure_error until it works", errorFields(err));
    });
  await heartbeat();
  loops.push(setInterval(() => void pump().catch((err) => log.error("pump failed", errorFields(err))), 2_000));
  loops.push(setInterval(() => void heartbeat().catch((err) => log.error("heartbeat failed", errorFields(err))), HEARTBEAT_MS));
  loops.push(setInterval(() => void reap().catch((err) => log.error("reaper failed", errorFields(err))), 15_000));
  loops.push(setInterval(() => void pruneArtifacts().catch((err) => log.error("artifact prune failed", errorFields(err))), 6 * 3600_000));
  const stopScheduler = config.RUN_SCHEDULER ? await startScheduler() : async () => {};
  log.info("worker started", { workerId, slots, scheduler: config.RUN_SCHEDULER });

  return async () => {
    stopping = true;
    loops.forEach(clearInterval);
    await stopScheduler();
    // Give in-flight runs a moment; anything left is requeued by the reaper on the next start.
    const until = Date.now() + 20_000;
    while (running > 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 250));
    await browser?.close().catch(() => {});
    await db.delete(workerHeartbeats).where(eq(workerHeartbeats.workerId, workerId)).catch(() => {});
    log.info("worker stopped", { workerId });
  };
}

