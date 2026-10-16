// The runner end to end: real Chromium, real worker, the fictional sample app.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { and, asc, eq } from "drizzle-orm";
import { db } from "../../server/db/client";
import { artifacts, incidents, notificationDeliveries, runEvents, stepExecutions, testExecutions } from "@shared/schema";
import { startWorker } from "../../server/runner/worker";
import { SAMPLE_USER, startSampleApp } from "../../sample-app/server";
import { makeUser, makeWorkspace, signIn, type Client } from "../helpers/fixtures";
import type { Step } from "@shared/steps";

let sample: { server: Server; url: string };
let stopWorker: () => Promise<void>;
let c: Client;
let ws: number;
let suiteId: number;
let envId: number;

const login: Step[] = [
  { name: "Open sign-in", action: "navigate", value: "/login", options: {}, enabled: true },
  { name: "Email", action: "fill", locatorType: "label", locatorValue: "Email", value: "{{secrets.SAMPLE_EMAIL}}", options: {}, enabled: true },
  { name: "Password", action: "fill", locatorType: "id", locatorValue: "password", value: "{{secrets.SAMPLE_PASSWORD}}", options: {}, enabled: true },
  { name: "Sign in", action: "click", locatorType: "role", locatorValue: "button", options: { roleName: "Sign in" }, enabled: true },
  { name: "Signed in", action: "wait_for_text", value: "Welcome back, Demo Grower", options: {}, enabled: true },
];
const s = (x: Partial<Step> & Pick<Step, "name" | "action">): Step => ({ options: {}, enabled: true, ...x }) as Step;

async function makeCase(name: string, steps: Step[], settings: Record<string, unknown> = {}) {
  const res = await c.post(`/api/workspaces/${ws}/cases`).send({ name, suiteId, steps, ...settings });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const pub = await c.post(`/api/workspaces/${ws}/cases/${res.body.id}/publish`).send({ note: "test" });
  expect(pub.status, JSON.stringify(pub.body)).toBe(200);
  return res.body.id as number;
}

async function runAndWait(caseId: number, timeoutMs = 60_000) {
  const res = await c.post(`/api/workspaces/${ws}/runs`).send({ caseId });
  expect(res.status, JSON.stringify(res.body)).toBe(202);
  return waitFor(res.body.runId, timeoutMs);
}

async function waitFor(runId: number, timeoutMs = 60_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const [run] = await db.select().from(testExecutions).where(eq(testExecutions.id, runId));
    if (["passed", "failed", "timed_out", "cancelled", "infrastructure_error"].includes(run.status)) return run;
    if (Date.now() > end) throw new Error(`run ${runId} still ${run.status}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

const stepsOf = (runId: number) => db.select().from(stepExecutions).where(eq(stepExecutions.executionId, runId)).orderBy(asc(stepExecutions.attempt), asc(stepExecutions.stepIndex));

beforeAll(async () => {
  sample = await startSampleApp(0);
  const u = await makeUser();
  const w = await makeWorkspace(u.id, "Fieldnote QA");
  ws = w.id;
  c = await signIn(u.email);
  const env = await c.post(`/api/workspaces/${ws}/environments`).send({ name: "Sample", baseUrl: sample.url, allowedHosts: ["127.0.0.1"] });
  expect(env.status).toBe(201);
  envId = env.body.id;
  await c.post(`/api/workspaces/${ws}/secrets`).send({ name: "SAMPLE_EMAIL", value: SAMPLE_USER.email });
  await c.post(`/api/workspaces/${ws}/secrets`).send({ name: "SAMPLE_PASSWORD", value: SAMPLE_USER.password });
  suiteId = (await c.post(`/api/workspaces/${ws}/suites`).send({ name: "Fieldnote", environmentId: env.body.id })).body.id;
  stopWorker = await startWorker();
});

afterAll(async () => {
  await stopWorker?.();
  sample?.server.close();
});

describe("runner", () => {
  it("runs a full workflow: secrets, forms, iframe, new tab, delayed dialog", async () => {
    const caseId = await makeCase("Full workflow", [
      ...login,
      s({ name: "Field name", action: "fill", locatorType: "placeholder", locatorValue: "e.g. North 40", value: "North 40" }),
      s({ name: "Crop", action: "select", locatorType: "label", locatorValue: "Crop", value: "Corn" }),
      s({ name: "Irrigated", action: "check", locatorType: "label", locatorValue: "Irrigated" }),
      s({ name: "Save", action: "click", locatorType: "role", locatorValue: "button", options: { roleName: "Save field" } }),
      s({ name: "Saved", action: "assert_text", value: "Saved North 40 (corn, irrigated)" }),
      s({ name: "Generate", action: "click", locatorType: "text", locatorValue: "Generate report", options: { exact: true } }),
      s({ name: "Report ready", action: "wait_for_text", value: "Report ready" }),
      s({ name: "Generating gone", action: "wait_for_text_gone", value: "Generating…" }),
      s({ name: "Type message", action: "fill", locatorType: "placeholder", locatorValue: "Type a message", value: "hello agronomist" }),
      s({ name: "Send", action: "click", locatorType: "css", locatorValue: "#send" }),
      s({ name: "Sent (in iframe)", action: "assert_text", value: "Sent: hello agronomist" }),
      s({ name: "Open report", action: "click", locatorType: "test_id", locatorValue: "open-report", options: { opensNewTab: true } }),
      s({ name: "Report shown", action: "assert_text", value: "Soil report #123" }),
      s({ name: "Report URL", action: "assert_url", value: "/report/123" }),
      s({ name: "Evidence", action: "screenshot" }),
      s({ name: "Back", action: "switch_to_main_tab" }),
      s({ name: "Delete", action: "click", locatorType: "text", locatorValue: "Delete sample data" }),
      s({ name: "Dialog", action: "wait_for_element", locatorType: "role", locatorValue: "dialog", options: { roleName: "Confirm" } }),
      s({ name: "Confirm", action: "click", locatorType: "role", locatorValue: "button", options: { roleName: "Yes, delete" } }),
      s({ name: "Deleted", action: "assert_text", value: "Sample data deleted" }),
    ]);
    const run = await runAndWait(caseId);
    const steps = await stepsOf(run.id);
    expect(run.status, `${run.errorMessage}\n${steps.map((x) => `${x.stepIndex} ${x.status} ${x.errorMessage ?? x.log}`).join("\n")}`).toBe("passed");
    expect(steps.every((x) => x.status === "passed")).toBe(true);
    expect(steps).toHaveLength(25);
    const files = await db.select().from(artifacts).where(eq(artifacts.executionId, run.id));
    expect(files.filter((f) => f.kind === "screenshot").length).toBeGreaterThanOrEqual(2);
    const events = await db.select().from(runEvents).where(eq(runEvents.executionId, run.id)).orderBy(asc(runEvents.seq));
    expect(events[0].status).toBe("queued");
    expect(events.at(-1)!.status).toBe("passed");
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    // The password never appears in anything stored.
    const stored = JSON.stringify({ steps, events, run });
    expect(stored).not.toContain(SAMPLE_USER.password);
    expect(stored).not.toContain(SAMPLE_USER.email);
  });

  it("records a failure with evidence, opens one incident, and resolves it on recovery", async () => {
    const r = await c.post(`/api/workspaces/${ws}/notification-rules`).send({ channel: "email", target: "alerts@example.test" });
    expect(r.status).toBe(201);
    const caseId = await makeCase("Missing text", [...login, s({ name: "Expect a heading that isn't there", action: "assert_text", value: "Quarterly yield forecast", options: { timeoutMs: 1500 } })]);
    const run = await runAndWait(caseId);
    expect(run.status).toBe("failed");
    expect(run.errorCategory).toBe("assertion");
    expect(run.failedStepIndex).toBe(6);
    expect(run.errorMessage).toMatch(/Quarterly yield forecast/);
    const steps = await stepsOf(run.id);
    const failed = steps.find((x) => x.status === "failed")!;
    expect(failed.log).toMatch(/URL: http/);
    expect(failed.log).toMatch(/demo console error/);
    const shots = await db.select().from(artifacts).where(and(eq(artifacts.executionId, run.id), eq(artifacts.stepIndex, 6)));
    expect(shots.some((a) => a.kind === "screenshot")).toBe(true);
    // Tests that use secrets never get a trace (traces record typed values).
    expect(shots.some((a) => a.kind === "trace")).toBe(false);

    const [open] = await db.select().from(incidents).where(eq(incidents.caseId, caseId));
    expect(open.resolvedAt).toBeNull();
    const second = await runAndWait(caseId);
    expect(second.status).toBe("failed");
    const deliveries = await db.select().from(notificationDeliveries).where(eq(notificationDeliveries.incidentId, open.id));
    // One alert for the streak, not one per failure; suppressed because notifications are off in tests.
    expect(deliveries.filter((d) => d.kind === "failure")).toHaveLength(1);
    expect(deliveries[0].status).toBe("suppressed");

    // Fix the test (new version) and recover.
    await c.put(`/api/workspaces/${ws}/cases/${caseId}/steps`).send({ steps: [...login, s({ name: "Heading", action: "assert_text", value: "Welcome back" })] });
    await c.post(`/api/workspaces/${ws}/cases/${caseId}/publish`).send({});
    const third = await runAndWait(caseId);
    expect(third.status).toBe("passed");
    expect(third.caseVersion).toBe(2);
    const [resolved] = await db.select().from(incidents).where(eq(incidents.id, open.id));
    expect(resolved.resolvedAt).not.toBeNull();
    expect(resolved.consecutiveFailures).toBe(2);
    const all = await db.select().from(notificationDeliveries).where(eq(notificationDeliveries.incidentId, open.id));
    expect(all.filter((d) => d.kind === "recovery")).toHaveLength(1);
  });

  it("records soft checks as warnings, not silent passes", async () => {
    const caseId = await makeCase("Soft check", [...login, s({ name: "Optional banner", action: "wait_for_text", value: "Holiday hours", options: { timeoutMs: 1000, continueOnFailure: true } })]);
    const run = await runAndWait(caseId);
    expect(run.status).toBe("passed");
    expect(run.warnings).toBe(1);
    expect((await stepsOf(run.id)).find((x) => x.stepIndex === 6)!.status).toBe("warning");
  });

  it("blocks navigation outside the environment's allowed hosts", async () => {
    const caseId = await makeCase("Leaves the site", [...login, s({ name: "Partner portal", action: "click", locatorType: "text", locatorValue: "Partner portal" }), s({ name: "Should not get here", action: "assert_text", value: "Another site", options: { timeoutMs: 3000 } })]);
    const run = await runAndWait(caseId);
    expect(run.status).toBe("failed");
    expect(run.errorCategory).toBe("policy");
    expect(run.errorMessage).toMatch(/allowed hosts/);
  });

  it("masks secret values that show up in error messages", async () => {
    const caseId = await makeCase("Mask check", [
      s({ name: "Open sign-in", action: "navigate", value: "/login" }),
      s({ name: "Password", action: "fill", locatorType: "id", locatorValue: "password", value: "{{secrets.SAMPLE_PASSWORD}}" }),
      s({ name: "Wrong expectation", action: "assert_value", locatorType: "id", locatorValue: "password", value: "something-else", options: { timeoutMs: 1000 } }),
    ]);
    const run = await runAndWait(caseId);
    expect(run.status).toBe("failed");
    expect(run.errorMessage).toContain("••••••");
    expect(JSON.stringify(await stepsOf(run.id))).not.toContain(SAMPLE_USER.password);
  });

  it("retries a failing test and keeps every attempt", async () => {
    const caseId = await makeCase("Retry", [s({ name: "Open", action: "navigate", value: "/login" }), s({ name: "Nope", action: "assert_text", value: "Never shown", options: { timeoutMs: 800 } })], { maxRetries: 1 });
    const run = await runAndWait(caseId);
    expect(run.status).toBe("failed");
    expect(run.attempt).toBe(2);
    const steps = await stepsOf(run.id);
    expect(steps.filter((x) => x.attempt === 1)).toHaveLength(2);
    expect(steps.filter((x) => x.attempt === 2)).toHaveLength(2);
  });

  it("cancels a running test", async () => {
    const caseId = await makeCase("Long pause", [s({ name: "Open", action: "navigate", value: "/login" }), s({ name: "Pause", action: "wait", value: "60" })]);
    const res = await c.post(`/api/workspaces/${ws}/runs`).send({ caseId });
    const runId = res.body.runId;
    const until = Date.now() + 30_000;
    while (Date.now() < until) {
      const [r] = await db.select().from(testExecutions).where(eq(testExecutions.id, runId));
      if (r.status === "running") break;
      await new Promise((x) => setTimeout(x, 200));
    }
    await new Promise((x) => setTimeout(x, 1500));
    const cancel = await c.post(`/api/workspaces/${ws}/runs/${runId}/cancel`).send({});
    expect(cancel.body.status).toBe("cancel_requested");
    const started = Date.now();
    const run = await waitFor(runId, 30_000);
    expect(run.status).toBe("cancelled");
    expect(Date.now() - started).toBeLessThan(20_000);
  });

  it("stops a test at its time limit", async () => {
    const caseId = await makeCase("Too slow", [s({ name: "Open", action: "navigate", value: "/login" }), s({ name: "Pause", action: "wait", value: "60" })], { timeoutMs: 10_000 });
    const run = await runAndWait(caseId, 40_000);
    expect(run.status).toBe("timed_out");
    expect(run.duration!).toBeLessThan(20_000);
  });

  it("requeues a run whose worker stopped responding, once", async () => {
    const caseId = await makeCase("Orphaned", [s({ name: "Open", action: "navigate", value: "/login" })]);
    const [orphan] = await db
      .insert(testExecutions)
      .values({ workspaceId: ws, caseId, caseVersion: 1, environmentId: envId, status: "running", trigger: "manual", workerId: "dead-worker", leaseExpiresAt: new Date(Date.now() - 60_000), startTime: new Date() })
      .returning();
    const run = await waitFor(orphan.id, 40_000);
    expect(run.status).toBe("passed");
    const events = await db.select().from(runEvents).where(eq(runEvents.executionId, orphan.id));
    expect(events.filter((e) => e.type === "requeued")).toHaveLength(1);
  });

  it("refuses to run unpublished tests and won't queue duplicates for one idempotency key", async () => {
    const draft = await c.post(`/api/workspaces/${ws}/cases`).send({ name: "Draft only", suiteId, steps: [s({ name: "Open", action: "navigate", value: "/" })] });
    const r = await c.post(`/api/workspaces/${ws}/runs`).send({ caseId: draft.body.id });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/Publish/);

    const caseId = await makeCase("Idempotent", [s({ name: "Open", action: "navigate", value: "/login" })]);
    const results = await Promise.all(Array.from({ length: 5 }, () => c.post(`/api/workspaces/${ws}/runs`).send({ caseId, idempotencyKey: "deploy-2026-10-16" })));
    const ids = new Set(results.map((x) => x.body.runId));
    expect(ids.size).toBe(1);
    await waitFor([...ids][0] as number);
  });
});
