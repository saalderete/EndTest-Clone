// Turns finished runs into incidents and deduplicated alerts.
//  * A failed or timed-out run opens an incident for the test (or extends the
//    open one). Each rule alerts once, when the streak reaches its threshold.
//  * A passing run resolves the open incident; rules that alerted get one
//    recovery message.
//  * Infrastructure errors and cancellations don't touch incidents: they say
//    nothing about the application under test.
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { config } from "../config";
import { db } from "../db/client";
import { environments, incidents, notificationRules, testCases, testExecutions, workspaces, type TestExecution } from "@shared/schema";
import { deliver } from "./channels";

function fmt(d: Date | null | undefined, tz: string) {
  if (!d) return "never";
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: tz }).format(d) + ` (${tz})`;
}

export async function onRunFinished(run: TestExecution) {
  if (run.status !== "passed" && run.status !== "failed" && run.status !== "timed_out") return;
  const [c] = await db.select().from(testCases).where(eq(testCases.id, run.caseId));
  const [w] = await db.select().from(workspaces).where(eq(workspaces.id, run.workspaceId));
  if (!c || !w) return;
  const [env] = run.environmentId ? await db.select().from(environments).where(eq(environments.id, run.environmentId)) : [];
  const [open] = await db.select().from(incidents).where(and(eq(incidents.caseId, c.id), isNull(incidents.resolvedAt)));
  const rules = await db
    .select()
    .from(notificationRules)
    .where(
      and(
        eq(notificationRules.workspaceId, w.id),
        eq(notificationRules.enabled, true),
        or(eq(notificationRules.caseId, c.id), eq(notificationRules.suiteId, c.suiteId), and(isNull(notificationRules.caseId), isNull(notificationRules.suiteId))),
      ),
    );
  const link = `${config.APP_URL}/w/${w.id}/runs/${run.id}`;
  const envName = env ? `${env.name} (${env.baseUrl})` : "unknown environment";

  if (run.status === "passed") {
    if (!open) return;
    await db.update(incidents).set({ resolvedAt: new Date(), resolvedByExecutionId: run.id }).where(eq(incidents.id, open.id));
    if (!open.notifiedAt) return;
    for (const r of rules.filter((r) => r.onRecovery && open.consecutiveFailures >= r.failureThreshold)) {
      await deliver({
        channel: r.channel,
        target: r.target,
        kind: "recovery",
        workspaceId: w.id,
        ruleId: r.id,
        incidentId: open.id,
        executionId: run.id,
        message: {
          subject: `Recovered: ${c.name}`,
          text: `${c.name} is passing again on ${envName}.\n\nIt had failed ${open.consecutiveFailures} time(s) in a row since ${fmt(open.openedAt, w.timezone)}.\nPassing run: ${link}`,
        },
        payload: { event: "recovered", test: c.name, runId: run.id, url: link },
      });
    }
    return;
  }

  // failed / timed out
  let incident = open;
  if (incident) {
    [incident] = await db
      .update(incidents)
      .set({ consecutiveFailures: sql`${incidents.consecutiveFailures} + 1` })
      .where(eq(incidents.id, incident.id))
      .returning();
  } else {
    const inserted = await db.insert(incidents).values({ workspaceId: w.id, caseId: c.id, openedByExecutionId: run.id }).onConflictDoNothing().returning();
    // Another worker opened it at the same moment: use theirs.
    incident = inserted[0] ?? (await db.select().from(incidents).where(and(eq(incidents.caseId, c.id), isNull(incidents.resolvedAt))))[0];
  }
  if (!incident) return;

  const due = rules.filter((r) => r.onFailure && incident!.consecutiveFailures === r.failureThreshold);
  if (!due.length) return;
  const [lastPass] = await db
    .select({ createdAt: testExecutions.createdAt })
    .from(testExecutions)
    .where(and(eq(testExecutions.caseId, c.id), eq(testExecutions.status, "passed")))
    .orderBy(sql`${testExecutions.id} DESC`)
    .limit(1);
  const what = run.status === "timed_out" ? "timed out" : "failed";
  const text = [
    `${c.name} ${what} on ${envName}.`,
    "",
    `When: ${fmt(run.endTime, w.timezone)}`,
    `Failed step: ${run.failedStepIndex ? `#${run.failedStepIndex}` : "n/a"}`,
    `Error: ${run.errorMessage ?? "unknown"}`,
    `Failures in a row: ${incident.consecutiveFailures}`,
    `Last passed: ${fmt(lastPass?.createdAt, w.timezone)}`,
    "",
    `Investigate (screenshots and step log): ${link}`,
    "",
    "You'll get one message when it recovers, not one per failed run.",
  ].join("\n");
  for (const r of due) {
    await deliver({
      channel: r.channel,
      target: r.target,
      kind: "failure",
      workspaceId: w.id,
      ruleId: r.id,
      incidentId: incident.id,
      executionId: run.id,
      message: { subject: `${c.priority === "critical" ? "[Critical] " : ""}Failing: ${c.name}`, text },
      payload: { event: "failing", test: c.name, priority: c.priority, runId: run.id, url: link, error: run.errorMessage, consecutiveFailures: incident.consecutiveFailures },
    });
  }
  await db.update(incidents).set({ notifiedAt: new Date() }).where(eq(incidents.id, incident.id));
}
