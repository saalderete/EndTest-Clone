// Environment configuration, validated once at startup. In production the app
// refuses to start without the secrets it needs instead of falling back to a
// guessable default.
import "dotenv/config";
import { randomBytes } from "node:crypto";
import { z } from "zod";

const bool = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? fallback : ["1", "true", "yes", "on"].includes(v.toLowerCase())));

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(5000),
  HOST: z.string().default("0.0.0.0"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  APP_URL: z.string().url().default("http://localhost:5000"),

  SESSION_SECRET: z.string().optional(),
  // 32 bytes, base64. Encrypts workspace secrets. `npm run admin -- gen-key` prints one.
  APP_ENCRYPTION_KEY: z.string().optional(),

  ALLOW_SIGNUP: bool(false),
  TRUST_PROXY: bool(false),

  // Worker
  RUN_WORKER: bool(false),
  RUN_SCHEDULER: bool(true),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
  // Runs at once per workspace across all workers; the rest wait in the queue.
  WORKSPACE_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(2),
  // Playwright traces on failure. Skipped for tests that use secrets (traces record typed values).
  TRACE_ON_FAILURE: bool(true),
  CHROMIUM_PATH: z.string().optional(),
  ARTIFACT_DIR: z.string().default("./data/artifacts"),
  ARTIFACT_RETENTION_DAYS: z.coerce.number().int().min(1).default(30),
  ALLOW_PRIVATE_NETWORK: bool(false),
  ALLOW_SCRIPT_STEPS: bool(false),

  // Notifications: nothing leaves the system unless this is on.
  NOTIFICATIONS_ENABLED: bool(false),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().optional(),
  SMTP_SECURE: bool(false),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  MAIL_FROM: z.string().optional(),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_FROM: z.string().optional(),

  // AI
  AI_ENABLED: bool(false),
  ANTHROPIC_API_KEY: z.string().optional(),
  AI_MODEL: z.string().default("claude-opus-5-5"),

  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Config = z.infer<typeof schema> & { sessionSecret: string; encryptionKey: Buffer | null };

function load(): Config {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  const env = parsed.data;
  const prod = env.NODE_ENV === "production";

  if (prod && (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32)) {
    throw new Error("SESSION_SECRET must be set to at least 32 random characters in production.");
  }
  let encryptionKey: Buffer | null = null;
  if (env.APP_ENCRYPTION_KEY) {
    encryptionKey = Buffer.from(env.APP_ENCRYPTION_KEY, "base64");
    if (encryptionKey.length !== 32) throw new Error("APP_ENCRYPTION_KEY must be 32 bytes, base64-encoded.");
  } else if (prod) {
    throw new Error("APP_ENCRYPTION_KEY must be set in production (npm run admin -- gen-key).");
  }

  return {
    ...env,
    // Development only: a per-process random secret, so sessions simply reset on restart.
    sessionSecret: env.SESSION_SECRET || randomBytes(32).toString("hex"),
    encryptionKey,
  };
}

export const config: Config = load();
