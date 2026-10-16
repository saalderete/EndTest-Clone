// Cron parsing in a schedule's own timezone.
import cronParser from "cron-parser";

export const PRESETS = [
  { label: "Every 15 minutes", cron: "*/15 * * * *" },
  { label: "Every 30 minutes", cron: "*/30 * * * *" },
  { label: "Every hour", cron: "0 * * * *" },
  { label: "Every day at 7:00", cron: "0 7 * * *" },
  { label: "Weekdays at 7:00", cron: "0 7 * * 1-5" },
  { label: "Every Monday at 8:00", cron: "0 8 * * 1" },
] as const;

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Throws a readable error for an invalid expression or one that fires more often than every 5 minutes. */
export function validateCron(expr: string, tz: string): void {
  if (!isValidTimezone(tz)) throw new Error(`Unknown timezone “${tz}”.`);
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error("Use a five-field cron expression: minute hour day-of-month month day-of-week.");
  let it;
  try {
    it = cronParser.parseExpression(expr, { tz });
  } catch (err) {
    throw new Error(`That cron expression isn't valid: ${(err as Error).message}`);
  }
  const a = it.next().toDate().getTime();
  const b = it.next().toDate().getTime();
  if (b - a < 5 * 60_000) throw new Error("Schedules can run at most every 5 minutes.");
}

export function nextRuns(expr: string, tz: string, count = 5, from = new Date()): Date[] {
  const it = cronParser.parseExpression(expr, { tz, currentDate: from });
  return Array.from({ length: count }, () => it.next().toDate());
}

export function nextRun(expr: string, tz: string, from = new Date()): Date {
  return nextRuns(expr, tz, 1, from)[0];
}
