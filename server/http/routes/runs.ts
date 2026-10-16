// Runs: queue, list, inspect, follow live, cancel; artifacts.
import { Router } from "express";
import { z } from "zod";
import { and, asc, desc, eq, gt, gte, inArray, lt, lte } from "drizzle-orm";
import { db } from "../../db/client";
import {
  artifacts,
  environments,
  FINAL_STATUSES,
  RUN_STATUSES,
  runEvents,
  stepExecutions,
  testCases,
  testExecutions,
  testSuites,
  users,
  caseVersions,
} from "@shared/schema";
import { requireRole, ws } from "../authz";
import { notFound } from "../../lib/errors";
import { audit } from "../../services/audit";
import { openArtifact } from "../../services/artifacts";
import { enqueueCase, enqueueSuite, requestCancel } from "../../services/runs";
import { idParam, parse } from "../validate";

export const runsRouter = Router({ mergeParams: true });

runsRouter.post("/runs", requireRole("runner"), async (req, res) => {
  const body = parse(
    z
      .object({
        caseId: z.number().int().positive().optional(),
        suiteId: z.number().int().positive().optional(),
        idempotencyKey: z.string().trim().min(8).max(100).optional(),
      })
      .refine((b) => !!b.caseId !== !!b.suiteId, "Give either a caseId or a suiteId"),
    req.body,
  );
  const w = ws(req);
  const opts = { trigger: "manual" as const, requestedBy: req.user!.id, idempotencyKey: body.idempotencyKey ? `api:${w.id}:${body.idempotencyKey}` : null };
  if (body.caseId) {
    const r = await enqueueCase(w.id, body.caseId, opts);
    if ("skipped" in r) return res.status(409).json({ message: r.skipped });
    if (r.created) await audit(req, "run.requested", { type: "run", id: r.run.id }, { caseId: body.caseId });
    return res.status(r.created ? 202 : 200).json({ runId: r.run.id, status: r.run.status });
  }
  const r = await enqueueSuite(w.id, body.suiteId!, opts);
  await audit(req, "run.suite_requested", { type: "suite", id: body.suiteId! }, { queued: r.queued.length, skipped: r.skipped.length });
  res.status(202).json(r);
});

const listQuery = z.object({
  status: z.enum(RUN_STATUSES).optional(),
  outcome: z.enum(["failed", "passed", "active"]).optional(),
  caseId: z.coerce.number().int().positive().optional(),
  suiteId: z.coerce.number().int().positive().optional(),
  trigger: z.enum(["manual", "schedule", "api"]).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

runsRouter.get("/runs", async (req, res) => {
  const q = parse(listQuery, req.query);
  const w = ws(req);
  const outcome =
    q.outcome === "failed"
      ? inArray(testExecutions.status, ["failed", "timed_out", "infrastructure_error"])
      : q.outcome === "passed"
        ? eq(testExecutions.status, "passed")
        : q.outcome === "active"
          ? inArray(testExecutions.status, ["queued", "starting", "running", "cancel_requested"])
          : undefined;
  const rows = await db
    .select({
      id: testExecutions.id,
      caseId: testExecutions.caseId,
      caseName: testCases.name,
      suiteId: testCases.suiteId,
      suiteName: testSuites.name,
      status: testExecutions.status,
      trigger: testExecutions.trigger,
      caseVersion: testExecutions.caseVersion,
      attempt: testExecutions.attempt,
      maxAttempts: testExecutions.maxAttempts,
      queuedAt: testExecutions.queuedAt,
      startTime: testExecutions.startTime,
      endTime: testExecutions.endTime,
      duration: testExecutions.duration,
      errorMessage: testExecutions.errorMessage,
      errorCategory: testExecutions.errorCategory,
      failedStepIndex: testExecutions.failedStepIndex,
      warnings: testExecutions.warnings,
      createdAt: testExecutions.createdAt,
      requestedBy: users.email,
    })
    .from(testExecutions)
    .innerJoin(testCases, eq(testCases.id, testExecutions.caseId))
    .innerJoin(testSuites, eq(testSuites.id, testCases.suiteId))
    .leftJoin(users, eq(users.id, testExecutions.requestedBy))
    .where(
      and(
        eq(testExecutions.workspaceId, w.id),
        q.status ? eq(testExecutions.status, q.status) : undefined,
        outcome,
        q.caseId ? eq(testExecutions.caseId, q.caseId) : undefined,
        q.suiteId ? eq(testCases.suiteId, q.suiteId) : undefined,
        q.trigger ? eq(testExecutions.trigger, q.trigger) : undefined,
        q.from ? gte(testExecutions.createdAt, q.from) : undefined,
        q.to ? lte(testExecutions.createdAt, q.to) : undefined,
        q.before ? lt(testExecutions.id, q.before) : undefined,
      ),
    )
    .orderBy(desc(testExecutions.id))
    .limit(q.limit);
  res.json({ items: rows, nextBefore: rows.length === q.limit ? rows[rows.length - 1].id : null });
});

async function getRun(workspaceId: number, raw: unknown) {
  const id = idParam(raw, "Run");
  const [run] = await db.select().from(testExecutions).where(and(eq(testExecutions.id, id), eq(testExecutions.workspaceId, workspaceId)));
  if (!run) throw notFound("Run");
  return run;
}

runsRouter.get("/runs/:id", async (req, res) => {
  const w = ws(req);
  const run = await getRun(w.id, req.params.id);
  const [c] = await db.select({ name: testCases.name, suiteId: testCases.suiteId, suiteName: testSuites.name, priority: testCases.priority }).from(testCases).innerJoin(testSuites, eq(testSuites.id, testCases.suiteId)).where(eq(testCases.id, run.caseId));
  const [env] = run.environmentId ? await db.select({ name: environments.name, baseUrl: environments.baseUrl }).from(environments).where(eq(environments.id, run.environmentId)) : [];
  const steps = await db.select().from(stepExecutions).where(eq(stepExecutions.executionId, run.id)).orderBy(asc(stepExecutions.attempt), asc(stepExecutions.stepIndex), asc(stepExecutions.id));
  const files = await db
    .select({ id: artifacts.id, kind: artifacts.kind, attempt: artifacts.attempt, stepIndex: artifacts.stepIndex, contentType: artifacts.contentType, sizeBytes: artifacts.sizeBytes, createdAt: artifacts.createdAt })
    .from(artifacts)
    .where(eq(artifacts.executionId, run.id))
    .orderBy(asc(artifacts.id));
  const [version] = run.caseVersion
    ? await db.select({ steps: caseVersions.steps }).from(caseVersions).where(and(eq(caseVersions.caseId, run.caseId), eq(caseVersions.version, run.caseVersion)))
    : [];
  // The previous run of the same test, for "last passed" context.
  const [previousPass] = await db
    .select({ id: testExecutions.id, createdAt: testExecutions.createdAt })
    .from(testExecutions)
    .where(and(eq(testExecutions.caseId, run.caseId), eq(testExecutions.status, "passed"), lt(testExecutions.id, run.id)))
    .orderBy(desc(testExecutions.id))
    .limit(1);
  const [requester] = run.requestedBy ? await db.select({ email: users.email }).from(users).where(eq(users.id, run.requestedBy)) : [];
  res.json({
    ...run,
    caseName: c?.name,
    suiteId: c?.suiteId,
    suiteName: c?.suiteName,
    priority: c?.priority,
    environment: env ?? null,
    requestedByEmail: requester?.email ?? null,
    plannedSteps: (version?.steps as { name: string; action: string; enabled?: boolean }[] | undefined)?.map((s) => ({ name: s.name, action: s.action, enabled: s.enabled !== false })) ?? null,
    steps,
    artifacts: files,
    previousPass: previousPass ?? null,
  });
});

/** Live progress as Server-Sent Events. Reads run_events, so it works across web and worker processes. */
runsRouter.get("/runs/:id/events", async (req, res) => {
  const run = await getRun(ws(req).id, req.params.id);
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  let last = Number(req.headers["last-event-id"] ?? 0) || 0;
  let closed = false;
  req.on("close", () => (closed = true));
  const started = Date.now();
  while (!closed && Date.now() - started < 30 * 60_000) {
    const events = await db.select().from(runEvents).where(and(eq(runEvents.executionId, run.id), gt(runEvents.seq, last))).orderBy(asc(runEvents.seq)).limit(200);
    for (const e of events) {
      res.write(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
      last = e.seq;
    }
    const [cur] = await db.select({ status: testExecutions.status }).from(testExecutions).where(eq(testExecutions.id, run.id));
    if (!cur || (FINAL_STATUSES.includes(cur.status) && events.length === 0)) {
      res.write(`event: end\ndata: ${JSON.stringify({ status: cur?.status })}\n\n`);
      break;
    }
    if (!events.length) res.write(": keep-alive\n\n");
    await new Promise((r) => setTimeout(r, 1000));
  }
  res.end();
});

runsRouter.post("/runs/:id/cancel", requireRole("runner"), async (req, res) => {
  const w = ws(req);
  const run = await getRun(w.id, req.params.id);
  const updated = await requestCancel(w.id, run.id, req.user!.id, `Cancelled by ${req.user!.email}`);
  await audit(req, "run.cancel_requested", { type: "run", id: run.id }, { from: run.status, to: updated?.status });
  res.json({ id: run.id, status: updated?.status });
});

runsRouter.post("/runs/:id/rerun", requireRole("runner"), async (req, res) => {
  const w = ws(req);
  const run = await getRun(w.id, req.params.id);
  const r = await enqueueCase(w.id, run.caseId, { trigger: "manual", requestedBy: req.user!.id });
  if ("skipped" in r) return res.status(409).json({ message: r.skipped });
  await audit(req, "run.requested", { type: "run", id: r.run.id }, { caseId: run.caseId, rerunOf: run.id });
  res.status(202).json({ runId: r.run.id, status: r.run.status });
});

runsRouter.get("/artifacts/:id", async (req, res) => {
  const id = idParam(req.params.id, "File");
  const [a] = await db.select().from(artifacts).where(and(eq(artifacts.id, id), eq(artifacts.workspaceId, ws(req).id)));
  if (!a) throw notFound("File");
  const { stream, size } = await openArtifact(a.storageKey).catch(() => {
    throw notFound("File");
  });
  res.setHeader("Content-Type", a.contentType);
  res.setHeader("Content-Length", String(size));
  res.setHeader("Cache-Control", "private, max-age=3600");
  res.setHeader("Content-Disposition", `${req.query.download ? "attachment" : "inline"}; filename="run-${a.executionId}-${a.kind}-${a.id}.${a.contentType.split("/")[1]?.replace("+xml", "") ?? "bin"}"`);
  stream.pipe(res);
});
