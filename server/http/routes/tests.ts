// Suites, test cases, draft steps, published versions.
import { Router } from "express";
import { z } from "zod";
import { and, asc, count, desc, eq, ilike, inArray, max, or, sql } from "drizzle-orm";
import { db } from "../../db/client";
import {
  caseVersions,
  environments,
  notificationRules,
  OVERLAP_POLICIES,
  PRIORITIES,
  schedules,
  secrets,
  testCases,
  testExecutions,
  testSteps,
  testSuites,
  users,
  type TestCase,
} from "@shared/schema";
import { draftStepsSchema, rowToStep, secretNames, stepsSchema, type Step } from "@shared/steps";
import { config } from "../../config";
import { requireRole, ws } from "../authz";
import { badRequest, notFound } from "../../lib/errors";
import { audit } from "../../services/audit";
import { idParam, parse } from "../validate";

export const testsRouter = Router({ mergeParams: true });

const tags = z.array(z.string().trim().min(1).max(40)).max(20);

async function envInWorkspace(workspaceId: number, envId: number | null | undefined) {
  if (envId == null) return;
  const [e] = await db.select({ id: environments.id }).from(environments).where(and(eq(environments.id, envId), eq(environments.workspaceId, workspaceId)));
  if (!e) throw badRequest("That environment doesn't exist in this workspace.");
}

async function getSuite(workspaceId: number, id: number) {
  const [s] = await db.select().from(testSuites).where(and(eq(testSuites.id, id), eq(testSuites.workspaceId, workspaceId)));
  if (!s) throw notFound("Suite");
  return s;
}

async function getCase(workspaceId: number, id: number): Promise<TestCase> {
  const [c] = await db.select().from(testCases).where(and(eq(testCases.id, id), eq(testCases.workspaceId, workspaceId)));
  if (!c) throw notFound("Test");
  return c;
}

async function draftSteps(caseId: number): Promise<Step[]> {
  const rows = await db.select().from(testSteps).where(eq(testSteps.caseId, caseId)).orderBy(asc(testSteps.stepOrder), asc(testSteps.id));
  return rows.map(rowToStep);
}

const normalize = (steps: Step[]) =>
  JSON.stringify(
    steps.map((s) => ({ n: s.name, a: s.action, lt: s.locatorType ?? null, lv: s.locatorValue ?? null, v: s.value ?? null, o: s.options ?? {}, e: s.enabled ?? true })),
  );

/** Secret references in the steps that don't exist in the workspace. */
async function missingSecrets(workspaceId: number, steps: Step[]) {
  const names = secretNames(steps);
  if (!names.length) return [];
  const have = await db.select({ name: secrets.name }).from(secrets).where(and(eq(secrets.workspaceId, workspaceId), inArray(secrets.name, names)));
  const set = new Set(have.map((h) => h.name));
  return names.filter((n) => !set.has(n));
}

async function saveDraft(caseId: number, steps: Step[], userId: string) {
  await db.transaction(async (tx) => {
    await tx.delete(testSteps).where(eq(testSteps.caseId, caseId));
    if (steps.length)
      await tx.insert(testSteps).values(
        steps.map((s, i) => ({
          caseId,
          stepOrder: i + 1,
          stepName: s.name,
          action: s.action,
          locatorType: s.locatorType ?? null,
          locatorValue: s.locatorValue ?? null,
          inputValue: s.value ?? null,
          options: s.options ?? {},
          enabled: s.enabled ?? true,
        })),
      );
    await tx.update(testCases).set({ draftUpdatedAt: new Date(), draftUpdatedBy: userId, updatedAt: new Date() }).where(eq(testCases.id, caseId));
  });
}

// ------------------------------------------------------------------ suites

testsRouter.get("/suites", async (req, res) => {
  const q = parse(z.object({ q: z.string().max(100).optional() }), req.query);
  const w = ws(req);
  const rows = await db
    .select({
      suite: testSuites,
      cases: sql<number>`(SELECT count(*)::int FROM test_cases c WHERE c.suite_id = ${testSuites.id})`,
      lastRunAt: sql<string | null>`(SELECT max(e.created_at) FROM test_executions e JOIN test_cases c ON c.id = e.case_id WHERE c.suite_id = ${testSuites.id})`,
      passed7d: sql<number>`(SELECT count(*)::int FROM test_executions e JOIN test_cases c ON c.id = e.case_id WHERE c.suite_id = ${testSuites.id} AND e.status = 'passed' AND e.created_at > now() - interval '7 days')`,
      finished7d: sql<number>`(SELECT count(*)::int FROM test_executions e JOIN test_cases c ON c.id = e.case_id WHERE c.suite_id = ${testSuites.id} AND e.status IN ('passed','failed','timed_out','infrastructure_error') AND e.created_at > now() - interval '7 days')`,
      environmentName: environments.name,
    })
    .from(testSuites)
    .leftJoin(environments, eq(environments.id, testSuites.environmentId))
    .where(and(eq(testSuites.workspaceId, w.id), q.q ? ilike(testSuites.name, `%${q.q}%`) : undefined))
    .orderBy(asc(testSuites.name));
  res.json(rows.map((r) => ({ ...r.suite, caseCount: r.cases, lastRunAt: r.lastRunAt, passed7d: r.passed7d, finished7d: r.finished7d, environmentName: r.environmentName })));
});

const suiteBody = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).nullable().optional(),
  environmentId: z.number().int().positive().nullable().optional(),
  tags: tags.optional(),
});

testsRouter.post("/suites", requireRole("editor"), async (req, res) => {
  const body = parse(suiteBody, req.body);
  await envInWorkspace(ws(req).id, body.environmentId);
  const [s] = await db.insert(testSuites).values({ ...body, workspaceId: ws(req).id, userId: req.user!.id }).returning();
  await audit(req, "suite.created", { type: "suite", id: s.id }, { name: s.name });
  res.status(201).json(s);
});

testsRouter.patch("/suites/:id", requireRole("editor"), async (req, res) => {
  const id = idParam(req.params.id, "Suite");
  await getSuite(ws(req).id, id);
  const body = parse(suiteBody.partial(), req.body);
  await envInWorkspace(ws(req).id, body.environmentId);
  const [s] = await db.update(testSuites).set({ ...body, updatedAt: new Date() }).where(eq(testSuites.id, id)).returning();
  await audit(req, "suite.updated", { type: "suite", id }, body);
  res.json(s);
});

testsRouter.delete("/suites/:id", requireRole("editor"), async (req, res) => {
  const id = idParam(req.params.id, "Suite");
  const s = await getSuite(ws(req).id, id);
  await db.delete(testSuites).where(eq(testSuites.id, id));
  await audit(req, "suite.deleted", { type: "suite", id }, { name: s.name });
  res.json({ ok: true });
});

// ------------------------------------------------------------------ cases

testsRouter.get("/cases", async (req, res) => {
  const q = parse(
    z.object({
      suiteId: z.coerce.number().int().positive().optional(),
      q: z.string().max(100).optional(),
      tag: z.string().max(40).optional(),
    }),
    req.query,
  );
  const w = ws(req);
  const lastRun = sql<{ id: number; status: string; createdAt: string; duration: number | null } | null>`(
    SELECT json_build_object('id', e.id, 'status', e.status, 'createdAt', e.created_at, 'duration', e.duration)
    FROM test_executions e WHERE e.case_id = ${testCases.id} ORDER BY e.created_at DESC LIMIT 1)`;
  const rows = await db
    .select({
      c: testCases,
      suiteName: testSuites.name,
      stepCount: sql<number>`(SELECT count(*)::int FROM test_steps s WHERE s.case_id = ${testCases.id})`,
      lastRun,
      schedule: sql<{ id: number; cron: string; timezone: string; paused: boolean; nextRunAt: string | null } | null>`(
        SELECT json_build_object('id', s.id, 'cron', s.cron, 'timezone', s.timezone, 'paused', s.paused, 'nextRunAt', s.next_run_at)
        FROM schedules s WHERE s.case_id = ${testCases.id} ORDER BY s.paused, s.id LIMIT 1)`,
    })
    .from(testCases)
    .innerJoin(testSuites, eq(testSuites.id, testCases.suiteId))
    .where(
      and(
        eq(testCases.workspaceId, w.id),
        q.suiteId ? eq(testCases.suiteId, q.suiteId) : undefined,
        q.q ? or(ilike(testCases.name, `%${q.q}%`), ilike(testCases.description, `%${q.q}%`)) : undefined,
        q.tag ? sql`${q.tag} = ANY(${testCases.tags})` : undefined,
      ),
    )
    .orderBy(asc(testSuites.name), asc(testCases.name));
  res.json(rows.map((r) => ({ ...r.c, suiteName: r.suiteName, stepCount: r.stepCount, lastRun: r.lastRun, schedule: r.schedule })));
});

const caseSettings = z.object({
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(4000).nullable(),
  suiteId: z.number().int().positive(),
  environmentId: z.number().int().positive().nullable(),
  priority: z.enum(PRIORITIES),
  tags,
  maxRetries: z.number().int().min(0).max(3),
  timeoutMs: z.number().int().min(10_000).max(1_800_000),
  stepTimeoutMs: z.number().int().min(1_000).max(300_000),
  overlapPolicy: z.enum(OVERLAP_POLICIES),
  isActive: z.boolean(),
});

testsRouter.post("/cases", requireRole("editor"), async (req, res) => {
  const body = parse(caseSettings.partial().required({ name: true, suiteId: true }).extend({ steps: draftStepsSchema.optional() }), req.body);
  const w = ws(req);
  await getSuite(w.id, body.suiteId);
  await envInWorkspace(w.id, body.environmentId);
  const { steps, ...settings } = body;
  const [c] = await db.insert(testCases).values({ ...settings, workspaceId: w.id, createdBy: req.user!.id }).returning();
  if (steps?.length) await saveDraft(c.id, steps as Step[], req.user!.id);
  await audit(req, "case.created", { type: "case", id: c.id }, { name: c.name, steps: steps?.length ?? 0 });
  res.status(201).json(c);
});

testsRouter.get("/cases/:id", async (req, res) => {
  const w = ws(req);
  const c = await getCase(w.id, idParam(req.params.id, "Test"));
  const steps = await draftSteps(c.id);
  let published: { version: number; publishedAt: Date; publishedBy: string | null; note: string | null; steps: Step[] } | null = null;
  if (c.publishedVersion) {
    const [v] = await db
      .select({ v: caseVersions, by: users.email })
      .from(caseVersions)
      .leftJoin(users, eq(users.id, caseVersions.publishedBy))
      .where(and(eq(caseVersions.caseId, c.id), eq(caseVersions.version, c.publishedVersion)));
    if (v) published = { version: v.v.version, publishedAt: v.v.publishedAt, publishedBy: v.by, note: v.v.note, steps: v.v.steps as Step[] };
  }
  const caseSchedules = await db.select().from(schedules).where(eq(schedules.caseId, c.id)).orderBy(schedules.id);
  const [rules] = await db.select({ n: count() }).from(notificationRules).where(eq(notificationRules.caseId, c.id));
  const [suite] = await db.select({ name: testSuites.name, environmentId: testSuites.environmentId }).from(testSuites).where(eq(testSuites.id, c.suiteId));
  const missing = await missingSecrets(w.id, steps);
  res.json({
    ...c,
    suiteName: suite?.name,
    effectiveEnvironmentId: c.environmentId ?? suite?.environmentId ?? null,
    steps,
    published: published ? { version: published.version, publishedAt: published.publishedAt, publishedBy: published.publishedBy, note: published.note } : null,
    hasUnpublishedChanges: !published || normalize(published.steps) !== normalize(steps),
    schedules: caseSchedules,
    notificationRuleCount: rules.n,
    missingSecrets: missing,
    scriptStepsAllowed: config.ALLOW_SCRIPT_STEPS,
  });
});

testsRouter.patch("/cases/:id", requireRole("editor"), async (req, res) => {
  const w = ws(req);
  const c = await getCase(w.id, idParam(req.params.id, "Test"));
  const body = parse(caseSettings.partial().extend({ reviewed: z.literal(true).optional() }), req.body);
  if (body.suiteId) await getSuite(w.id, body.suiteId);
  await envInWorkspace(w.id, body.environmentId);
  const { reviewed, ...settings } = body;
  const [updated] = await db
    .update(testCases)
    .set({ ...settings, ...(reviewed ? { needsReview: false, reviewNote: null } : {}), updatedAt: new Date() })
    .where(eq(testCases.id, c.id))
    .returning();
  await audit(req, reviewed ? "case.reviewed" : "case.updated", { type: "case", id: c.id }, body);
  res.json(updated);
});

testsRouter.put("/cases/:id/steps", requireRole("editor"), async (req, res) => {
  const w = ws(req);
  const c = await getCase(w.id, idParam(req.params.id, "Test"));
  // Drafts may be incomplete; publishing checks every step.
  const { steps } = parse(z.object({ steps: draftStepsSchema }), req.body);
  await saveDraft(c.id, steps as Step[], req.user!.id);
  res.json({ ok: true, savedAt: new Date(), missingSecrets: await missingSecrets(w.id, steps) });
});

testsRouter.post("/cases/:id/publish", requireRole("editor"), async (req, res) => {
  const w = ws(req);
  const c = await getCase(w.id, idParam(req.params.id, "Test"));
  const { note } = parse(z.object({ note: z.string().trim().max(500).optional() }), req.body);
  const steps = await draftSteps(c.id);
  if (!steps.filter((s) => s.enabled).length) throw badRequest("Add at least one enabled step before publishing.");
  const valid = stepsSchema.safeParse(steps);
  if (!valid.success) {
    const i = valid.error.issues[0];
    throw badRequest(`Step ${Number(i.path[0]) + 1}: ${i.message}`, valid.error.issues);
  }
  const missing = await missingSecrets(w.id, steps);
  if (missing.length) throw badRequest(`Create these secrets first: ${missing.join(", ")}.`);
  if (!config.ALLOW_SCRIPT_STEPS && steps.some((s) => s.enabled && s.action === "script"))
    throw badRequest("Script steps are disabled on this server. Turn the step off or replace it.");

  const version = await db.transaction(async (tx) => {
    const [m] = await tx.select({ v: max(caseVersions.version) }).from(caseVersions).where(eq(caseVersions.caseId, c.id));
    const next = (m.v ?? 0) + 1;
    await tx.insert(caseVersions).values({
      caseId: c.id,
      workspaceId: w.id,
      version: next,
      steps: valid.data,
      settings: { timeoutMs: c.timeoutMs, stepTimeoutMs: c.stepTimeoutMs, maxRetries: c.maxRetries },
      note: note || null,
      publishedBy: req.user!.id,
    });
    await tx.update(testCases).set({ publishedVersion: next, updatedAt: new Date() }).where(eq(testCases.id, c.id));
    return next;
  });
  await audit(req, "case.published", { type: "case", id: c.id }, { version, note, steps: steps.length });
  res.json({ version });
});

testsRouter.get("/cases/:id/versions", async (req, res) => {
  const c = await getCase(ws(req).id, idParam(req.params.id, "Test"));
  const rows = await db
    .select({ version: caseVersions.version, note: caseVersions.note, publishedAt: caseVersions.publishedAt, publishedBy: users.email, stepCount: sql<number>`jsonb_array_length(${caseVersions.steps})` })
    .from(caseVersions)
    .leftJoin(users, eq(users.id, caseVersions.publishedBy))
    .where(eq(caseVersions.caseId, c.id))
    .orderBy(desc(caseVersions.version));
  res.json(rows);
});

testsRouter.get("/cases/:id/versions/:version", async (req, res) => {
  const c = await getCase(ws(req).id, idParam(req.params.id, "Test"));
  const [v] = await db.select().from(caseVersions).where(and(eq(caseVersions.caseId, c.id), eq(caseVersions.version, idParam(req.params.version, "Version"))));
  if (!v) throw notFound("Version");
  res.json(v);
});

/** Copies a published version into the draft. Publishing it is a separate, explicit step. */
testsRouter.post("/cases/:id/revert", requireRole("editor"), async (req, res) => {
  const c = await getCase(ws(req).id, idParam(req.params.id, "Test"));
  const { version } = parse(z.object({ version: z.number().int().positive() }), req.body);
  const [v] = await db.select().from(caseVersions).where(and(eq(caseVersions.caseId, c.id), eq(caseVersions.version, version)));
  if (!v) throw notFound("Version");
  await saveDraft(c.id, stepsSchema.parse(v.steps), req.user!.id);
  await audit(req, "case.draft_reverted", { type: "case", id: c.id }, { toVersion: version });
  res.json({ ok: true });
});

testsRouter.post("/cases/:id/duplicate", requireRole("editor"), async (req, res) => {
  const w = ws(req);
  const c = await getCase(w.id, idParam(req.params.id, "Test"));
  const body = parse(z.object({ name: z.string().trim().min(1).max(160).optional(), environmentId: z.number().int().positive().nullable().optional() }), req.body ?? {});
  await envInWorkspace(w.id, body.environmentId);
  const { id: _id, publishedVersion: _p, createdAt: _c, updatedAt: _u, draftUpdatedAt: _d, draftUpdatedBy: _db, needsReview: _n, reviewNote: _r, ...rest } = c;
  const [copy] = await db
    .insert(testCases)
    .values({ ...rest, name: body.name ?? `${c.name} (copy)`, environmentId: body.environmentId !== undefined ? body.environmentId : c.environmentId, createdBy: req.user!.id })
    .returning();
  await saveDraft(copy.id, await draftSteps(c.id), req.user!.id);
  await audit(req, "case.duplicated", { type: "case", id: copy.id }, { from: c.id });
  res.status(201).json(copy);
});

testsRouter.delete("/cases/:id", requireRole("editor"), async (req, res) => {
  const c = await getCase(ws(req).id, idParam(req.params.id, "Test"));
  const [runs] = await db.select({ n: count() }).from(testExecutions).where(eq(testExecutions.caseId, c.id));
  await db.delete(testCases).where(eq(testCases.id, c.id));
  await audit(req, "case.deleted", { type: "case", id: c.id }, { name: c.name, runsDeleted: runs.n });
  res.json({ ok: true });
});

// ------------------------------------------------------------------ import / export

const exportSchema = z.object({
  format: z.literal("testharvest.case.v1"),
  name: z.string().min(1).max(160),
  description: z.string().max(4000).nullable().optional(),
  settings: caseSettings.pick({ priority: true, tags: true, maxRetries: true, timeoutMs: true, stepTimeoutMs: true, overlapPolicy: true }).partial().optional(),
  steps: stepsSchema,
});

testsRouter.get("/cases/:id/export", async (req, res) => {
  const c = await getCase(ws(req).id, idParam(req.params.id, "Test"));
  // Secret references stay references; no secret values are ever exported.
  res.json({
    format: "testharvest.case.v1",
    name: c.name,
    description: c.description,
    settings: { priority: c.priority, tags: c.tags, maxRetries: c.maxRetries, timeoutMs: c.timeoutMs, stepTimeoutMs: c.stepTimeoutMs, overlapPolicy: c.overlapPolicy },
    steps: await draftSteps(c.id),
  });
});

testsRouter.post("/cases/import", requireRole("editor"), async (req, res) => {
  const body = parse(z.object({ suiteId: z.number().int().positive(), data: exportSchema }), req.body);
  const w = ws(req);
  await getSuite(w.id, body.suiteId);
  const [c] = await db
    .insert(testCases)
    .values({ ...(body.data.settings ?? {}), name: body.data.name, description: body.data.description ?? null, suiteId: body.suiteId, workspaceId: w.id, createdBy: req.user!.id })
    .returning();
  await saveDraft(c.id, body.data.steps, req.user!.id);
  await audit(req, "case.imported", { type: "case", id: c.id }, { name: c.name, steps: body.data.steps.length });
  res.status(201).json(c);
});
