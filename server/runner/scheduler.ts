// Dispatches due schedules. Exactly one process leads (PostgreSQL advisory
// lock held on a dedicated connection); any number may stand by. Runs are
// queued with an idempotency key per test per due time, so even two leaders
// (or a test schedule and a suite schedule due at the same minute) can never
// queue the same run twice.
import type pg from "pg";
import { pool } from "../db/client";
import { errorFields, log } from "../lib/log";
import { nextRun } from "../services/cron";
import { enqueueCase, enqueueSuite } from "../services/runs";
import { audit } from "../services/audit";

const LOCK_ID = 7_315_001;
const TICK_MS = 10_000;
// A due time older than this (the scheduler was down) is skipped, not run late.
const MAX_LATENESS_MS = 10 * 60_000;

type Due = { id: number; workspace_id: number; case_id: number | null; suite_id: number | null; cron: string; timezone: string; next_run_at: Date };

export async function startScheduler(): Promise<() => Promise<void>> {
  let leader: pg.PoolClient | null = null;
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  async function ensureLeadership(): Promise<boolean> {
    if (leader) return true;
    const client = await pool.connect();
    const { rows } = await client.query("SELECT pg_try_advisory_lock($1) AS ok", [LOCK_ID]);
    if (rows[0].ok) {
      leader = client;
      client.on("error", () => {
        leader = null; // connection lost: the lock is gone with it
      });
      log.info("scheduler: leading");
      return true;
    }
    client.release();
    return false;
  }

  async function tick() {
    if (!(await ensureLeadership())) return;
    const c = leader!;
    const paused = await c.query("SELECT value FROM system_state WHERE key = 'dispatch_paused'");
    if (paused.rows[0]?.value === true) return;

    // Schedules that were just resumed or created without a next time.
    const fresh = await c.query("SELECT id, cron, timezone FROM schedules WHERE NOT paused AND next_run_at IS NULL LIMIT 200");
    for (const s of fresh.rows) {
      try {
        await c.query("UPDATE schedules SET next_run_at = $1 WHERE id = $2", [nextRun(s.cron, s.timezone), s.id]);
      } catch (err) {
        await c.query("UPDATE schedules SET paused = true, last_error = $1 WHERE id = $2", [`Paused: ${(err as Error).message}`, s.id]);
      }
    }

    const due = await c.query<Due>("SELECT id, workspace_id, case_id, suite_id, cron, timezone, next_run_at FROM schedules WHERE NOT paused AND next_run_at <= now() ORDER BY next_run_at LIMIT 50");
    for (const s of due.rows) {
      const dueAt = s.next_run_at;
      const now = Date.now();
      let next: Date;
      try {
        next = nextRun(s.cron, s.timezone, new Date(Math.max(now, dueAt.getTime())));
      } catch (err) {
        await c.query("UPDATE schedules SET paused = true, last_error = $1 WHERE id = $2", [`Paused: ${(err as Error).message}`, s.id]);
        continue;
      }
      // Advance first, so a crash mid-dispatch can't fire the same time again
      // (and the idempotency key covers the rest).
      const moved = await c.query("UPDATE schedules SET next_run_at = $1, last_run_at = $2, updated_at = now() WHERE id = $3 AND next_run_at = $2", [next, dueAt, s.id]);
      if (!moved.rowCount) continue;

      if (now - dueAt.getTime() > MAX_LATENESS_MS) {
        await c.query("UPDATE schedules SET last_error = $1 WHERE id = $2", [`Skipped the ${dueAt.toISOString()} run: the scheduler was offline at the time.`, s.id]);
        continue;
      }

      try {
        // Same key shape for test and suite schedules: one run per test per due time.
        const key = (caseId: number) => `schedule:${dueAt.toISOString()}:${caseId}`;
        let message: string | null = null;
        if (s.case_id) {
          const r = await enqueueCase(s.workspace_id, s.case_id, { trigger: "schedule", scheduleId: s.id, idempotencyKey: key(s.case_id), applyOverlapPolicy: true });
          if ("skipped" in r) message = `Skipped the ${dueAt.toISOString()} run: ${r.skipped}.`;
        } else if (s.suite_id) {
          const r = await enqueueSuite(s.workspace_id, s.suite_id, { trigger: "schedule", scheduleId: s.id, applyOverlapPolicy: true, idempotencyKey: `schedule:${dueAt.toISOString()}` });
          if (r.skipped.length) message = `${r.skipped.length} test(s) not queued: ${r.skipped.map((x) => `${x.name} (${x.reason})`).join("; ")}`.slice(0, 1000);
        }
        await c.query("UPDATE schedules SET last_error = $1 WHERE id = $2", [message, s.id]);
      } catch (err) {
        const msg = (err as Error).message;
        await c.query("UPDATE schedules SET last_error = $1 WHERE id = $2", [msg.slice(0, 1000), s.id]);
        await audit(null, "schedule.dispatch_failed", { type: "schedule", id: s.id }, { error: msg }, { workspaceId: s.workspace_id, actorUserId: null });
        log.warn("scheduler: dispatch failed", { scheduleId: s.id, ...errorFields(err) });
      }
    }
  }

  const loop = async () => {
    if (stopped) return;
    try {
      await tick();
    } catch (err) {
      log.error("scheduler tick failed", errorFields(err));
      if (leader) {
        leader.release(true);
        leader = null;
      }
    }
    if (!stopped) timer = setTimeout(loop, TICK_MS);
  };
  void loop();

  return async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    if (leader) {
      await leader.query("SELECT pg_advisory_unlock($1)", [LOCK_ID]).catch(() => {});
      leader.release();
      leader = null;
    }
  };
}
