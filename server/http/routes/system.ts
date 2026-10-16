// Health checks and the server-wide emergency stop (system administrators only).
import { Router } from "express";
import { sql } from "drizzle-orm";
import { db, pool } from "../../db/client";
import { requireSystemAdmin } from "../authz";
import { audit } from "../../services/audit";

export const systemRouter = Router();

// Liveness: the process answers.
systemRouter.get("/health", (_req, res) => res.json({ ok: true }));

// Readiness: the database answers and migrations are applied.
systemRouter.get("/ready", async (_req, res) => {
  try {
    const r = await pool.query("SELECT count(*)::int AS n FROM schema_migrations");
    res.json({ ok: true, migrations: r.rows[0].n });
  } catch {
    res.status(503).json({ ok: false });
  }
});

export async function dispatchPaused(): Promise<boolean> {
  const r = await pool.query("SELECT value FROM system_state WHERE key = 'dispatch_paused'");
  return r.rows[0]?.value === true;
}

systemRouter.get("/system/status", requireSystemAdmin, async (_req, res) => {
  const workers = (
    await db.execute(sql`SELECT worker_id AS "workerId", hostname, version, started_at AS "startedAt", heartbeat_at AS "heartbeatAt",
      current_execution_id AS "currentExecutionId", browser_ok AS "browserOk", heartbeat_at > now() - interval '60 seconds' AS online
      FROM worker_heartbeats ORDER BY heartbeat_at DESC LIMIT 20`)
  ).rows;
  const [queue] = (
    await db.execute(sql`SELECT count(*) FILTER (WHERE status = 'queued')::int AS queued,
      count(*) FILTER (WHERE status IN ('starting','running','cancel_requested'))::int AS running,
      extract(epoch FROM now() - min(queued_at) FILTER (WHERE status = 'queued'))::int AS "oldestQueuedSeconds"
      FROM test_executions`)
  ).rows;
  const [late] = (
    await db.execute(sql`SELECT count(*)::int AS late FROM schedules WHERE NOT paused AND next_run_at < now() - interval '2 minutes'`)
  ).rows;
  res.json({ dispatchPaused: await dispatchPaused(), workers, queue, lateSchedules: (late as { late: number }).late });
});

systemRouter.post("/system/emergency-stop", requireSystemAdmin, async (req, res) => {
  await pool.query("UPDATE system_state SET value = 'true', updated_by = $1, updated_at = now() WHERE key = 'dispatch_paused'", [req.user!.id]);
  const now = new Date();
  const queued = await pool.query(
    `UPDATE test_executions SET status = 'cancelled', end_time = $1, cancel_requested_at = $1, cancelled_by = $2,
       error_message = 'Stopped by an emergency stop', error_category = 'cancelled'
     WHERE status = 'queued' RETURNING id`,
    [now, req.user!.id],
  );
  const running = await pool.query(
    `UPDATE test_executions SET status = 'cancel_requested', cancel_requested_at = $1, cancelled_by = $2
     WHERE status IN ('starting','running') RETURNING id`,
    [now, req.user!.id],
  );
  await audit(req, "system.emergency_stop", undefined, { cancelledQueued: queued.rowCount, stoppingRunning: running.rowCount }, { workspaceId: null });
  res.json({ dispatchPaused: true, cancelledQueued: queued.rowCount, stoppingRunning: running.rowCount });
});

systemRouter.post("/system/resume", requireSystemAdmin, async (req, res) => {
  await pool.query("UPDATE system_state SET value = 'false', updated_by = $1, updated_at = now() WHERE key = 'dispatch_paused'", [req.user!.id]);
  // Don't fire everything that came due during the stop: move due schedules to their next time.
  await pool.query("UPDATE schedules SET next_run_at = NULL WHERE NOT paused AND next_run_at < now()");
  await audit(req, "system.resumed", undefined, {}, { workspaceId: null });
  res.json({ dispatchPaused: false });
});
