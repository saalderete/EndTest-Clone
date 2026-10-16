// Shapes of the API responses the UI uses.
import type { Step } from "@shared/steps";

export type Role = "owner" | "admin" | "editor" | "runner" | "viewer";
export type RunStatus = "queued" | "starting" | "running" | "cancel_requested" | "passed" | "failed" | "timed_out" | "cancelled" | "infrastructure_error";
export type StepStatus = "passed" | "failed" | "skipped" | "warning";

export type Me = {
  user: { id: string; email: string; firstName: string | null; lastName: string | null; isSystemAdmin: boolean; name: string } | null;
  workspaces: WorkspaceSummary[];
  signupEnabled: boolean;
};
export type WorkspaceSummary = { id: number; name: string; slug: string; timezone: string; isDemo: boolean; role: Role };
export type Workspace = WorkspaceSummary & { aiEnabled: boolean; aiMonthlyBudgetCents: number; createdAt: string };

export type Environment = { id: number; name: string; baseUrl: string; allowedHosts: string[]; createdAt: string; updatedAt: string };
export type Secret = { id: number; name: string; description: string | null; createdAt: string; rotatedAt: string; usedByTests: number };

export type Suite = {
  id: number;
  name: string;
  description: string | null;
  environmentId: number | null;
  environmentName: string | null;
  tags: string[];
  caseCount: number;
  lastRunAt: string | null;
  passed7d: number;
  finished7d: number;
};

export type CaseSummary = {
  id: number;
  name: string;
  description: string | null;
  suiteId: number;
  suiteName: string;
  environmentId: number | null;
  priority: "critical" | "high" | "normal" | "low";
  tags: string[];
  isActive: boolean;
  publishedVersion: number | null;
  needsReview: boolean;
  stepCount: number;
  lastRun: { id: number; status: RunStatus; createdAt: string; duration: number | null } | null;
  schedule: { id: number; cron: string; timezone: string; paused: boolean; nextRunAt: string | null } | null;
  updatedAt: string;
};

export type Schedule = {
  id: number;
  caseId: number | null;
  suiteId: number | null;
  caseName: string | null;
  suiteName: string | null;
  cron: string;
  timezone: string;
  paused: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastError: string | null;
  needsReview: boolean;
};

export type CaseDetail = CaseSummary & {
  maxRetries: number;
  timeoutMs: number;
  stepTimeoutMs: number;
  overlapPolicy: "skip" | "queue" | "cancel_previous";
  reviewNote: string | null;
  draftUpdatedAt: string | null;
  effectiveEnvironmentId: number | null;
  steps: Step[];
  published: { version: number; publishedAt: string; publishedBy: string | null; note: string | null } | null;
  hasUnpublishedChanges: boolean;
  schedules: Schedule[];
  notificationRuleCount: number;
  missingSecrets: string[];
  scriptStepsAllowed: boolean;
};

export type RunSummary = {
  id: number;
  caseId: number;
  caseName: string;
  suiteId: number;
  suiteName: string;
  status: RunStatus;
  trigger: "manual" | "schedule" | "api";
  caseVersion: number | null;
  attempt: number;
  maxAttempts: number;
  queuedAt: string;
  startTime: string | null;
  endTime: string | null;
  duration: number | null;
  errorMessage: string | null;
  errorCategory: string | null;
  failedStepIndex: number | null;
  warnings: number;
  createdAt: string;
  requestedBy: string | null;
};

export type StepResult = {
  id: number;
  attempt: number;
  stepIndex: number | null;
  stepName: string | null;
  action: string | null;
  status: StepStatus;
  duration: number | null;
  errorMessage: string | null;
  log: string | null;
  startedAt: string | null;
};

export type ArtifactMeta = { id: number; kind: "screenshot" | "trace" | "video" | "log"; attempt: number; stepIndex: number | null; contentType: string; sizeBytes: number; createdAt: string };

export type RunDetail = Omit<RunSummary, "requestedBy"> & {
  workspaceId: number;
  priority: string;
  environment: { name: string; baseUrl: string } | null;
  requestedByEmail: string | null;
  plannedSteps: { name: string; action: string; enabled: boolean }[] | null;
  steps: StepResult[];
  artifacts: ArtifactMeta[];
  previousPass: { id: number; createdAt: string } | null;
  cancelRequestedAt: string | null;
};

export type RunEvent = { seq: number; type: string; status: string | null; stepIndex: number | null; attempt: number | null; message: string | null; createdAt: string };

export type Overview = {
  range: string;
  generatedAt: string;
  totals: {
    passed: number;
    failed: number;
    timed_out: number;
    infrastructure_error: number;
    cancelled: number;
    passed_on_retry: number;
    warnings_on_passes: number;
    mean_ms: number | null;
    p50_ms: number | null;
    p95_ms: number | null;
    judged: number;
    passRate: number | null;
  };
  active: { queued: number; running: number };
  trend: { t: string; passed: number; failed: number; infra: number }[];
  openIncidents: { id: number; caseId: number; caseName: string; priority: string; openedAt: string; consecutiveFailures: number }[];
  schedules: { active: number; paused: number; next_at: string | null };
};

export type CaseStats = {
  caseId: number;
  name: string;
  priority: string;
  suiteId: number;
  suiteName: string;
  needsReview: boolean;
  runs: number;
  passed: number;
  failed: number;
  infra: number;
  passedOnRetry: number;
  warnings: number;
  p50Ms: number | null;
  p95Ms: number | null;
  passRate: number | null;
  consecutiveFailures: number;
  flips: number | null;
  flipWindow: number | null;
  flakiness: number | null;
  lastPassAt: string | null;
  lastStatus: RunStatus | null;
  lastRunAt: string | null;
  owner: string | null;
};

export type Member = { id: string; email: string; firstName: string | null; lastName: string | null; role: Role; joinedAt: string; lastLoginAt: string | null; canSignIn: boolean };
export type Invitation = { id: number; email: string; role: Role; expiresAt: string; createdAt: string };

export type NotificationRule = {
  id: number;
  caseId: number | null;
  suiteId: number | null;
  caseName: string | null;
  suiteName: string | null;
  channel: "email" | "sms" | "webhook";
  target: string;
  onFailure: boolean;
  onRecovery: boolean;
  failureThreshold: number;
  enabled: boolean;
};
export type Delivery = { id: number; channel: string; targetMasked: string; kind: string; status: "pending" | "sent" | "failed" | "suppressed"; error: string | null; createdAt: string; caseName: string | null; executionId: number | null };
export type Incident = { id: number; caseId: number; caseName: string; priority: string; openedAt: string; resolvedAt: string | null; consecutiveFailures: number; notifiedAt: string | null };

export type Checks = {
  workerOnline: boolean;
  browserOk: boolean;
  notifications: { enabled: boolean; email: boolean; sms: boolean; webhook: boolean };
  hasEnvironment: boolean;
  hasSuite: boolean;
  hasPublishedTest: boolean;
  aiAvailable: boolean;
};
