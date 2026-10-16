// Drizzle table definitions. These mirror migrations/*.sql exactly; the SQL
// files are the source of truth for the database, this file is the typed view.
import {
  pgTable,
  text,
  varchar,
  timestamp,
  jsonb,
  index,
  serial,
  integer,
  boolean,
  bigserial,
  bigint,
  primaryKey,
} from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true });

export const sessions = pgTable(
  "sessions",
  {
    sid: varchar("sid").primaryKey(),
    sess: jsonb("sess").notNull(),
    expire: timestamp("expire").notNull(),
  },
  (t) => [index("IDX_session_expire").on(t.expire)],
);

export const users = pgTable("users", {
  id: varchar("id").primaryKey(),
  email: varchar("email").unique(),
  firstName: varchar("first_name"),
  lastName: varchar("last_name"),
  profileImageUrl: varchar("profile_image_url"),
  passwordHash: varchar("password_hash"),
  authProvider: varchar("auth_provider"),
  isSystemAdmin: boolean("is_system_admin").notNull().default(false),
  emailVerifiedAt: ts("email_verified_at"),
  disabledAt: ts("disabled_at"),
  lastLoginAt: ts("last_login_at"),
  createdAt: ts("created_at").defaultNow(),
  updatedAt: ts("updated_at").defaultNow(),
});

export const passwordTokens = pgTable("password_tokens", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  purpose: text("purpose").$type<"set_password" | "reset_password" | "verify_email">().notNull(),
  expiresAt: ts("expires_at").notNull(),
  usedAt: ts("used_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const ROLES = ["owner", "admin", "editor", "runner", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export const workspaces = pgTable("workspaces", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  timezone: text("timezone").notNull().default("UTC"),
  aiEnabled: boolean("ai_enabled").notNull().default(false),
  aiMonthlyBudgetCents: integer("ai_monthly_budget_cents").notNull().default(2000),
  isDemo: boolean("is_demo").notNull().default(false),
  createdBy: varchar("created_by"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const memberships = pgTable(
  "memberships",
  {
    workspaceId: integer("workspace_id").notNull(),
    userId: varchar("user_id").notNull(),
    role: text("role").$type<Role>().notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.userId] })],
);

export const invitations = pgTable("invitations", {
  id: serial("id").primaryKey(),
  workspaceId: integer("workspace_id").notNull(),
  email: text("email").notNull(),
  role: text("role").$type<Role>().notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  invitedBy: varchar("invited_by"),
  expiresAt: ts("expires_at").notNull(),
  acceptedAt: ts("accepted_at"),
  revokedAt: ts("revoked_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const environments = pgTable("environments", {
  id: serial("id").primaryKey(),
  workspaceId: integer("workspace_id").notNull(),
  name: text("name").notNull(),
  baseUrl: text("base_url").notNull(),
  allowedHosts: text("allowed_hosts").array().notNull().default([]),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const secrets = pgTable("secrets", {
  id: serial("id").primaryKey(),
  workspaceId: integer("workspace_id").notNull(),
  name: text("name").notNull(),
  ciphertext: text("ciphertext").notNull(),
  description: text("description"),
  createdBy: varchar("created_by"),
  createdAt: ts("created_at").notNull().defaultNow(),
  rotatedAt: ts("rotated_at").notNull().defaultNow(),
});

export const testSuites = pgTable("test_suites", {
  id: serial("id").primaryKey(),
  workspaceId: integer("workspace_id").notNull(),
  environmentId: integer("environment_id"),
  name: text("name").notNull(),
  description: text("description"),
  userId: varchar("user_id"),
  tags: text("tags").array().notNull().default([]),
  isActive: boolean("is_active").default(true),
  createdAt: ts("created_at").defaultNow(),
  updatedAt: ts("updated_at").defaultNow(),
});

export const OVERLAP_POLICIES = ["skip", "queue", "cancel_previous"] as const;
export type OverlapPolicy = (typeof OVERLAP_POLICIES)[number];
export const PRIORITIES = ["critical", "high", "normal", "low"] as const;

export const testCases = pgTable("test_cases", {
  id: serial("id").primaryKey(),
  workspaceId: integer("workspace_id").notNull(),
  suiteId: integer("suite_id").notNull(),
  environmentId: integer("environment_id"),
  name: text("name").notNull(),
  description: text("description"),
  priority: text("priority").$type<(typeof PRIORITIES)[number]>().notNull().default("normal"),
  tags: text("tags").array().notNull().default([]),
  maxRetries: integer("max_retries").notNull().default(0),
  timeoutMs: integer("timeout_ms").notNull().default(300000),
  stepTimeoutMs: integer("step_timeout_ms").notNull().default(15000),
  overlapPolicy: text("overlap_policy").$type<OverlapPolicy>().notNull().default("skip"),
  isActive: boolean("is_active").notNull().default(true),
  publishedVersion: integer("published_version"),
  draftUpdatedAt: ts("draft_updated_at"),
  draftUpdatedBy: varchar("draft_updated_by"),
  needsReview: boolean("needs_review").notNull().default(false),
  reviewNote: text("review_note"),
  createdBy: varchar("created_by"),
  createdAt: ts("created_at").defaultNow(),
  updatedAt: ts("updated_at").defaultNow(),
});

export const testSteps = pgTable("test_steps", {
  id: serial("id").primaryKey(),
  caseId: integer("case_id").notNull(),
  stepOrder: integer("step_order").notNull(),
  stepName: text("step_name").notNull(),
  action: text("action").notNull(),
  locatorType: text("locator_type"),
  locatorValue: text("locator_value"),
  inputValue: text("input_value"),
  options: jsonb("options").$type<Record<string, unknown>>().notNull().default({}),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: ts("created_at").defaultNow(),
});

export const caseVersions = pgTable("case_versions", {
  id: serial("id").primaryKey(),
  caseId: integer("case_id").notNull(),
  workspaceId: integer("workspace_id").notNull(),
  version: integer("version").notNull(),
  steps: jsonb("steps").$type<unknown[]>().notNull(),
  settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
  note: text("note"),
  publishedBy: varchar("published_by"),
  publishedAt: ts("published_at").notNull().defaultNow(),
});

export const schedules = pgTable("schedules", {
  id: serial("id").primaryKey(),
  workspaceId: integer("workspace_id").notNull(),
  caseId: integer("case_id"),
  suiteId: integer("suite_id"),
  cron: text("cron").notNull(),
  timezone: text("timezone").notNull().default("UTC"),
  paused: boolean("paused").notNull().default(false),
  nextRunAt: ts("next_run_at"),
  lastRunAt: ts("last_run_at"),
  lastError: text("last_error"),
  createdBy: varchar("created_by"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const RUN_STATUSES = [
  "queued",
  "starting",
  "running",
  "cancel_requested",
  "passed",
  "failed",
  "timed_out",
  "cancelled",
  "infrastructure_error",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export const ACTIVE_STATUSES: RunStatus[] = ["queued", "starting", "running", "cancel_requested"];
export const FINAL_STATUSES: RunStatus[] = ["passed", "failed", "timed_out", "cancelled", "infrastructure_error"];
export type Trigger = "manual" | "schedule" | "api";

export const testExecutions = pgTable("test_executions", {
  id: serial("id").primaryKey(),
  workspaceId: integer("workspace_id").notNull(),
  caseId: integer("case_id").notNull(),
  caseVersion: integer("case_version"),
  environmentId: integer("environment_id"),
  status: text("status").$type<RunStatus>().notNull(),
  trigger: text("trigger").$type<Trigger>().notNull().default("manual"),
  scheduleId: integer("schedule_id"),
  batchId: text("batch_id"),
  requestedBy: varchar("requested_by"),
  idempotencyKey: text("idempotency_key"),
  queuedAt: ts("queued_at").notNull().defaultNow(),
  startTime: ts("start_time"),
  endTime: ts("end_time"),
  duration: integer("duration"),
  attempt: integer("attempt").notNull().default(1),
  maxAttempts: integer("max_attempts").notNull().default(1),
  workerId: text("worker_id"),
  leaseExpiresAt: ts("lease_expires_at"),
  heartbeatAt: ts("heartbeat_at"),
  cancelRequestedAt: ts("cancel_requested_at"),
  cancelledBy: varchar("cancelled_by"),
  errorMessage: text("error_message"),
  errorCategory: text("error_category"),
  failedStepIndex: integer("failed_step_index"),
  warnings: integer("warnings").notNull().default(0),
  createdAt: ts("created_at").defaultNow(),
});

export type StepStatus = "passed" | "failed" | "skipped" | "warning";

export const stepExecutions = pgTable("step_executions", {
  id: serial("id").primaryKey(),
  executionId: integer("execution_id").notNull(),
  stepId: integer("step_id"),
  attempt: integer("attempt").notNull().default(1),
  stepIndex: integer("step_index"),
  stepName: text("step_name"),
  action: text("action"),
  status: text("status").$type<StepStatus>().notNull(),
  duration: integer("duration"),
  errorMessage: text("error_message"),
  log: text("log"),
  startedAt: ts("started_at"),
  createdAt: ts("created_at").defaultNow(),
});

export const runEvents = pgTable("run_events", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  executionId: integer("execution_id").notNull(),
  seq: integer("seq").notNull(),
  type: text("type").notNull(),
  status: text("status"),
  stepIndex: integer("step_index"),
  attempt: integer("attempt"),
  message: text("message"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const artifacts = pgTable("artifacts", {
  id: serial("id").primaryKey(),
  workspaceId: integer("workspace_id").notNull(),
  executionId: integer("execution_id").notNull(),
  attempt: integer("attempt").notNull().default(1),
  stepIndex: integer("step_index"),
  kind: text("kind").$type<"screenshot" | "trace" | "video" | "log">().notNull(),
  storageKey: text("storage_key").notNull(),
  contentType: text("content_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  sha256: text("sha256").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
  retentionUntil: ts("retention_until"),
});

export const systemState = pgTable("system_state", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedBy: varchar("updated_by"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const workerHeartbeats = pgTable("worker_heartbeats", {
  workerId: text("worker_id").primaryKey(),
  hostname: text("hostname"),
  version: text("version"),
  startedAt: ts("started_at").notNull().defaultNow(),
  heartbeatAt: ts("heartbeat_at").notNull().defaultNow(),
  currentExecutionId: integer("current_execution_id"),
  browserOk: boolean("browser_ok"),
});

export type Channel = "email" | "sms" | "webhook";

export const notificationRules = pgTable("notification_rules", {
  id: serial("id").primaryKey(),
  workspaceId: integer("workspace_id").notNull(),
  caseId: integer("case_id"),
  suiteId: integer("suite_id"),
  channel: text("channel").$type<Channel>().notNull(),
  target: text("target").notNull(),
  onFailure: boolean("on_failure").notNull().default(true),
  onRecovery: boolean("on_recovery").notNull().default(true),
  failureThreshold: integer("failure_threshold").notNull().default(1),
  enabled: boolean("enabled").notNull().default(true),
  createdBy: varchar("created_by"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const incidents = pgTable("incidents", {
  id: serial("id").primaryKey(),
  workspaceId: integer("workspace_id").notNull(),
  caseId: integer("case_id").notNull(),
  openedAt: ts("opened_at").notNull().defaultNow(),
  resolvedAt: ts("resolved_at"),
  openedByExecutionId: integer("opened_by_execution_id"),
  resolvedByExecutionId: integer("resolved_by_execution_id"),
  consecutiveFailures: integer("consecutive_failures").notNull().default(1),
  notifiedAt: ts("notified_at"),
});

export const notificationDeliveries = pgTable("notification_deliveries", {
  id: serial("id").primaryKey(),
  workspaceId: integer("workspace_id").notNull(),
  ruleId: integer("rule_id"),
  incidentId: integer("incident_id"),
  executionId: integer("execution_id"),
  channel: text("channel").notNull(),
  targetMasked: text("target_masked").notNull(),
  kind: text("kind").$type<"failure" | "recovery" | "test" | "invite" | "password">().notNull(),
  status: text("status").$type<"pending" | "sent" | "failed" | "suppressed">().notNull(),
  error: text("error"),
  attempts: integer("attempts").notNull().default(0),
  createdAt: ts("created_at").notNull().defaultNow(),
  sentAt: ts("sent_at"),
});

export const auditEvents = pgTable("audit_events", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  workspaceId: integer("workspace_id"),
  actorUserId: varchar("actor_user_id"),
  action: text("action").notNull(),
  targetType: text("target_type"),
  targetId: text("target_id"),
  details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
  aiInvolved: boolean("ai_involved").notNull().default(false),
  requestId: text("request_id"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const aiRequests = pgTable("ai_requests", {
  id: serial("id").primaryKey(),
  workspaceId: integer("workspace_id").notNull(),
  userId: varchar("user_id"),
  kind: text("kind").$type<"case_draft" | "failure_analysis">().notNull(),
  model: text("model").notNull(),
  status: text("status").$type<"ok" | "error" | "rejected">().notNull(),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  costMicroUsd: bigint("cost_micro_usd", { mode: "number" }).notNull().default(0),
  executionId: integer("execution_id"),
  caseId: integer("case_id"),
  result: jsonb("result"),
  error: text("error"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export type User = typeof users.$inferSelect;
export type Workspace = typeof workspaces.$inferSelect;
export type Environment = typeof environments.$inferSelect;
export type TestSuite = typeof testSuites.$inferSelect;
export type TestCase = typeof testCases.$inferSelect;
export type TestStep = typeof testSteps.$inferSelect;
export type CaseVersion = typeof caseVersions.$inferSelect;
export type Schedule = typeof schedules.$inferSelect;
export type TestExecution = typeof testExecutions.$inferSelect;
export type StepExecution = typeof stepExecutions.$inferSelect;
export type Artifact = typeof artifacts.$inferSelect;
export type NotificationRule = typeof notificationRules.$inferSelect;
