// Who is calling, and what they may do in a workspace.
import type { NextFunction, Request, Response, RequestHandler } from "express";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/client";
import { memberships, users, workspaces, type Role, type User, type Workspace } from "@shared/schema";
import { forbidden, notFound, unauthorized } from "../lib/errors";

declare module "express-session" {
  interface SessionData {
    userId?: string;
    // Bumped when a password changes, so other sessions for the account end.
    authVersion?: string;
  }
}

export type PublicUser = Pick<User, "id" | "email" | "firstName" | "lastName" | "isSystemAdmin"> & { name: string };

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId: string;
      user?: PublicUser;
      workspace?: Workspace;
      role?: Role;
    }
  }
}

export function publicUser(u: User): PublicUser {
  const name = [u.firstName, u.lastName].filter(Boolean).join(" ") || u.email || "User";
  return { id: u.id, email: u.email, firstName: u.firstName, lastName: u.lastName, isSystemAdmin: u.isSystemAdmin, name };
}

/** The version string a session must carry; changes whenever the password hash changes. */
export function authVersion(u: Pick<User, "passwordHash">): string {
  return (u.passwordHash ?? "").slice(-12);
}

/** Loads req.user from the session when there is one. Never fails the request. */
export const loadUser: RequestHandler = async (req, _res, next) => {
  try {
    const id = req.session?.userId;
    if (id) {
      const [u] = await db.select().from(users).where(and(eq(users.id, id), isNull(users.disabledAt)));
      if (u && req.session.authVersion === authVersion(u)) req.user = publicUser(u);
      else req.session.userId = undefined;
    }
    next();
  } catch (err) {
    next(err);
  }
};

export const requireUser: RequestHandler = (req, _res, next) => (req.user ? next() : next(unauthorized()));

export const requireSystemAdmin: RequestHandler = (req, _res, next) => {
  if (!req.user) return next(unauthorized());
  return req.user.isSystemAdmin ? next() : next(forbidden("Only a system administrator can do that."));
};

const RANK: Record<Role, number> = { viewer: 1, runner: 2, editor: 3, admin: 4, owner: 5 };

export const ROLE_INFO: Record<Role, string> = {
  owner: "Everything, including deleting the workspace and managing owners.",
  admin: "Manage members, environments, secrets and workspace settings, plus everything an editor can do.",
  editor: "Create and change suites, tests, schedules and alerts; run tests.",
  runner: "Run and cancel tests; read everything.",
  viewer: "Read dashboards, tests and results.",
};

export function atLeast(role: Role | undefined, min: Role): boolean {
  return !!role && RANK[role] >= RANK[min];
}

/** Router param handler for :wid. Non-members get 404, never a hint the workspace exists. */
export async function workspaceParam(req: Request, _res: Response, next: NextFunction, raw: string) {
  try {
    if (!req.user) return next(unauthorized());
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0) return next(notFound("Workspace"));
    const [row] = await db
      .select({ ws: workspaces, role: memberships.role })
      .from(memberships)
      .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
      .where(and(eq(memberships.workspaceId, id), eq(memberships.userId, req.user.id)));
    if (!row) return next(notFound("Workspace"));
    req.workspace = row.ws;
    req.role = row.role;
    next();
  } catch (err) {
    next(err);
  }
}

export function requireRole(min: Role): RequestHandler {
  return (req, _res, next) => (atLeast(req.role, min) ? next() : next(forbidden(`This needs the ${min} role or higher.`)));
}

/** The workspace on a scoped request; throws if a route forgot :wid. */
export function ws(req: Request): Workspace {
  if (!req.workspace) throw new Error("workspace not loaded");
  return req.workspace;
}
