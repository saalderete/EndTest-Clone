// Acceptance: unauthenticated access gets 401, other workspaces' data gets 404,
// roles are enforced, the old demo bypass is gone, secrets never come back.
import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { addMember, app, makeUser, makeWorkspace, signIn, type Client } from "../helpers/fixtures";

const H = { "x-requested-with": "testharvest" };

let owner: Client, outsider: Client, viewer: Client, runner: Client, editor: Client, admin: Client;
let wsId: number, otherWsId: number, suiteId: number, caseId: number, envId: number, runId: number;

beforeAll(async () => {
  const o = await makeUser();
  const out = await makeUser();
  const v = await makeUser();
  const r = await makeUser();
  const e = await makeUser();
  const a = await makeUser();
  const w = await makeWorkspace(o.id);
  const other = await makeWorkspace(out.id);
  wsId = w.id;
  otherWsId = other.id;
  await addMember(wsId, v.id, "viewer");
  await addMember(wsId, r.id, "runner");
  await addMember(wsId, e.id, "editor");
  await addMember(wsId, a.id, "admin");
  [owner, outsider, viewer, runner, editor, admin] = await Promise.all([o, out, v, r, e, a].map((u) => signIn(u.email)));

  envId = (await owner.post(`/api/workspaces/${wsId}/environments`).send({ name: "Staging", baseUrl: "https://staging.example.test" })).body.id;
  suiteId = (await owner.post(`/api/workspaces/${wsId}/suites`).send({ name: "Smoke", environmentId: envId })).body.id;
  const created = await owner.post(`/api/workspaces/${wsId}/cases`).send({
    name: "Home page loads",
    suiteId,
    steps: [{ name: "Open home", action: "navigate", value: "/" }, { name: "Title", action: "assert_text", value: "Welcome" }],
  });
  caseId = created.body.id;
  await owner.post(`/api/workspaces/${wsId}/cases/${caseId}/publish`).send({});
  runId = (await owner.post(`/api/workspaces/${wsId}/runs`).send({ caseId })).body.runId;
});

describe("signed-out requests", () => {
  it.each([
    ["get", "/api/workspaces/1/suites"],
    ["get", "/api/workspaces/1/runs"],
    ["get", "/api/workspaces/1/cases/1"],
    ["post", "/api/workspaces/1/runs"],
    ["post", "/api/workspaces/1/runs/1/cancel"],
    ["get", "/api/workspaces/1/artifacts/1"],
  ] as const)("%s %s → 401", async (method, url) => {
    const res = await request(app)[method](url).set(H).send({});
    expect(res.status).toBe(401);
  });

  it("the old open test-suite listing is gone", async () => {
    expect((await request(app).get("/api/test-suites")).status).toBe(401);
    expect((await owner.get("/api/test-suites")).status).toBe(404);
  });

  it("the old unauthenticated emergency stops are gone", async () => {
    for (const url of ["/api/emergency-stop", "/api/scheduler/emergency-stop"]) {
      expect((await request(app).post(url).set(H)).status).toBe(401);
      expect((await owner.post(url).send({})).status).toBe(404);
    }
    expect((await request(app).post("/api/system/emergency-stop").set(H)).status).toBe(401);
  });

  it("a forged x-demo-auth header is ignored", async () => {
    const res = await request(app).get(`/api/workspaces/${wsId}/suites`).set({ ...H, "x-demo-auth": "true" });
    expect(res.status).toBe(401);
  });
});

describe("other workspaces", () => {
  it("can't be read (404, not 403)", async () => {
    for (const url of [`/api/workspaces/${wsId}`, `/api/workspaces/${wsId}/suites`, `/api/workspaces/${wsId}/cases/${caseId}`, `/api/workspaces/${wsId}/runs/${runId}`, `/api/workspaces/${wsId}/secrets`]) {
      expect((await outsider.get(url)).status, url).toBe(404);
    }
  });

  it("can't be changed or run", async () => {
    expect((await outsider.post(`/api/workspaces/${wsId}/runs`).send({ caseId })).status).toBe(404);
    expect((await outsider.post(`/api/workspaces/${wsId}/runs/${runId}/cancel`).send({})).status).toBe(404);
    expect((await outsider.delete(`/api/workspaces/${wsId}/cases/${caseId}`)).status).toBe(404);
  });

  it("IDs from another workspace don't resolve through your own", async () => {
    // The outsider owns a workspace, but our case/run IDs must not be visible through it.
    expect((await outsider.get(`/api/workspaces/${otherWsId}/cases/${caseId}`)).status).toBe(404);
    expect((await outsider.get(`/api/workspaces/${otherWsId}/runs/${runId}`)).status).toBe(404);
    expect((await outsider.post(`/api/workspaces/${otherWsId}/runs`).send({ caseId })).status).toBe(404);
    expect((await outsider.post(`/api/workspaces/${otherWsId}/runs/${runId}/cancel`).send({})).status).toBe(404);
  });
});

describe("roles", () => {
  it("viewers read but can't run or edit", async () => {
    expect((await viewer.get(`/api/workspaces/${wsId}/suites`)).status).toBe(200);
    expect((await viewer.post(`/api/workspaces/${wsId}/runs`).send({ caseId })).status).toBe(403);
    expect((await viewer.post(`/api/workspaces/${wsId}/suites`).send({ name: "x" })).status).toBe(403);
  });

  it("runners run but can't edit", async () => {
    expect((await runner.post(`/api/workspaces/${wsId}/runs`).send({ caseId })).status).toBe(202);
    expect((await runner.put(`/api/workspaces/${wsId}/cases/${caseId}/steps`).send({ steps: [] })).status).toBe(403);
  });

  it("editors edit but can't manage secrets, environments or members", async () => {
    expect((await editor.post(`/api/workspaces/${wsId}/suites`).send({ name: "Editor suite" })).status).toBe(201);
    expect((await editor.post(`/api/workspaces/${wsId}/secrets`).send({ name: "X_PASSWORD", value: "v" })).status).toBe(403);
    expect((await editor.post(`/api/workspaces/${wsId}/environments`).send({ name: "Prod", baseUrl: "https://example.test" })).status).toBe(403);
    expect((await editor.post(`/api/workspaces/${wsId}/invitations`).send({ email: "new@example.test", role: "viewer" })).status).toBe(403);
  });

  it("admins manage secrets but can't create owners", async () => {
    expect((await admin.post(`/api/workspaces/${wsId}/secrets`).send({ name: "ADMIN_SECRET", value: "s3cr3t-value" })).status).toBe(201);
    expect((await admin.post(`/api/workspaces/${wsId}/invitations`).send({ email: "boss@example.test", role: "owner" })).status).toBe(403);
  });

  it("only system administrators can use the emergency stop", async () => {
    expect((await owner.post("/api/system/emergency-stop").send({})).status).toBe(403);
    expect((await owner.get("/api/system/status")).status).toBe(403);
  });

  it("the last owner can't be demoted or removed", async () => {
    const me = (await owner.get("/api/auth/me")).body.user.id;
    expect((await owner.patch(`/api/workspaces/${wsId}/members/${me}`).send({ role: "admin" })).status).toBe(400);
    expect((await owner.delete(`/api/workspaces/${wsId}/members/${me}`)).status).toBe(400);
  });
});

describe("sensitive data", () => {
  it("user payloads never include password hashes", async () => {
    const me = await owner.get("/api/auth/me");
    expect(JSON.stringify(me.body)).not.toMatch(/passwordHash|password_hash|\$2[aby]\$/);
    const members = await owner.get(`/api/workspaces/${wsId}/members`);
    expect(JSON.stringify(members.body)).not.toMatch(/passwordHash|password_hash|\$2[aby]\$/);
  });

  it("secret values and ciphertext are never returned", async () => {
    await owner.post(`/api/workspaces/${wsId}/secrets`).send({ name: "LOGIN_PASSWORD", value: "hunter2-but-longer" });
    const list = await owner.get(`/api/workspaces/${wsId}/secrets`);
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain("hunter2-but-longer");
    expect(JSON.stringify(list.body)).not.toMatch(/ciphertext|v1:/);
  });

  it("errors carry a request ID and no internals", async () => {
    const res = await owner.get(`/api/workspaces/${wsId}/runs/notanumber`);
    expect(res.status).toBe(404);
    expect(res.body.requestId).toMatch(/[\w-]{8,}/);
    expect(JSON.stringify(res.body)).not.toMatch(/stack|at .*\.ts/);
  });
});

describe("cross-site requests", () => {
  it("mutations without the app header are refused", async () => {
    const res = await owner.agent.post(`/api/workspaces/${wsId}/suites`).send({ name: "csrf" });
    expect(res.status).toBe(403);
  });

  it("mutations from another origin are refused", async () => {
    const res = await owner.agent.post(`/api/workspaces/${wsId}/suites`).set(H).set("Origin", "https://evil.example").send({ name: "csrf" });
    expect(res.status).toBe(403);
  });
});

describe("sign-in", () => {
  it("rejects wrong passwords without saying which part was wrong", async () => {
    const u = await makeUser();
    const res = await request(app).post("/api/auth/login").set(H).send({ email: u.email, password: "nope-nope-nope" });
    expect(res.status).toBe(401);
    expect(res.body.message).toMatch(/don't match/);
  });

  it("self-signup is off by default", async () => {
    const res = await request(app).post("/api/auth/signup").set(H).send({ email: "x@example.test", password: "a-long-enough-password" });
    expect(res.status).toBe(403);
  });

  it("invitations create the account and the membership", async () => {
    const inv = await owner.post(`/api/workspaces/${wsId}/invitations`).send({ email: "invitee@example.test", role: "runner" });
    expect(inv.status).toBe(201);
    expect(inv.body.emailStatus).toBe("suppressed");
    const token = inv.body.link.split("/invite/")[1];
    const accept = await request(app).post(`/api/invitations/${token}/accept`).set(H).send({ password: "invitee-password-123" });
    expect(accept.status).toBe(200);
    expect(accept.body.workspaces.map((w: { id: number }) => w.id)).toContain(wsId);
    // Single use.
    expect((await request(app).post(`/api/invitations/${token}/accept`).set(H).send({ password: "invitee-password-123" })).status).toBe(400);
  });
});
