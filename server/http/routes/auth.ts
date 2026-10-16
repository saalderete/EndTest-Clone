// Sign-in, sign-out, passwords, invitations. No seeded accounts and no demo
// bypass: the first owner comes from `npm run admin -- create-owner`.
import { Router, type Request } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import bcrypt from "bcrypt";
import { z } from "zod";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { invitations, memberships, passwordTokens, users, workspaces } from "@shared/schema";
import { config } from "../../config";
import { authVersion, publicUser, requireUser } from "../authz";
import { badRequest, conflict, HttpError, unauthorized } from "../../lib/errors";
import { hashToken, newToken, randomId } from "../../lib/crypto";
import { audit } from "../../services/audit";
import { deliver } from "../../services/channels";
import { parse } from "../validate";

const BCRYPT_ROUNDS = 12;
// Compared against when the email is unknown, so timing doesn't reveal which accounts exist.
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", BCRYPT_ROUNDS);
const COMMON = new Set(["password123", "password1234", "1234567890", "qwertyuiop", "admin12345", "letmein123", "welcome123"]);

export const passwordSchema = z
  .string()
  .min(10, "Use at least 10 characters.")
  .max(200)
  .refine((p) => !COMMON.has(p.toLowerCase()), "That password is too common.");
const emailSchema = z.string().trim().toLowerCase().email("Enter a valid email address.").max(254);

export async function hashPassword(p: string) {
  return bcrypt.hash(p, BCRYPT_ROUNDS);
}

/** A single-use link for setting or resetting a password, valid for `hours`. */
export async function createPasswordLink(userId: string, purpose: "set_password" | "reset_password" | "verify_email", hours: number) {
  const { token, hash } = newToken();
  await db.insert(passwordTokens).values({ userId, tokenHash: hash, purpose, expiresAt: new Date(Date.now() + hours * 3600_000) });
  const page = purpose === "verify_email" ? "verify-email" : "set-password";
  return `${config.APP_URL}/${page}?token=${token}`;
}

async function startSession(req: Request, user: typeof users.$inferSelect) {
  // A new session ID on every sign-in (no session fixation).
  await new Promise<void>((resolve, reject) => req.session.regenerate((e) => (e ? reject(e) : resolve())));
  req.session.userId = user.id;
  req.session.authVersion = authVersion(user);
  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
}

async function myWorkspaces(userId: string) {
  return db
    .select({ id: workspaces.id, name: workspaces.name, slug: workspaces.slug, timezone: workspaces.timezone, isDemo: workspaces.isDemo, role: memberships.role })
    .from(memberships)
    .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
    .where(eq(memberships.userId, userId))
    .orderBy(workspaces.name);
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => `${ipKeyGenerator(req.ip ?? "")}|${String(req.body?.email ?? "").toLowerCase()}`,
  handler: (_req, _res, next) => next(new HttpError(429, "Too many sign-in attempts. Wait 15 minutes and try again.", "rate_limited")),
});
const mailLimiter = rateLimit({
  windowMs: 60 * 60_000,
  limit: 5,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  handler: (_req, _res, next) => next(new HttpError(429, "Too many requests. Try again later.", "rate_limited")),
});

export const authRouter = Router();

authRouter.get("/auth/me", async (req, res) => {
  if (!req.user) return res.json({ user: null, workspaces: [], signupEnabled: config.ALLOW_SIGNUP });
  res.json({ user: req.user, workspaces: await myWorkspaces(req.user.id), signupEnabled: config.ALLOW_SIGNUP });
});

authRouter.post("/auth/login", loginLimiter, async (req, res) => {
  const body = parse(z.object({ email: emailSchema, password: z.string().min(1).max(200) }), req.body);
  const [user] = await db.select().from(users).where(eq(sql`lower(${users.email})`, body.email));
  const ok = await bcrypt.compare(body.password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !user.passwordHash || !ok || user.disabledAt) {
    await audit(req, "auth.login_failed", undefined, { email: body.email }, { workspaceId: null, actorUserId: user?.id ?? null });
    throw unauthorized("That email and password don't match an account.");
  }
  await startSession(req, user);
  await audit(req, "auth.login", { type: "user", id: user.id }, {}, { workspaceId: null, actorUserId: user.id });
  res.json({ user: publicUser(user), workspaces: await myWorkspaces(user.id) });
});

authRouter.post("/auth/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("th.sid");
    res.json({ ok: true });
  });
});

authRouter.post("/auth/signup", loginLimiter, async (req, res) => {
  if (!config.ALLOW_SIGNUP) throw new HttpError(403, "Sign-up is invite-only. Ask a workspace admin for an invitation.", "signup_disabled");
  const body = parse(
    z.object({ email: emailSchema, password: passwordSchema, firstName: z.string().trim().max(80).optional(), lastName: z.string().trim().max(80).optional() }),
    req.body,
  );
  const [exists] = await db.select({ id: users.id }).from(users).where(eq(sql`lower(${users.email})`, body.email));
  if (exists) throw conflict("An account with that email already exists. Sign in or reset your password.");
  const [user] = await db
    .insert(users)
    .values({ id: randomId("usr"), email: body.email, firstName: body.firstName, lastName: body.lastName, passwordHash: await hashPassword(body.password), authProvider: "email" })
    .returning();
  const link = await createPasswordLink(user.id, "verify_email", 48);
  await deliver({ channel: "email", target: user.email!, kind: "password", message: { subject: "Confirm your TestHarvest email", text: `Confirm your email address:\n${link}\n\nThe link works for 48 hours.` } });
  await startSession(req, user);
  await audit(req, "auth.signup", { type: "user", id: user.id }, {}, { workspaceId: null, actorUserId: user.id });
  res.status(201).json({ user: publicUser(user), workspaces: [] });
});

authRouter.post("/auth/password/forgot", mailLimiter, async (req, res) => {
  const { email } = parse(z.object({ email: emailSchema }), req.body);
  const [user] = await db.select().from(users).where(and(eq(sql`lower(${users.email})`, email), isNull(users.disabledAt)));
  if (user) {
    const link = await createPasswordLink(user.id, "reset_password", 1);
    await deliver({ channel: "email", target: user.email!, kind: "password", message: { subject: "Reset your TestHarvest password", text: `Choose a new password:\n${link}\n\nThe link works for one hour. If you didn't ask for this, ignore this email.` } });
    await audit(req, "auth.password_reset_requested", { type: "user", id: user.id }, {}, { workspaceId: null, actorUserId: null });
  }
  // The same answer whether or not the account exists.
  res.json({ ok: true });
});

async function findToken(token: string, purposes: string[]) {
  const [row] = await db
    .select({ t: passwordTokens, email: users.email, userId: users.id })
    .from(passwordTokens)
    .innerJoin(users, eq(users.id, passwordTokens.userId))
    .where(and(eq(passwordTokens.tokenHash, hashToken(token)), isNull(passwordTokens.usedAt), gt(passwordTokens.expiresAt, new Date())));
  return row && purposes.includes(row.t.purpose) ? row : null;
}

authRouter.get("/auth/token/:token", async (req, res) => {
  const row = await findToken(String(req.params.token), ["set_password", "reset_password", "verify_email"]);
  res.json(row ? { valid: true, purpose: row.t.purpose, email: row.email } : { valid: false });
});

authRouter.post("/auth/password/reset", async (req, res) => {
  const body = parse(z.object({ token: z.string().min(20).max(200), password: passwordSchema }), req.body);
  const row = await findToken(body.token, ["set_password", "reset_password"]);
  if (!row) throw badRequest("This link has expired or was already used. Ask for a new one.");
  const now = new Date();
  await db.update(passwordTokens).set({ usedAt: now }).where(eq(passwordTokens.id, row.t.id));
  const [user] = await db
    .update(users)
    .set({ passwordHash: await hashPassword(body.password), emailVerifiedAt: sql`coalesce(${users.emailVerifiedAt}, now())`, updatedAt: now })
    .where(eq(users.id, row.userId))
    .returning();
  await startSession(req, user);
  await audit(req, "auth.password_set", { type: "user", id: user.id }, { via: row.t.purpose }, { workspaceId: null, actorUserId: user.id });
  res.json({ user: publicUser(user), workspaces: await myWorkspaces(user.id) });
});

authRouter.post("/auth/verify-email", async (req, res) => {
  const { token } = parse(z.object({ token: z.string().min(20).max(200) }), req.body);
  const row = await findToken(token, ["verify_email"]);
  if (!row) throw badRequest("This link has expired or was already used.");
  await db.update(passwordTokens).set({ usedAt: new Date() }).where(eq(passwordTokens.id, row.t.id));
  await db.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, row.userId));
  res.json({ ok: true });
});

authRouter.patch("/auth/me", requireUser, async (req, res) => {
  const body = parse(z.object({ firstName: z.string().trim().max(80).nullable(), lastName: z.string().trim().max(80).nullable() }).partial(), req.body);
  const [user] = await db.update(users).set({ ...body, updatedAt: new Date() }).where(eq(users.id, req.user!.id)).returning();
  res.json({ user: publicUser(user) });
});

authRouter.post("/auth/password/change", requireUser, loginLimiter, async (req, res) => {
  const body = parse(z.object({ current: z.string().min(1).max(200), password: passwordSchema }), req.body);
  const [user] = await db.select().from(users).where(eq(users.id, req.user!.id));
  if (!user.passwordHash || !(await bcrypt.compare(body.current, user.passwordHash))) throw badRequest("Your current password is not correct.");
  const [updated] = await db.update(users).set({ passwordHash: await hashPassword(body.password), updatedAt: new Date() }).where(eq(users.id, user.id)).returning();
  // Keep this session; every other session for the account ends (authVersion changed).
  req.session.authVersion = authVersion(updated);
  await audit(req, "auth.password_changed", { type: "user", id: user.id }, {}, { workspaceId: null });
  res.json({ ok: true });
});

// ---- invitations (accepted by the invitee; created under /workspaces/:wid/invitations)

async function findInvitation(token: string) {
  const [row] = await db
    .select({ inv: invitations, workspaceName: workspaces.name })
    .from(invitations)
    .innerJoin(workspaces, eq(workspaces.id, invitations.workspaceId))
    .where(and(eq(invitations.tokenHash, hashToken(token)), isNull(invitations.acceptedAt), isNull(invitations.revokedAt), gt(invitations.expiresAt, new Date())));
  return row ?? null;
}

authRouter.get("/invitations/:token", async (req, res) => {
  const row = await findInvitation(String(req.params.token));
  if (!row) return res.json({ valid: false });
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(sql`lower(${users.email})`, row.inv.email.toLowerCase()));
  res.json({ valid: true, workspaceName: row.workspaceName, email: row.inv.email, role: row.inv.role, hasAccount: !!existing });
});

authRouter.post("/invitations/:token/accept", async (req, res) => {
  const row = await findInvitation(String(req.params.token));
  if (!row) throw badRequest("This invitation has expired, was revoked, or was already used.");
  const email = row.inv.email.toLowerCase();
  let [user] = await db.select().from(users).where(eq(sql`lower(${users.email})`, email));

  if (user) {
    // An existing account joins only while signed in as that account.
    if (req.user?.id !== user.id) throw new HttpError(409, `Sign in as ${row.inv.email} to accept this invitation.`, "sign_in_required");
  } else {
    const body = parse(z.object({ password: passwordSchema, firstName: z.string().trim().max(80).optional(), lastName: z.string().trim().max(80).optional() }), req.body);
    [user] = await db
      .insert(users)
      .values({ id: randomId("usr"), email, firstName: body.firstName, lastName: body.lastName, passwordHash: await hashPassword(body.password), authProvider: "email", emailVerifiedAt: new Date() })
      .returning();
  }

  await db.transaction(async (tx) => {
    await tx.update(invitations).set({ acceptedAt: new Date() }).where(eq(invitations.id, row.inv.id));
    await tx
      .insert(memberships)
      .values({ workspaceId: row.inv.workspaceId, userId: user.id, role: row.inv.role })
      .onConflictDoUpdate({ target: [memberships.workspaceId, memberships.userId], set: { role: row.inv.role } });
  });
  if (req.user?.id !== user.id) await startSession(req, user);
  await audit(req, "member.joined", { type: "user", id: user.id }, { role: row.inv.role }, { workspaceId: row.inv.workspaceId, actorUserId: user.id });
  res.json({ user: publicUser(user), workspaces: await myWorkspaces(user.id), workspaceId: row.inv.workspaceId });
});
