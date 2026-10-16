// Analytics and reports, computed from persisted runs only.
//
// Definitions (also shown in the UI):
//  * Pass rate = passed / (passed + failed + timed out). Infrastructure errors
//    and cancellations are excluded from the denominator and reported separately,
//    because they say nothing about the application under test.
//  * Durations are of passed runs (failed runs stop early and would skew them).
//  * Flakiness = status flips between consecutive finished runs (passed vs
//    failed/timed out) divided by (n - 1), over the last 20 such runs.
//    A test is flagged flaky at >= 0.3 with at least 5 runs.
//  * Consecutive failures = failed/timed-out runs since the last pass.
import { Router } from "express";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { db } from "../../db/client";
import { ws } from "../authz";
import { badRequest } from "../../lib/errors";
import { parse } from "../validate";

export const insightsRouter = Router({ mergeParams: true });

const RANGES = { "24h": "24 hours", "7d": "7 days", "30d": "30 days", "90d": "90 days" } as const;
const rangeQuery = z.object({
  range: z.enum(["24h", "7d", "30d", "90d"]).default("7d"),
  environmentId: z.coerce.number().int().positive().optional(),
});

const envFilter = (envId?: number) => (envId ? sql`AND e.environment_id = ${envId}` : sql``);

insightsRouter.get("/analytics/overview", async (req, res) => {
  const q = parse(rangeQuery, req.query);
  const w = ws(req).id;
  const interval = RANGES[q.range];
  const [totals] = (
    await db.execute(sql`
      SELECT
        count(*) FILTER (WHERE status = 'passed')::int AS passed,
        count(*) FILTER (WHERE status = 'failed')::int AS failed,
        count(*) FILTER (WHERE status = 'timed_out')::int AS timed_out,
        count(*) FILTER (WHERE status = 'infrastructure_error')::int AS infrastructure_error,
        count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
        count(*) FILTER (WHERE status = 'passed' AND attempt > 1)::int AS passed_on_retry,
        coalesce(sum(warnings) FILTER (WHERE status = 'passed'), 0)::int AS warnings_on_passes,
        round(avg(duration) FILTER (WHERE status = 'passed'))::int AS mean_ms,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY duration) FILTER (WHERE status = 'passed')::int AS p50_ms,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY duration) FILTER (WHERE status = 'passed')::int AS p95_ms
      FROM test_executions e
      WHERE e.workspace_id = ${w} AND e.created_at > now() - ${interval}::interval ${envFilter(q.environmentId)}`)
  ).rows as Record<string, number | null>[];
  const [active] = (
    await db.execute(sql`
      SELECT count(*) FILTER (WHERE status = 'queued')::int AS queued,
             count(*) FILTER (WHERE status IN ('starting','running','cancel_requested'))::int AS running
      FROM test_executions e WHERE e.workspace_id = ${w}`)
  ).rows as { queued: number; running: number }[];
  const bucket = q.range === "24h" ? "hour" : "day";
  const trend = (
    await db.execute(sql`
      SELECT date_trunc(${bucket}, e.created_at AT TIME ZONE ${ws(req).timezone}) AS t,
        count(*) FILTER (WHERE status = 'passed')::int AS passed,
        count(*) FILTER (WHERE status IN ('failed','timed_out'))::int AS failed,
        count(*) FILTER (WHERE status = 'infrastructure_error')::int AS infra
      FROM test_executions e
      WHERE e.workspace_id = ${w} AND e.created_at > now() - ${interval}::interval ${envFilter(q.environmentId)}
      GROUP BY 1 ORDER BY 1`)
  ).rows;
  const incidents = (
    await db.execute(sql`
      SELECT i.id, i.case_id AS "caseId", c.name AS "caseName", c.priority, i.opened_at AS "openedAt", i.consecutive_failures AS "consecutiveFailures"
      FROM incidents i JOIN test_cases c ON c.id = i.case_id
      WHERE i.workspace_id = ${w} AND i.resolved_at IS NULL
      ORDER BY CASE c.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 ELSE 2 END, i.opened_at`)
  ).rows;
  const [sched] = (
    await db.execute(sql`
      SELECT count(*) FILTER (WHERE NOT paused)::int AS active, count(*) FILTER (WHERE paused)::int AS paused,
             min(next_run_at) FILTER (WHERE NOT paused) AS next_at
      FROM schedules WHERE workspace_id = ${w}`)
  ).rows as { active: number; paused: number; next_at: string | null }[];
  const t = totals;
  const judged = (t.passed ?? 0) + (t.failed ?? 0) + (t.timed_out ?? 0);
  res.json({
    range: q.range,
    generatedAt: new Date(),
    totals: { ...t, judged, passRate: judged ? (t.passed ?? 0) / judged : null },
    active,
    trend,
    openIncidents: incidents,
    schedules: sched,
  });
});

/** Per-test health over the range. */
export async function caseStats(workspaceId: number, interval: string, envId?: number) {
  const rows = await db.execute(sql`
    WITH runs AS (
      SELECT e.*, row_number() OVER (PARTITION BY e.case_id ORDER BY e.created_at DESC) AS rn
      FROM test_executions e
      WHERE e.workspace_id = ${workspaceId} AND e.status IN ('passed','failed','timed_out') ${envFilter(envId)}
    ),
    recent AS (SELECT * FROM runs WHERE rn <= 20),
    flips AS (
      SELECT case_id,
        count(*) FILTER (WHERE (status = 'passed') <> (prev = 'passed'))::int AS flips,
        count(*)::int AS n
      FROM (SELECT case_id, status, lag(status) OVER (PARTITION BY case_id ORDER BY created_at) AS prev FROM recent) x
      WHERE prev IS NOT NULL GROUP BY case_id
    ),
    streak AS (
      SELECT case_id, count(*)::int AS consecutive_failures
      FROM runs r
      WHERE r.status <> 'passed' AND r.created_at > coalesce((SELECT max(created_at) FROM runs p WHERE p.case_id = r.case_id AND p.status = 'passed'), '-infinity')
      GROUP BY case_id
    ),
    ranged AS (
      SELECT e.case_id,
        count(*)::int AS runs,
        count(*) FILTER (WHERE status = 'passed')::int AS passed,
        count(*) FILTER (WHERE status IN ('failed','timed_out'))::int AS failed,
        count(*) FILTER (WHERE status = 'infrastructure_error')::int AS infra,
        count(*) FILTER (WHERE status = 'passed' AND attempt > 1)::int AS passed_on_retry,
        coalesce(sum(warnings), 0)::int AS warnings,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY duration) FILTER (WHERE status = 'passed')::int AS p50_ms,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY duration) FILTER (WHERE status = 'passed')::int AS p95_ms
      FROM test_executions e
      WHERE e.workspace_id = ${workspaceId} AND e.created_at > now() - ${interval}::interval ${envFilter(envId)}
      GROUP BY e.case_id
    )
    SELECT c.id AS "caseId", c.name, c.priority, c.suite_id AS "suiteId", s.name AS "suiteName", c.needs_review AS "needsReview",
      coalesce(r.runs, 0) AS runs, coalesce(r.passed, 0) AS passed, coalesce(r.failed, 0) AS failed, coalesce(r.infra, 0) AS infra,
      coalesce(r.passed_on_retry, 0) AS "passedOnRetry", coalesce(r.warnings, 0) AS warnings,
      r.p50_ms AS "p50Ms", r.p95_ms AS "p95Ms",
      CASE WHEN coalesce(r.passed, 0) + coalesce(r.failed, 0) > 0 THEN r.passed::float / (r.passed + r.failed) END AS "passRate",
      coalesce(st.consecutive_failures, 0) AS "consecutiveFailures",
      f.flips, f.n AS "flipWindow",
      CASE WHEN f.n >= 4 THEN round(f.flips::numeric / f.n, 2)::float END AS flakiness,
      (SELECT max(created_at) FROM test_executions p WHERE p.case_id = c.id AND p.status = 'passed') AS "lastPassAt",
      (SELECT status FROM test_executions l WHERE l.case_id = c.id ORDER BY l.created_at DESC LIMIT 1) AS "lastStatus",
      (SELECT created_at FROM test_executions l WHERE l.case_id = c.id ORDER BY l.created_at DESC LIMIT 1) AS "lastRunAt",
      (SELECT u.email FROM users u WHERE u.id = c.created_by) AS owner
    FROM test_cases c
    JOIN test_suites s ON s.id = c.suite_id
    LEFT JOIN ranged r ON r.case_id = c.id
    LEFT JOIN flips f ON f.case_id = c.id
    LEFT JOIN streak st ON st.case_id = c.id
    WHERE c.workspace_id = ${workspaceId}
    ORDER BY coalesce(st.consecutive_failures, 0) DESC, c.name`);
  return rows.rows;
}

insightsRouter.get("/analytics/cases", async (req, res) => {
  const q = parse(rangeQuery, req.query);
  res.json({ range: q.range, generatedAt: new Date(), cases: await caseStats(ws(req).id, RANGES[q.range], q.environmentId) });
});

insightsRouter.get("/analytics/failing-steps", async (req, res) => {
  const q = parse(rangeQuery, req.query);
  const rows = await db.execute(sql`
    SELECT c.id AS "caseId", c.name AS "caseName", se.step_index AS "stepIndex", se.step_name AS "stepName", se.action,
      count(*)::int AS failures, max(e.created_at) AS "lastFailedAt",
      (array_agg(se.error_message ORDER BY e.created_at DESC))[1] AS "lastError"
    FROM step_executions se
    JOIN test_executions e ON e.id = se.execution_id
    JOIN test_cases c ON c.id = e.case_id
    WHERE e.workspace_id = ${ws(req).id} AND se.status = 'failed' AND e.created_at > now() - ${RANGES[q.range]}::interval ${envFilter(q.environmentId)}
    GROUP BY 1, 2, 3, 4, 5
    ORDER BY failures DESC
    LIMIT 15`);
  res.json(rows.rows);
});

// ------------------------------------------------------------------ reports

const periodQuery = z.object({
  from: z.coerce.date(),
  to: z.coerce.date(),
  environmentId: z.coerce.number().int().positive().optional(),
});

function period(req: { query: unknown }) {
  const q = parse(periodQuery, req.query);
  if (q.to <= q.from) throw badRequest("The end of the period must be after the start.");
  if (q.to.getTime() - q.from.getTime() > 366 * 86400_000) throw badRequest("Choose a period of a year or less.");
  return q;
}

insightsRouter.get("/reports/summary", async (req, res) => {
  const q = period(req);
  const w = ws(req);
  const [t] = (
    await db.execute(sql`
      SELECT count(*)::int AS total,
        count(*) FILTER (WHERE status = 'passed')::int AS passed,
        count(*) FILTER (WHERE status IN ('failed','timed_out'))::int AS failed,
        count(*) FILTER (WHERE status = 'infrastructure_error')::int AS infra,
        count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY duration) FILTER (WHERE status = 'passed')::int AS p95_ms
      FROM test_executions e
      WHERE e.workspace_id = ${w.id} AND e.created_at >= ${q.from} AND e.created_at < ${q.to} ${envFilter(q.environmentId)}`)
  ).rows as Record<string, number>[];
  const perCase = (
    await db.execute(sql`
      SELECT c.name, s.name AS suite, c.priority,
        count(e.id)::int AS runs,
        count(e.id) FILTER (WHERE e.status = 'passed')::int AS passed,
        count(e.id) FILTER (WHERE e.status IN ('failed','timed_out'))::int AS failed,
        count(e.id) FILTER (WHERE e.status = 'infrastructure_error')::int AS infra,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY e.duration) FILTER (WHERE e.status = 'passed')::int AS p50_ms
      FROM test_cases c JOIN test_suites s ON s.id = c.suite_id
      LEFT JOIN test_executions e ON e.case_id = c.id AND e.created_at >= ${q.from} AND e.created_at < ${q.to} ${envFilter(q.environmentId)}
      WHERE c.workspace_id = ${w.id}
      GROUP BY c.id, s.name ORDER BY s.name, c.name`)
  ).rows;
  const incidents = (
    await db.execute(sql`
      SELECT c.name AS "caseName", i.opened_at AS "openedAt", i.resolved_at AS "resolvedAt", i.consecutive_failures AS "consecutiveFailures"
      FROM incidents i JOIN test_cases c ON c.id = i.case_id
      WHERE i.workspace_id = ${w.id} AND i.opened_at < ${q.to} AND (i.resolved_at IS NULL OR i.resolved_at >= ${q.from})
      ORDER BY i.opened_at`)
  ).rows;
  const judged = (t.passed ?? 0) + (t.failed ?? 0);
  res.json({
    workspace: { name: w.name, timezone: w.timezone },
    period: { from: q.from, to: q.to },
    generatedAt: new Date(),
    generatedBy: req.user!.email,
    totals: { ...t, passRate: judged ? t.passed / judged : null },
    cases: perCase,
    incidents,
  });
});

const csvCell = (v: unknown) => {
  if (v === null || v === undefined) return "";
  const s = v instanceof Date ? v.toISOString() : String(v);
  // Neutralize spreadsheet formulas and quote everything that needs it.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

insightsRouter.get("/reports/runs.:format", async (req, res) => {
  const q = period(req);
  const format = req.params.format === "csv" ? "csv" : "json";
  const rows = (
    await db.execute(sql`
      SELECT e.id, c.name AS test, s.name AS suite, e.status, e.trigger, e.case_version AS version,
        e.queued_at, e.start_time, e.end_time, e.duration AS duration_ms, e.attempt, e.max_attempts,
        e.warnings, e.error_category, e.failed_step_index, left(e.error_message, 500) AS error
      FROM test_executions e JOIN test_cases c ON c.id = e.case_id JOIN test_suites s ON s.id = c.suite_id
      WHERE e.workspace_id = ${ws(req).id} AND e.created_at >= ${q.from} AND e.created_at < ${q.to} ${envFilter(q.environmentId)}
      ORDER BY e.id`)
  ).rows as Record<string, unknown>[];
  const name = `testharvest-runs-${q.from.toISOString().slice(0, 10)}-to-${q.to.toISOString().slice(0, 10)}`;
  if (format === "json") {
    res.setHeader("Content-Disposition", `attachment; filename="${name}.json"`);
    return res.json(rows);
  }
  const cols = ["id", "test", "suite", "status", "trigger", "version", "queued_at", "start_time", "end_time", "duration_ms", "attempt", "max_attempts", "warnings", "error_category", "failed_step_index", "error"];
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${name}.csv"`);
  res.send([cols.join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\n"));
});
