// Structured JSON logs with redaction. Never log request or response bodies,
// cookies, or authorization headers.
import { config } from "../config";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;
const threshold = LEVELS[config.LOG_LEVEL];

const SECRET_KEYS = /pass(word)?|secret|token|authorization|cookie|api[-_]?key|ciphertext|session/i;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 5 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEYS.test(k) ? "[redacted]" : redact(v, depth + 1);
  }
  return out;
}

function write(level: Level, msg: string, fields?: Record<string, unknown>) {
  if (LEVELS[level] < threshold || config.NODE_ENV === "test") return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...(fields ? (redact(fields) as object) : {}) });
  (level === "error" || level === "warn" ? process.stderr : process.stdout).write(line + "\n");
}

export const log = {
  debug: (msg: string, f?: Record<string, unknown>) => write("debug", msg, f),
  info: (msg: string, f?: Record<string, unknown>) => write("info", msg, f),
  warn: (msg: string, f?: Record<string, unknown>) => write("warn", msg, f),
  error: (msg: string, f?: Record<string, unknown>) => write("error", msg, f),
};

export function errorFields(err: unknown): Record<string, unknown> {
  if (err instanceof Error) return { error: err.message, stack: err.stack?.split("\n").slice(0, 6).join("\n") };
  return { error: String(err) };
}
