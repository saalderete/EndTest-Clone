// Dates, durations and numbers, always in the workspace's timezone.
export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
  const m = Math.floor(s / 60);
  const rest = Math.round(s % 60);
  if (m < 60) return rest ? `${m}m ${rest}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function dateTime(iso: string | null | undefined, tz: string, opts: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "short" }) {
  if (!iso) return "—";
  return new Intl.DateTimeFormat(undefined, { ...opts, timeZone: tz }).format(new Date(iso));
}

export function time(iso: string | null | undefined, tz: string) {
  return dateTime(iso, tz, { hour: "numeric", minute: "2-digit" });
}

export function tzLabel(tz: string) {
  try {
    const part = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" }).formatToParts(new Date()).find((p) => p.type === "timeZoneName");
    return part?.value ?? tz;
  } catch {
    return tz;
  }
}

const rtf = typeof Intl !== "undefined" ? new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }) : null;
export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "never";
  const diff = (new Date(iso).getTime() - now) / 1000;
  const abs = Math.abs(diff);
  const [v, u]: [number, Intl.RelativeTimeFormatUnit] =
    abs < 45 ? [Math.round(diff), "second"] : abs < 2700 ? [Math.round(diff / 60), "minute"] : abs < 64800 ? [Math.round(diff / 3600), "hour"] : abs < 2592000 ? [Math.round(diff / 86400), "day"] : [Math.round(diff / 2592000), "month"];
  if (u === "second" && Math.abs(v) < 10) return diff >= 0 ? "in a few seconds" : "just now";
  return rtf ? rtf.format(v, u) : new Date(iso).toLocaleString();
}

export function percent(x: number | null | undefined, digits = 1): string {
  if (x === null || x === undefined) return "—";
  const v = x * 100;
  return `${v === 100 || v === 0 ? v.toFixed(0) : v.toFixed(digits)}%`;
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export const number = (n: number | null | undefined) => (n === null || n === undefined ? "—" : new Intl.NumberFormat().format(n));

/** "0 * * * *" → "Every hour" for the common presets; otherwise the expression itself. */
export function describeCron(cron: string): string {
  const known: Record<string, string> = {
    "*/15 * * * *": "Every 15 minutes",
    "*/30 * * * *": "Every 30 minutes",
    "0 * * * *": "Every hour",
    "5 * * * *": "Every hour at :05",
  };
  if (known[cron]) return known[cron];
  const m = cron.match(/^(\d{1,2}) (\d{1,2}) \* \* (\*|1-5|\d)$/);
  if (m) {
    const t = `${m[2].padStart(2, "0")}:${m[1].padStart(2, "0")}`;
    if (m[3] === "*") return `Every day at ${t}`;
    if (m[3] === "1-5") return `Weekdays at ${t}`;
    return `Every ${["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][Number(m[3])] ?? "week"} at ${t}`;
  }
  const h = cron.match(/^(\d{1,2}) \* \* \* \*$/);
  if (h) return `Every hour at :${h[1].padStart(2, "0")}`;
  return cron;
}

export const COMMON_TIMEZONES = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Phoenix",
  "America/Los_Angeles",
  "America/Mexico_City",
  "Europe/London",
  "Europe/Madrid",
  "Europe/Berlin",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Australia/Sydney",
];
