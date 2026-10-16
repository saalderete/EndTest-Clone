// Schedules, notification rules, incidents, deliveries.
import { Router } from "express";
import { z } from "zod";
import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { incidents, notificationDeliveries, notificationRules, schedules, testCases, testSuites } from "@shared/schema";
import { requireRole, ws } from "../authz";
import { badRequest, notFound } from "../../lib/errors";
import { audit } from "../../services/audit";
import { channelStatus, deliver } from "../../services/channels";
import { isValidTimezone, nextRun, nextRuns, PRESETS, validateCron } from "../../services/cron";
import { idParam, parse } from "../validate";

export const schedulesRouter = Router({ mergeParams: true });

schedulesRouter.get("/schedules/presets", (_req, res) => res.json(PRESETS));

schedulesRouter.get("/schedules/preview", (req, res) => {
  const q = parse(z.object({ cron: z.string().max(100), timezone: z.string().max(64).default("UTC") }), req.query);
  try {
    validateCron(q.cron, q.timezone);
    res.json({ valid: true, next: nextRuns(q.cron, q.timezone, 5) });
  } catch (err) {
    res.json({ valid: false, error: (err as Error).message });
  }
});

schedulesRouter.get("/schedules", async (req, res) => {
  const rows = await db
    .select({
      s: schedules,
      caseName: testCases.name,
      caseNeedsReview: testCases.needsReview,
      suiteName: sql<string | null>`coalesce(${testSuites.name}, (SELECT name FROM test_suites WHERE id = ${testCases.suiteId}))`,
    })
    .from(schedules)
    .leftJoin(testCases, eq(testCases.id, schedules.caseId))
    .leftJoin(testSuites, eq(testSuites.id, schedules.suiteId))
    .where(eq(schedules.workspaceId, ws(req).id))
    .orderBy(schedules.paused, schedules.nextRunAt);
  res.json(rows.map((r) => ({ ...r.s, caseName: r.caseName, suiteName: r.suiteName, needsReview: !!r.caseNeedsReview })));
});

const scheduleBody = z.object({
  caseId: z.number().int().positive().optional(),
  suiteId: z.number().int().positive().optional(),
  cron: z.string().trim().max(100),
  timezone: z.string().max(64).refine(isValidTimezone, "Unknown timezone"),
  paused: z.boolean().default(false),
});

/** A schedule can only be live for published, reviewed, active tests. */
async function assertSchedulable(workspaceId: number, caseId?: number | null, suiteId?: number | null) {
  if (caseId) {
    const [c] = await db.select().from(testCases).where(and(eq(testCases.id, caseId), eq(testCases.workspaceId, workspaceId)));
    if (!c) throw notFound("Test");
    if (!c.publishedVersion) throw badRequest("Publish the test before scheduling it.");
    if (c.needsReview) throw badRequest("This test is marked “needs review”. Run it, check the result, and mark it reviewed before scheduling it.");
    if (!c.isActive) throw badRequest("This test is turned off.");
  }
  if (suiteId) {
    const [s] = await db.select().from(testSuites).where(and(eq(testSuites.id, suiteId), eq(testSuites.workspaceId, workspaceId)));
    if (!s) throw notFound("Suite");
  }
}

function checkCron(cron: string, tz: string) {
  try {
    validateCron(cron, tz);
  } catch (err) {
    throw badRequest((err as Error).message);
  }
}

schedulesRouter.post("/schedules", requireRole("editor"), async (req, res) => {
  const body = parse(scheduleBody.refine((b) => !!b.caseId !== !!b.suiteId, "Schedule either a test or a suite"), req.body);
  checkCron(body.cron, body.timezone);
  const w = ws(req);
  if (body.paused) {
    if (body.caseId) {
      const [c] = await db.select({ id: testCases.id }).from(testCases).where(and(eq(testCases.id, body.caseId), eq(testCases.workspaceId, w.id)));
      if (!c) throw notFound("Test");
    }
  } else await assertSchedulable(w.id, body.caseId, body.suiteId);
  const [s] = await db
    .insert(schedules)
    .values({
      workspaceId: w.id,
      caseId: body.caseId ?? null,
      suiteId: body.suiteId ?? null,
      cron: body.cron,
      timezone: body.timezone,
      paused: body.paused,
      nextRunAt: body.paused ? null : nextRun(body.cron, body.timezone),
      createdBy: req.user!.id,
    })
    .returning();
  await audit(req, "schedule.created", { type: "schedule", id: s.id }, { cron: s.cron, timezone: s.timezone, caseId: s.caseId, suiteId: s.suiteId, paused: s.paused });
  res.status(201).json(s);
});

schedulesRouter.patch("/schedules/:id", requireRole("editor"), async (req, res) => {
  const id = idParam(req.params.id, "Schedule");
  const w = ws(req);
  const [cur] = await db.select().from(schedules).where(and(eq(schedules.id, id), eq(schedules.workspaceId, w.id)));
  if (!cur) throw notFound("Schedule");
  const body = parse(z.object({ cron: z.string().trim().max(100), timezone: z.string().max(64), paused: z.boolean() }).partial(), req.body);
  const cron = body.cron ?? cur.cron;
  const timezone = body.timezone ?? cur.timezone;
  const paused = body.paused ?? cur.paused;
  checkCron(cron, timezone);
  if (!paused) await assertSchedulable(w.id, cur.caseId, cur.suiteId);
  // Resuming never backfills missed runs: the next run is computed from now.
  const [s] = await db
    .update(schedules)
    .set({ cron, timezone, paused, nextRunAt: paused ? null : nextRun(cron, timezone), updatedAt: new Date() })
    .where(eq(schedules.id, id))
    .returning();
  const action = body.paused === undefined ? "schedule.updated" : paused ? "schedule.paused" : "schedule.resumed";
  await audit(req, action, { type: "schedule", id }, { cron, timezone, paused });
  res.json(s);
});

schedulesRouter.delete("/schedules/:id", requireRole("editor"), async (req, res) => {
  const id = idParam(req.params.id, "Schedule");
  const [s] = await db.delete(schedules).where(and(eq(schedules.id, id), eq(schedules.workspaceId, ws(req).id))).returning();
  if (!s) throw notFound("Schedule");
  await audit(req, "schedule.deleted", { type: "schedule", id }, { cron: s.cron });
  res.json({ ok: true });
});

schedulesRouter.post("/schedules/pause-all", requireRole("admin"), async (req, res) => {
  const rows = await db
    .update(schedules)
    .set({ paused: true, nextRunAt: null, updatedAt: new Date() })
    .where(and(eq(schedules.workspaceId, ws(req).id), eq(schedules.paused, false)))
    .returning({ id: schedules.id });
  await audit(req, "schedule.paused_all", undefined, { count: rows.length });
  res.json({ paused: rows.length });
});

// ------------------------------------------------------------------ notification rules

const ruleBody = z
  .object({
    caseId: z.number().int().positive().nullable().optional(),
    suiteId: z.number().int().positive().nullable().optional(),
    channel: z.enum(["email", "sms", "webhook"]),
    target: z.string().trim().min(3).max(500),
    onFailure: z.boolean().default(true),
    onRecovery: z.boolean().default(true),
    failureThreshold: z.number().int().min(1).max(20).default(1),
    enabled: z.boolean().default(true),
  })
  .superRefine((r, ctx) => {
    const ok =
      r.channel === "email"
        ? z.string().email().safeParse(r.target).success
        : r.channel === "sms"
          ? /^\+[1-9]\d{7,14}$/.test(r.target)
          : /^https:\/\/[^\s]+$/.test(r.target);
    if (!ok)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["target"],
        message: r.channel === "email" ? "Enter an email address" : r.channel === "sms" ? "Enter a phone number in +15551234567 format" : "Enter an https:// URL",
      });
    if (r.caseId && r.suiteId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["caseId"], message: "Choose a test or a suite, not both" });
  });

async function assertTargetScope(workspaceId: number, caseId?: number | null, suiteId?: number | null) {
  if (caseId) {
    const [c] = await db.select({ id: testCases.id }).from(testCases).where(and(eq(testCases.id, caseId), eq(testCases.workspaceId, workspaceId)));
    if (!c) throw notFound("Test");
  }
  if (suiteId) {
    const [s] = await db.select({ id: testSuites.id }).from(testSuites).where(and(eq(testSuites.id, suiteId), eq(testSuites.workspaceId, workspaceId)));
    if (!s) throw notFound("Suite");
  }
}

schedulesRouter.get("/notification-rules", async (req, res) => {
  const rows = await db
    .select({ r: notificationRules, caseName: testCases.name, suiteName: testSuites.name })
    .from(notificationRules)
    .leftJoin(testCases, eq(testCases.id, notificationRules.caseId))
    .leftJoin(testSuites, eq(testSuites.id, notificationRules.suiteId))
    .where(eq(notificationRules.workspaceId, ws(req).id))
    .orderBy(notificationRules.id);
  res.json({ rules: rows.map((r) => ({ ...r.r, caseName: r.caseName, suiteName: r.suiteName })), channels: channelStatus() });
});

schedulesRouter.post("/notification-rules", requireRole("editor"), async (req, res) => {
  const body = parse(ruleBody, req.body);
  await assertTargetScope(ws(req).id, body.caseId, body.suiteId);
  const [r] = await db.insert(notificationRules).values({ ...body, caseId: body.caseId ?? null, suiteId: body.suiteId ?? null, workspaceId: ws(req).id, createdBy: req.user!.id }).returning();
  await audit(req, "notification_rule.created", { type: "notification_rule", id: r.id }, { channel: r.channel, caseId: r.caseId, suiteId: r.suiteId });
  res.status(201).json(r);
});

schedulesRouter.patch("/notification-rules/:id", requireRole("editor"), async (req, res) => {
  const id = idParam(req.params.id, "Rule");
  const [cur] = await db.select().from(notificationRules).where(and(eq(notificationRules.id, id), eq(notificationRules.workspaceId, ws(req).id)));
  if (!cur) throw notFound("Rule");
  const merged = parse(ruleBody, { ...cur, ...req.body });
  await assertTargetScope(ws(req).id, merged.caseId, merged.suiteId);
  const [r] = await db.update(notificationRules).set({ ...merged, caseId: merged.caseId ?? null, suiteId: merged.suiteId ?? null }).where(eq(notificationRules.id, id)).returning();
  await audit(req, "notification_rule.updated", { type: "notification_rule", id }, { enabled: r.enabled, channel: r.channel });
  res.json(r);
});

schedulesRouter.delete("/notification-rules/:id", requireRole("editor"), async (req, res) => {
  const id = idParam(req.params.id, "Rule");
  const [r] = await db.delete(notificationRules).where(and(eq(notificationRules.id, id), eq(notificationRules.workspaceId, ws(req).id))).returning();
  if (!r) throw notFound("Rule");
  await audit(req, "notification_rule.deleted", { type: "notification_rule", id }, { channel: r.channel });
  res.json({ ok: true });
});

schedulesRouter.post("/notification-rules/:id/test", requireRole("editor"), async (req, res) => {
  const id = idParam(req.params.id, "Rule");
  const [r] = await db.select().from(notificationRules).where(and(eq(notificationRules.id, id), eq(notificationRules.workspaceId, ws(req).id)));
  if (!r) throw notFound("Rule");
  const status = await deliver({
    channel: r.channel,
    target: r.target,
    kind: "test",
    workspaceId: r.workspaceId,
    ruleId: r.id,
    message: { subject: `TestHarvest test alert for ${ws(req).name}`, text: `This is a test alert sent by ${req.user!.email}. If you got it, this alert channel works.` },
    payload: { event: "test", workspace: ws(req).name },
  });
  const [last] = await db.select().from(notificationDeliveries).where(eq(notificationDeliveries.ruleId, r.id)).orderBy(desc(notificationDeliveries.id)).limit(1);
  res.json({ status, error: last?.error ?? null });
});

schedulesRouter.get("/notification-deliveries", async (req, res) => {
  const rows = await db
    .select({ d: notificationDeliveries, caseName: testCases.name })
    .from(notificationDeliveries)
    .leftJoin(incidents, eq(incidents.id, notificationDeliveries.incidentId))
    .leftJoin(testCases, eq(testCases.id, incidents.caseId))
    .where(eq(notificationDeliveries.workspaceId, ws(req).id))
    .orderBy(desc(notificationDeliveries.id))
    .limit(100);
  res.json(rows.map((r) => ({ ...r.d, caseName: r.caseName })));
});

schedulesRouter.get("/incidents", async (req, res) => {
  const rows = await db
    .select({ i: incidents, caseName: testCases.name, priority: testCases.priority })
    .from(incidents)
    .innerJoin(testCases, eq(testCases.id, incidents.caseId))
    .where(and(eq(incidents.workspaceId, ws(req).id), or(isNull(incidents.resolvedAt), sql`${incidents.resolvedAt} > now() - interval '30 days'`)))
    .orderBy(desc(incidents.openedAt))
    .limit(100);
  res.json(rows.map((r) => ({ ...r.i, caseName: r.caseName, priority: r.priority })));
});
