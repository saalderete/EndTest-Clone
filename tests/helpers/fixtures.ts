// Test fixtures: users, signed-in agents, workspaces.
import request from "supertest";
import bcrypt from "bcrypt";
import { randomBytes } from "node:crypto";
import { createApp } from "../../server/http/app";
import { db } from "../../server/db/client";
import { memberships, users, workspaces, type Role } from "@shared/schema";

export const app = createApp();
export const PASSWORD = "a-long-test-password-123";
const hash = bcrypt.hashSync(PASSWORD, 4);

export async function makeUser(opts: { sysadmin?: boolean } = {}) {
  const id = `usr_${randomBytes(6).toString("hex")}`;
  const email = `${id}@example.test`;
  await db.insert(users).values({ id, email, passwordHash: hash, authProvider: "email", isSystemAdmin: !!opts.sysadmin });
  return { id, email };
}

/** A supertest agent signed in as the user, sending the CSRF header on every request. */
export async function signIn(email: string) {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/login").set("x-requested-with", "testharvest").send({ email, password: PASSWORD });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  const wrap = (m: "get" | "post" | "put" | "patch" | "delete") => (url: string) => agent[m](url).set("x-requested-with", "testharvest");
  return { agent, get: wrap("get"), post: wrap("post"), put: wrap("put"), patch: wrap("patch"), delete: wrap("delete") };
}

export async function makeWorkspace(ownerId: string, name = `WS ${randomBytes(3).toString("hex")}`) {
  const [w] = await db.insert(workspaces).values({ name, slug: `ws-${randomBytes(5).toString("hex")}`, createdBy: ownerId }).returning();
  await db.insert(memberships).values({ workspaceId: w.id, userId: ownerId, role: "owner" });
  return w;
}

export async function addMember(workspaceId: number, userId: string, role: Role) {
  await db.insert(memberships).values({ workspaceId, userId, role });
}

export type Client = Awaited<ReturnType<typeof signIn>>;
