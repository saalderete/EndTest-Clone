// Queueing and cancelling runs. Used by the API (manual runs) and the
// scheduler; the worker picks queued rows up (server/runner/worker.ts).
import { and, eq, inArray, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "../db/client";
import {
  ACTIVE_STATUSES,
  environments,
  testCases,
  testExecutions,
  testSuites,
  type TestExecution,
  type Trigger,
} from "@shared/schema";
import { badRequest, conflict, notFound } from "../lib/errors";

export type EnqueueOptions = {
  trigger: Trigger;
  requestedBy?: string | null;
  scheduleId?: number | null;
  idempotencyKey?: string | null;
  batchId?: string | null;
  // Schedules honour the case's overlap policy; manual runs always queue.
  applyOverlapPolicy?: boolean;
};

export type EnqueueResult = { run: TestExecution; created: boolean } | { skipped: string };

export async function addEvent(executionId: number, e: { type: string; status?: string; stepIndex?: number; attempt?: number; message?: string }) {
  await db.execute(sql`
    INSERT INTO run_events (execution_id, seq, type, status, step_index, attempt, message)
    VALUES (${executionId}, coalesce((SELECT max(seq) FROM run_events WHERE execution_id = ${executionId}), 0) + 1,
            ${e.type}, ${e.status ?? null}, ${e.stepIndex ?? null}, ${e.attempt ?? null}, ${e.message?.slice(0, 2000) ?? null})`);
}

export async function enqueueCase(workspaceId: number, caseId: number, opts: EnqueueOptions): Promise<EnqueueResult> {
  const [row] = await db
    .select({ c: testCases, suiteEnv: testSuites.environmentId })
    .from(testCases)
    .innerJoin(testSuites, eq(testSuites.id, testCases.suiteId))
    .where(and(eq(testCases.id, caseId), eq(testCases.workspaceId, workspaceId)));
  if (!row) throw notFound("Test");
  const c = row.c;
  if (!c.isActive) throw badRequest("This test is turned off. Turn it on to run it.");
  if (!c.publishedVersion) throw badRequest("Publish the test before running it. Runs always use a published version.");
  const environmentId = c.environmentId ?? row.suiteEnv;
  if (!environmentId) throw badRequest("Choose an environment for this test or its suite before running it.");
  const [env] = await db.select({ id: environments.id }).from(environments).where(and(eq(environments.id, environmentId), eq(environments.workspaceId, workspaceId)));
  if (!env) throw badRequest("The test's environment no longer exists. Choose another one.");

  if (opts.idempotencyKey) {
    const [existing] = await db.select().from(testExecutions).where(eq(testExecutions.idempotencyKey, opts.idempotencyKey));
    if (existing) {
      if (existing.workspaceId !== workspaceId || existing.caseId !== caseId) throw conflict("That idempotency key was already used for a different run.");
      return { run: existing, created: false };
    }
  }

  if (opts.applyOverlapPolicy) {
    const active = await db
      .select({ id: testExecutions.id, status: testExecutions.status })
      .from(testExecutions)
      .where(and(eq(testExecutions.caseId, caseId), inArray(testExecutions.status, ACTIVE_STATUSES)));
    if (active.length) {
      if (c.overlapPolicy === "skip") return { skipped: `run #${active[0].id} is still ${active[0].status}` };
      if (c.overlapPolicy === "cancel_previous") for (const a of active) await requestCancel(workspaceId, a.id, null, "Replaced by a newer scheduled run");
    }
  }

  const inserted = await db
    .insert(testExecutions)
    .values({
      workspaceId,
      caseId,
      caseVersion: c.publishedVersion,
      environmentId,
      status: "queued",
      trigger: opts.trigger,
      scheduleId: opts.scheduleId ?? null,
      batchId: opts.batchId ?? null,
      requestedBy: opts.requestedBy ?? null,
      idempotencyKey: opts.idempotencyKey ?? null,
      maxAttempts: c.maxRetries + 1,
    })
    .onConflictDoNothing()
    .returning();
  if (!inserted.length) {
    // Lost a race on the idempotency key: return the winner.
    const [existing] = await db.select().from(testExecutions).where(eq(testExecutions.idempotencyKey, opts.idempotencyKey!));
    return { run: existing, created: false };
  }
  const run = inserted[0];
  await addEvent(run.id, { type: "status", status: "queued", message: `Queued (${opts.trigger}), version ${c.publishedVersion}` });
  return { run, created: true };
}

/** Queues every active, published case in a suite. Unpublished or inactive cases are reported, not run. */
export async function enqueueSuite(workspaceId: number, suiteId: number, opts: EnqueueOptions) {
  const [suite] = await db.select().from(testSuites).where(and(eq(testSuites.id, suiteId), eq(testSuites.workspaceId, workspaceId)));
  if (!suite) throw notFound("Suite");
  const cases = await db.select().from(testCases).where(and(eq(testCases.suiteId, suiteId), eq(testCases.workspaceId, workspaceId))).orderBy(testCases.id);
  const batchId = opts.batchId ?? randomUUID();
  const queued: number[] = [];
  const skipped: { caseId: number; name: string; reason: string }[] = [];
  for (const c of cases) {
    try {
      const r = await enqueueCase(workspaceId, c.id, {
        ...opts,
        batchId,
        idempotencyKey: opts.idempotencyKey ? `${opts.idempotencyKey}:${c.id}` : null,
      });
      if ("skipped" in r) skipped.push({ caseId: c.id, name: c.name, reason: r.skipped });
      else queued.push(r.run.id);
    } catch (err) {
      skipped.push({ caseId: c.id, name: c.name, reason: (err as Error).message });
    }
  }
  return { batchId, queued, skipped };
}

/** Queued runs end immediately; running ones are asked to stop and the worker ends them. */
export async function requestCancel(workspaceId: number, runId: number, userId: string | null, reason = "Cancelled") {
  const [run] = await db.select().from(testExecutions).where(and(eq(testExecutions.id, runId), eq(testExecutions.workspaceId, workspaceId)));
  if (!run) throw notFound("Run");
  const now = new Date();
  if (run.status === "queued") {
    const [done] = await db
      .update(testExecutions)
      .set({ status: "cancelled", cancelRequestedAt: now, cancelledBy: userId, endTime: now, errorMessage: reason, errorCategory: "cancelled" })
      .where(and(eq(testExecutions.id, runId), eq(testExecutions.status, "queued")))
      .returning();
    if (done) {
      await addEvent(runId, { type: "status", status: "cancelled", message: reason });
      return done;
    }
  }
  if (run.status === "starting" || run.status === "running") {
    const [updated] = await db
      .update(testExecutions)
      .set({ status: "cancel_requested", cancelRequestedAt: now, cancelledBy: userId })
      .where(and(eq(testExecutions.id, runId), inArray(testExecutions.status, ["starting", "running"])))
      .returning();
    if (updated) {
      await addEvent(runId, { type: "status", status: "cancel_requested", message: reason });
      return updated;
    }
  }
  const [current] = await db.select().from(testExecutions).where(eq(testExecutions.id, runId));
  return current;
}
