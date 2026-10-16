// Workspaces, members, invitations, environments, secrets, audit log.
import { Router } from "express";
import { z } from "zod";
import { and, count, desc, eq, gt, isNull, lt, ne, sql } from "drizzle-orm";
import { db } from "../../db/client";
import {
  auditEvents,
  environments,
  invitations,
  memberships,
  ROLES,
  secrets,
  testCases,
  testSuites,
  users,
  workerHeartbeats,
  workspaces,
  type Role,
} from "@shared/schema";
import { config } from "../../config";
import { atLeast, requireRole, ROLE_INFO, ws } from "../authz";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors";
import { encryptSecret } from "../../lib/crypto";
import { newToken } from "../../lib/crypto";
import { hostAllowed, normalizeHostList } from "../../lib/netpolicy";
import { aiAvailable } from "../../services/ai";
import { audit } from "../../services/audit";
import { channelStatus, deliver } from "../../services/channels";
import { isValidTimezone } from "../../services/cron";
import { idParam, parse } from "../validate";

export const workspacesRouter = Router();
export const workspaceScoped = Router({ mergeParams: true });

const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "workspace";

const timezone = z.string().max(64).refine(isValidTimezone, "Unknown timezone");

workspacesRouter.post("/workspaces", async (req, res) => {
  const body = parse(z.object({ name: z.string().trim().min(2).max(80), timezone: timezone.default("UTC") }), req.body);
  let slug = slugify(body.name);
  for (let i = 2; ; i++) {
    const [taken] = await db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.slug, slug));
    if (!taken) break;
    slug = `${slugify(body.name)}-${i}`;
  }
  const w = await db.transaction(async (tx) => {
    const [w] = await tx.insert(workspaces).values({ name: body.name, slug, timezone: body.timezone, createdBy: req.user!.id }).returning();
    await tx.insert(memberships).values({ workspaceId: w.id, userId: req.user!.id, role: "owner" });
    return w;
  });
  await audit(req, "workspace.created", { type: "workspace", id: w.id }, { name: w.name }, { workspaceId: w.id });
  res.status(201).json({ ...w, role: "owner" });
});

// ---- the workspace itself (all routes below are under /workspaces/:wid)

workspaceScoped.get("/", async (req, res) => {
  res.json({ ...ws(req), role: req.role });
});

workspaceScoped.patch("/", requireRole("admin"), async (req, res) => {
  const body = parse(
    z
      .object({
        name: z.string().trim().min(2).max(80),
        timezone,
        aiEnabled: z.boolean(),
        aiMonthlyBudgetCents: z.number().int().min(0).max(1_000_000),
      })
      .partial(),
    req.body,
  );
  if (body.aiEnabled && !aiAvailable()) throw badRequest("AI features aren't set up on this server (AI_ENABLED and ANTHROPIC_API_KEY).");
  const [w] = await db.update(workspaces).set({ ...body, updatedAt: new Date() }).where(eq(workspaces.id, ws(req).id)).returning();
  await audit(req, "workspace.updated", { type: "workspace", id: w.id }, body);
  res.json({ ...w, role: req.role });
});

workspaceScoped.delete("/", requireRole("owner"), async (req, res) => {
  const body = parse(z.object({ confirmName: z.string() }), req.body);
  if (body.confirmName !== ws(req).name) throw badRequest("Type the workspace name exactly to delete it.");
  await db.delete(workspaces).where(eq(workspaces.id, ws(req).id));
  await audit(req, "workspace.deleted", { type: "workspace", id: ws(req).id }, { name: ws(req).name }, { workspaceId: null });
  res.json({ ok: true });
});

/** Setup checklist: worker, browser, email, schedules. */
workspaceScoped.get("/checks", async (req, res) => {
  const w = ws(req);
  const [worker] = await db
    .select({ n: count(), browserOk: sql<boolean>`bool_or(${workerHeartbeats.browserOk})` })
    .from(workerHeartbeats)
    .where(gt(workerHeartbeats.heartbeatAt, new Date(Date.now() - 60_000)));
  const [envs] = await db.select({ n: count() }).from(environments).where(eq(environments.workspaceId, w.id));
  const [suites] = await db.select({ n: count() }).from(testSuites).where(eq(testSuites.workspaceId, w.id));
  const [published] = await db.select({ n: count() }).from(testCases).where(and(eq(testCases.workspaceId, w.id), sql`${testCases.publishedVersion} IS NOT NULL`));
  const ch = channelStatus();
  res.json({
    workerOnline: worker.n > 0,
    browserOk: !!worker.browserOk,
    notifications: ch,
    hasEnvironment: envs.n > 0,
    hasSuite: suites.n > 0,
    hasPublishedTest: published.n > 0,
    aiAvailable: aiAvailable(),
  });
});

// ---- members and invitations

workspaceScoped.get("/members", async (req, res) => {
  const rows = await db
    .select({ id: users.id, email: users.email, firstName: users.firstName, lastName: users.lastName, role: memberships.role, joinedAt: memberships.createdAt, lastLoginAt: users.lastLoginAt, canSignIn: sql<boolean>`${users.passwordHash} IS NOT NULL` })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(eq(memberships.workspaceId, ws(req).id))
    .orderBy(users.email);
  const pending = atLeast(req.role, "admin")
    ? await db
        .select({ id: invitations.id, email: invitations.email, role: invitations.role, expiresAt: invitations.expiresAt, createdAt: invitations.createdAt })
        .from(invitations)
        .where(and(eq(invitations.workspaceId, ws(req).id), isNull(invitations.acceptedAt), isNull(invitations.revokedAt), gt(invitations.expiresAt, new Date())))
        .orderBy(desc(invitations.createdAt))
    : [];
  res.json({ members: rows, invitations: pending, roles: ROLE_INFO });
});

const roleSchema = z.enum(ROLES);

function assertCanGrant(actor: Role | undefined, role: Role) {
  if (role === "owner" && actor !== "owner") throw forbidden("Only an owner can make someone an owner.");
}

workspaceScoped.post("/invitations", requireRole("admin"), async (req, res) => {
  const body = parse(z.object({ email: z.string().trim().toLowerCase().email().max(254), role: roleSchema }), req.body);
  assertCanGrant(req.role, body.role);
  const [member] = await db
    .select({ id: users.id })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.workspaceId, ws(req).id), eq(sql`lower(${users.email})`, body.email)));
  if (member) throw conflict("That person is already a member.");
  const { token, hash } = newToken();
  const [inv] = await db
    .insert(invitations)
    .values({ workspaceId: ws(req).id, email: body.email, role: body.role, tokenHash: hash, invitedBy: req.user!.id, expiresAt: new Date(Date.now() + 7 * 86400_000) })
    .returning();
  const link = `${config.APP_URL}/invite/${token}`;
  const status = await deliver({
    channel: "email",
    target: body.email,
    kind: "invite",
    workspaceId: ws(req).id,
    message: { subject: `You're invited to ${ws(req).name} on TestHarvest`, text: `${req.user!.name} invited you to join ${ws(req).name} as ${body.role}.\n\nAccept: ${link}\n\nThe link works for 7 days.` },
  });
  await audit(req, "member.invited", { type: "invitation", id: inv.id }, { email: body.email, role: body.role });
  // The link goes back to the admin who created it so they can share it when email is off.
  res.status(201).json({ id: inv.id, email: inv.email, role: inv.role, expiresAt: inv.expiresAt, link, emailStatus: status });
});

workspaceScoped.delete("/invitations/:id", requireRole("admin"), async (req, res) => {
  const id = idParam(req.params.id, "Invitation");
  const [inv] = await db.update(invitations).set({ revokedAt: new Date() }).where(and(eq(invitations.id, id), eq(invitations.workspaceId, ws(req).id))).returning();
  if (!inv) throw notFound("Invitation");
  await audit(req, "member.invitation_revoked", { type: "invitation", id }, { email: inv.email });
  res.json({ ok: true });
});

async function ownerCount(workspaceId: number) {
  const [r] = await db.select({ n: count() }).from(memberships).where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.role, "owner")));
  return r.n;
}

workspaceScoped.patch("/members/:userId", requireRole("admin"), async (req, res) => {
  const { role } = parse(z.object({ role: roleSchema }), req.body);
  const userId = String(req.params.userId);
  const [m] = await db.select().from(memberships).where(and(eq(memberships.workspaceId, ws(req).id), eq(memberships.userId, userId)));
  if (!m) throw notFound("Member");
  assertCanGrant(req.role, role);
  if (m.role === "owner" && req.role !== "owner") throw forbidden("Only an owner can change another owner's role.");
  if (m.role === "owner" && role !== "owner" && (await ownerCount(ws(req).id)) <= 1) throw badRequest("A workspace needs at least one owner.");
  await db.update(memberships).set({ role }).where(and(eq(memberships.workspaceId, ws(req).id), eq(memberships.userId, userId)));
  await audit(req, "member.role_changed", { type: "user", id: userId }, { from: m.role, to: role });
  res.json({ ok: true });
});

workspaceScoped.delete("/members/:userId", async (req, res) => {
  const userId = String(req.params.userId);
  const self = userId === req.user!.id;
  if (!self && !atLeast(req.role, "admin")) throw forbidden();
  const [m] = await db.select().from(memberships).where(and(eq(memberships.workspaceId, ws(req).id), eq(memberships.userId, userId)));
  if (!m) throw notFound("Member");
  if (m.role === "owner" && !self && req.role !== "owner") throw forbidden("Only an owner can remove an owner.");
  if (m.role === "owner" && (await ownerCount(ws(req).id)) <= 1) throw badRequest("A workspace needs at least one owner. Make someone else an owner first.");
  await db.delete(memberships).where(and(eq(memberships.workspaceId, ws(req).id), eq(memberships.userId, userId)));
  await audit(req, self ? "member.left" : "member.removed", { type: "user", id: userId }, { role: m.role });
  res.json({ ok: true });
});

// ---- environments

const envBody = z.object({
  name: z.string().trim().min(1).max(60),
  baseUrl: z
    .string()
    .trim()
    .url("Enter a full URL, like https://staging.example.com")
    .refine((u) => /^https?:\/\//.test(u), "Use http or https"),
  allowedHosts: z.union([z.array(z.string()), z.string()]).optional(),
});

function hostsFor(baseUrl: string, extra: string[] | string | undefined) {
  const base = new URL(baseUrl).hostname.toLowerCase();
  const list = normalizeHostList(extra ?? []);
  if (!hostAllowed(base, list)) list.unshift(base);
  for (const h of list) if (!/^(\*\.)?[a-z0-9.-]+$/.test(h)) throw badRequest(`“${h}” is not a valid host name.`);
  return list;
}

workspaceScoped.get("/environments", async (req, res) => {
  res.json(await db.select().from(environments).where(eq(environments.workspaceId, ws(req).id)).orderBy(environments.name));
});

workspaceScoped.post("/environments", requireRole("admin"), async (req, res) => {
  const body = parse(envBody, req.body);
  const [dupe] = await db.select({ id: environments.id }).from(environments).where(and(eq(environments.workspaceId, ws(req).id), eq(environments.name, body.name)));
  if (dupe) throw conflict("There's already an environment with that name.");
  const [env] = await db
    .insert(environments)
    .values({ workspaceId: ws(req).id, name: body.name, baseUrl: body.baseUrl.replace(/\/+$/, ""), allowedHosts: hostsFor(body.baseUrl, body.allowedHosts) })
    .returning();
  await audit(req, "environment.created", { type: "environment", id: env.id }, { name: env.name, baseUrl: env.baseUrl, allowedHosts: env.allowedHosts });
  res.status(201).json(env);
});

workspaceScoped.patch("/environments/:id", requireRole("admin"), async (req, res) => {
  const id = idParam(req.params.id, "Environment");
  const body = parse(envBody.partial(), req.body);
  const [cur] = await db.select().from(environments).where(and(eq(environments.id, id), eq(environments.workspaceId, ws(req).id)));
  if (!cur) throw notFound("Environment");
  const baseUrl = (body.baseUrl ?? cur.baseUrl).replace(/\/+$/, "");
  const [env] = await db
    .update(environments)
    .set({ name: body.name ?? cur.name, baseUrl, allowedHosts: hostsFor(baseUrl, body.allowedHosts ?? cur.allowedHosts), updatedAt: new Date() })
    .where(eq(environments.id, id))
    .returning();
  await audit(req, "environment.updated", { type: "environment", id }, { baseUrl: env.baseUrl, allowedHosts: env.allowedHosts });
  res.json(env);
});

workspaceScoped.delete("/environments/:id", requireRole("admin"), async (req, res) => {
  const id = idParam(req.params.id, "Environment");
  const [env] = await db.delete(environments).where(and(eq(environments.id, id), eq(environments.workspaceId, ws(req).id))).returning();
  if (!env) throw notFound("Environment");
  await audit(req, "environment.deleted", { type: "environment", id }, { name: env.name });
  res.json({ ok: true });
});

// ---- secrets: values go in, never come out

const secretName = z
  .string()
  .trim()
  .regex(/^[A-Z][A-Z0-9_]{0,63}$/, "Use CAPITALS, digits and underscores, starting with a letter (e.g. STAGING_PASSWORD).");

function requireKey(): Buffer {
  if (!config.encryptionKey) throw badRequest("This server has no APP_ENCRYPTION_KEY, so it can't store secrets. Ask the operator to set one.");
  return config.encryptionKey;
}

workspaceScoped.get("/secrets", async (req, res) => {
  const rows = await db
    .select({ id: secrets.id, name: secrets.name, description: secrets.description, createdAt: secrets.createdAt, rotatedAt: secrets.rotatedAt })
    .from(secrets)
    .where(eq(secrets.workspaceId, ws(req).id))
    .orderBy(secrets.name);
  // Which tests reference each secret, so "is it safe to delete?" is answerable.
  const usage = await db.execute<{ name: string; n: number }>(sql`
    SELECT m[1] AS name, count(DISTINCT s.case_id)::int AS n
    FROM test_steps s JOIN test_cases c ON c.id = s.case_id,
         regexp_matches(coalesce(s.input_value, ''), '\\{\\{\\s*secrets\\.([A-Z][A-Z0-9_]*)\\s*\\}\\}', 'g') AS m
    WHERE c.workspace_id = ${ws(req).id}
    GROUP BY 1`);
  const used = new Map(usage.rows.map((r) => [r.name, r.n]));
  res.json(rows.map((r) => ({ ...r, usedByTests: used.get(r.name) ?? 0 })));
});

workspaceScoped.post("/secrets", requireRole("admin"), async (req, res) => {
  const body = parse(z.object({ name: secretName, value: z.string().min(1).max(4000), description: z.string().trim().max(200).optional() }), req.body);
  const key = requireKey();
  const [dupe] = await db.select({ id: secrets.id }).from(secrets).where(and(eq(secrets.workspaceId, ws(req).id), eq(secrets.name, body.name)));
  if (dupe) throw conflict("A secret with that name exists. Rotate it instead.");
  const [row] = await db
    .insert(secrets)
    .values({ workspaceId: ws(req).id, name: body.name, ciphertext: encryptSecret(body.value, key), description: body.description, createdBy: req.user!.id })
    .returning({ id: secrets.id, name: secrets.name });
  await audit(req, "secret.created", { type: "secret", id: row.id }, { name: row.name });
  res.status(201).json(row);
});

workspaceScoped.put("/secrets/:id", requireRole("admin"), async (req, res) => {
  const id = idParam(req.params.id, "Secret");
  const body = parse(z.object({ value: z.string().min(1).max(4000), description: z.string().trim().max(200).optional() }), req.body);
  const [row] = await db
    .update(secrets)
    .set({ ciphertext: encryptSecret(body.value, requireKey()), rotatedAt: new Date(), ...(body.description !== undefined ? { description: body.description } : {}) })
    .where(and(eq(secrets.id, id), eq(secrets.workspaceId, ws(req).id)))
    .returning({ id: secrets.id, name: secrets.name });
  if (!row) throw notFound("Secret");
  await audit(req, "secret.rotated", { type: "secret", id }, { name: row.name });
  res.json(row);
});

workspaceScoped.delete("/secrets/:id", requireRole("admin"), async (req, res) => {
  const id = idParam(req.params.id, "Secret");
  const [row] = await db.delete(secrets).where(and(eq(secrets.id, id), eq(secrets.workspaceId, ws(req).id))).returning({ name: secrets.name });
  if (!row) throw notFound("Secret");
  await audit(req, "secret.deleted", { type: "secret", id }, { name: row.name });
  res.json({ ok: true });
});

// ---- audit log

workspaceScoped.get("/audit", requireRole("admin"), async (req, res) => {
  const q = parse(z.object({ before: z.coerce.number().int().positive().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }), req.query);
  const rows = await db
    .select({
      id: auditEvents.id,
      action: auditEvents.action,
      targetType: auditEvents.targetType,
      targetId: auditEvents.targetId,
      details: auditEvents.details,
      aiInvolved: auditEvents.aiInvolved,
      createdAt: auditEvents.createdAt,
      actorEmail: users.email,
    })
    .from(auditEvents)
    .leftJoin(users, eq(users.id, auditEvents.actorUserId))
    .where(and(eq(auditEvents.workspaceId, ws(req).id), q.before ? lt(auditEvents.id, q.before) : undefined, ne(auditEvents.action, "auth.login")))
    .orderBy(desc(auditEvents.id))
    .limit(q.limit);
  res.json({ items: rows, nextBefore: rows.length === q.limit ? rows[rows.length - 1].id : null });
});
