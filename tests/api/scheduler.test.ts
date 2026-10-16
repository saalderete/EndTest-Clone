// Scheduling: one leader, one run per test per due time, no backfill,
// overlap policies, the emergency stop, and the review gate.
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, pool } from "../../server/db/client";
import { schedules, testCases, testExecutions } from "@shared/schema";
import { startScheduler } from "../../server/runner/scheduler";
import { enqueueCase } from "../../server/services/runs";
import { nextRuns, validateCron } from "../../server/services/cron";
import { makeUser, makeWorkspace, signIn, type Client } from "../helpers/fixtures";

let c: Client;
let sysadmin: Client;
let ws: number;
let caseId: number;
let suiteId: number;
const stops: (() => Promise<void>)[] = [];

const runsFor = (id: number) => db.select().from(testExecutions).where(eq(testExecutions.caseId, id));
const until = async (fn: () => Promise<boolean>, ms = 15_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
};

beforeAll(async () => {
  const u = await makeUser();
  const admin = await makeUser({ sysadmin: true });
  ws = (await makeWorkspace(u.id)).id;
  c = await signIn(u.email);
  sysadmin = await signIn(admin.email);
  const env = await c.post(`/api/workspaces/${ws}/environments`).send({ name: "Sample", baseUrl: "http://127.0.0.1:9" });
  suiteId = (await c.post(`/api/workspaces/${ws}/suites`).send({ name: "Scheduled", environmentId: env.body.id })).body.id;
  caseId = (await c.post(`/api/workspaces/${ws}/cases`).send({ name: "Hourly check", suiteId, steps: [{ name: "Open", action: "navigate", value: "/" }] })).body.id;
  await c.post(`/api/workspaces/${ws}/cases/${caseId}/publish`).send({});
});

afterEach(async () => {
  while (stops.length) await stops.pop()!();
  await db.delete(testExecutions).where(eq(testExecutions.workspaceId, ws));
  await db.delete(schedules).where(eq(schedules.workspaceId, ws));
});

describe("cron", () => {
  it("validates expressions and timezones and lists the next runs", () => {
    expect(() => validateCron("*/30 * * * *", "America/Denver")).not.toThrow();
    expect(() => validateCron("* * * * *", "UTC")).toThrow(/every 5 minutes/);
    expect(() => validateCron("0 7 * *", "UTC")).toThrow(/five-field/);
    expect(() => validateCron("0 7 * * *", "Mars/Olympus")).toThrow(/timezone/);
    const next = nextRuns("0 7 * * 1-5", "America/Denver", 5, new Date("2026-10-16T12:00:00Z"));
    // Friday Oct 16 06:00 in Denver (MDT, UTC-6): today at 07:00, then the next four weekdays.
    expect(next.map((d) => d.toISOString())).toEqual([
      "2026-10-16T13:00:00.000Z",
      "2026-10-19T13:00:00.000Z",
      "2026-10-20T13:00:00.000Z",
      "2026-10-21T13:00:00.000Z",
      "2026-10-22T13:00:00.000Z",
    ]);
    // After daylight saving ends (Nov 1), 07:00 Denver is 14:00 UTC.
    expect(nextRuns("0 7 * * *", "America/Denver", 1, new Date("2026-11-02T00:00:00Z"))[0].toISOString()).toBe("2026-11-02T14:00:00.000Z");
  });
});

describe("dispatch", () => {
  it("queues exactly one run per due time even with two schedulers", async () => {
    const res = await c.post(`/api/workspaces/${ws}/schedules`).send({ caseId, cron: "0 * * * *", timezone: "UTC" });
    expect(res.status).toBe(201);
    const due = new Date(Date.now() - 30_000);
    await db.update(schedules).set({ nextRunAt: due }).where(eq(schedules.id, res.body.id));
    stops.push(await startScheduler(), await startScheduler());
    expect(await until(async () => (await runsFor(caseId)).length > 0)).toBe(true);
    await new Promise((r) => setTimeout(r, 2500));
    const runs = await runsFor(caseId);
    expect(runs).toHaveLength(1);
    expect(runs[0].trigger).toBe("schedule");
    expect(runs[0].idempotencyKey).toBe(`schedule:${due.toISOString()}:${caseId}`);
    const [s] = await db.select().from(schedules).where(eq(schedules.id, res.body.id));
    expect(s.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it("a test schedule and its suite's schedule due at the same time make one run", async () => {
    const due = new Date(Date.now() - 20_000);
    const a = await c.post(`/api/workspaces/${ws}/schedules`).send({ caseId, cron: "0 * * * *", timezone: "UTC" });
    const b = await c.post(`/api/workspaces/${ws}/schedules`).send({ suiteId, cron: "0 * * * *", timezone: "UTC" });
    await db.update(schedules).set({ nextRunAt: due }).where(eq(schedules.workspaceId, ws));
    expect(a.status + b.status).toBe(402);
    stops.push(await startScheduler());
    await until(async () => (await db.select().from(schedules).where(eq(schedules.workspaceId, ws))).every((x) => x.nextRunAt! > new Date()));
    expect(await runsFor(caseId)).toHaveLength(1);
  });

  it("skips (doesn't backfill) a due time missed while the scheduler was down", async () => {
    const res = await c.post(`/api/workspaces/${ws}/schedules`).send({ caseId, cron: "0 * * * *", timezone: "UTC" });
    await db.update(schedules).set({ nextRunAt: new Date(Date.now() - 3 * 3600_000) }).where(eq(schedules.id, res.body.id));
    stops.push(await startScheduler());
    await until(async () => (await db.select().from(schedules).where(eq(schedules.id, res.body.id)))[0].lastError !== null);
    expect(await runsFor(caseId)).toHaveLength(0);
    const [s] = await db.select().from(schedules).where(eq(schedules.id, res.body.id));
    expect(s.lastError).toMatch(/offline/);
  });

  it("honours the skip overlap policy", async () => {
    const first = await enqueueCase(ws, caseId, { trigger: "schedule", applyOverlapPolicy: true });
    expect("run" in first).toBe(true);
    const second = await enqueueCase(ws, caseId, { trigger: "schedule", applyOverlapPolicy: true });
    expect("skipped" in second && second.skipped).toMatch(/still queued/);
    const manual = await enqueueCase(ws, caseId, { trigger: "manual" });
    expect("run" in manual).toBe(true);
  });

  it("dispatches nothing during an emergency stop, and resumes without a burst", async () => {
    const stop = await sysadmin.post("/api/system/emergency-stop").send({});
    expect(stop.status).toBe(200);
    const res = await c.post(`/api/workspaces/${ws}/schedules`).send({ caseId, cron: "0 * * * *", timezone: "UTC" });
    await db.update(schedules).set({ nextRunAt: new Date(Date.now() - 10_000) }).where(eq(schedules.id, res.body.id));
    stops.push(await startScheduler());
    await new Promise((r) => setTimeout(r, 2500));
    expect(await runsFor(caseId)).toHaveLength(0);
    expect((await sysadmin.post("/api/system/resume").send({})).status).toBe(200);
    const [s] = await db.select().from(schedules).where(eq(schedules.id, res.body.id));
    expect(s.nextRunAt).toBeNull(); // recomputed from now, not fired late
    const status = await sysadmin.get("/api/system/status");
    expect(status.body.dispatchPaused).toBe(false);
  });
});

describe("review gate", () => {
  it("a test that needs review can't be scheduled until it's marked reviewed", async () => {
    await db.update(testCases).set({ needsReview: true }).where(eq(testCases.id, caseId));
    const blocked = await c.post(`/api/workspaces/${ws}/schedules`).send({ caseId, cron: "0 * * * *", timezone: "UTC" });
    expect(blocked.status).toBe(400);
    expect(blocked.body.message).toMatch(/needs review/);
    const paused = await c.post(`/api/workspaces/${ws}/schedules`).send({ caseId, cron: "0 * * * *", timezone: "UTC", paused: true });
    expect(paused.status).toBe(201);
    expect((await c.patch(`/api/workspaces/${ws}/schedules/${paused.body.id}`).send({ paused: false })).status).toBe(400);
    await c.patch(`/api/workspaces/${ws}/cases/${caseId}`).send({ reviewed: true });
    const resumed = await c.patch(`/api/workspaces/${ws}/schedules/${paused.body.id}`).send({ paused: false });
    expect(resumed.status).toBe(200);
    expect(new Date(resumed.body.nextRunAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("previews the next five runs in the schedule's timezone", async () => {
    const res = await c.get(`/api/workspaces/${ws}/schedules/preview?cron=${encodeURIComponent("30 6 * * 1-5")}&timezone=America/Denver`);
    expect(res.body.valid).toBe(true);
    expect(res.body.next).toHaveLength(5);
    const bad = await c.get(`/api/workspaces/${ws}/schedules/preview?cron=nonsense&timezone=UTC`);
    expect(bad.body.valid).toBe(false);
  });
});

afterEach(() => pool.query("UPDATE system_state SET value = 'false' WHERE key = 'dispatch_paused'"));
