// Operator commands. Replaces the old seeded admin account: the first owner is
// created here and gets a single-use link to choose their own password.
//
//   npm run admin -- gen-key
//   npm run admin -- create-owner --email you@example.com --workspace "QA" [--system-admin]
//   npm run admin -- reset-link --email you@example.com
//   npm run admin -- system-admin --email you@example.com [--revoke]
//   npm run admin -- users
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";

const [command, ...rest] = process.argv.slice(2);
const { values } = parseArgs({
  args: rest,
  options: { email: { type: "string" }, workspace: { type: "string" }, "system-admin": { type: "boolean" }, revoke: { type: "boolean" } },
  allowPositionals: true,
});

if (command === "gen-key") {
  console.log(randomBytes(32).toString("base64"));
  process.exit(0);
}

const { db, pool } = await import("../db/client");
const { memberships, users, workspaces } = await import("@shared/schema");
const { createPasswordLink } = await import("../http/routes/auth");
const { randomId } = await import("../lib/crypto");
const { audit } = await import("../services/audit");
const { eq, sql } = await import("drizzle-orm");

async function userByEmail(email: string) {
  const [u] = await db.select().from(users).where(eq(sql`lower(${users.email})`, email.toLowerCase()));
  return u;
}

function need(v: string | undefined, name: string): string {
  if (!v) {
    console.error(`--${name} is required`);
    process.exit(2);
  }
  return v;
}

try {
  switch (command) {
    case "create-owner": {
      const email = need(values.email, "email").trim().toLowerCase();
      const wsName = need(values.workspace, "workspace").trim();
      let user = await userByEmail(email);
      if (!user) [user] = await db.insert(users).values({ id: randomId("usr"), email, authProvider: "email", isSystemAdmin: !!values["system-admin"] }).returning();
      else if (values["system-admin"]) await db.update(users).set({ isSystemAdmin: true }).where(eq(users.id, user.id));
      let [w] = await db.select().from(workspaces).where(eq(workspaces.name, wsName));
      if (!w) {
        const slug = wsName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "workspace";
        [w] = await db.insert(workspaces).values({ name: wsName, slug: `${slug}-${randomBytes(2).toString("hex")}`, createdBy: user.id }).returning();
      }
      await db.insert(memberships).values({ workspaceId: w.id, userId: user.id, role: "owner" }).onConflictDoUpdate({ target: [memberships.workspaceId, memberships.userId], set: { role: "owner" } });
      await audit(null, "admin.owner_created", { type: "user", id: user.id }, { email, via: "cli" }, { workspaceId: w.id, actorUserId: null });
      const link = await createPasswordLink(user.id, "set_password", 72);
      console.log(`${email} is an owner of “${w.name}”.`);
      console.log(`Single-use link to set the password (valid 72 hours):\n${link}`);
      break;
    }
    case "reset-link": {
      const u = await userByEmail(need(values.email, "email"));
      if (!u) throw new Error("No account with that email.");
      await audit(null, "admin.reset_link_created", { type: "user", id: u.id }, { via: "cli" }, { workspaceId: null, actorUserId: null });
      console.log(`Single-use link (valid 24 hours):\n${await createPasswordLink(u.id, "set_password", 24)}`);
      break;
    }
    case "system-admin": {
      const u = await userByEmail(need(values.email, "email"));
      if (!u) throw new Error("No account with that email.");
      await db.update(users).set({ isSystemAdmin: !values.revoke }).where(eq(users.id, u.id));
      await audit(null, values.revoke ? "admin.system_admin_revoked" : "admin.system_admin_granted", { type: "user", id: u.id }, { via: "cli" }, { workspaceId: null, actorUserId: null });
      console.log(`${u.email} is ${values.revoke ? "no longer" : "now"} a system administrator.`);
      break;
    }
    case "users": {
      const rows = await db.select({ email: users.email, sysadmin: users.isSystemAdmin, hasPassword: sql<boolean>`${users.passwordHash} IS NOT NULL`, lastLogin: users.lastLoginAt }).from(users).orderBy(users.email);
      console.table(rows);
      break;
    }
    default:
      console.log("Commands: gen-key | create-owner --email --workspace [--system-admin] | reset-link --email | system-admin --email [--revoke] | users");
      process.exitCode = command ? 2 : 0;
  }
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
