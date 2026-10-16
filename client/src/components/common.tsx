// Small shared pieces used across pages.
import { useEffect, useState, type ReactNode } from "react";
import { AlertTriangle, Ban, CheckCircle2, CircleDashed, CircleSlash, Clock, Loader2, OctagonX, ServerCrash, TriangleAlert, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { ago } from "@/lib/format";
import { ApiError } from "@/lib/api";
import type { RunStatus, StepStatus } from "@/lib/types";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const STATUS: Record<RunStatus | StepStatus, { label: string; className: string; icon: typeof CheckCircle2; spin?: boolean }> = {
  passed: { label: "Passed", className: "bg-success-soft text-success", icon: CheckCircle2 },
  failed: { label: "Failed", className: "bg-danger-soft text-danger", icon: XCircle },
  timed_out: { label: "Timed out", className: "bg-danger-soft text-danger", icon: Clock },
  infrastructure_error: { label: "Infra error", className: "bg-warning-soft text-warning", icon: ServerCrash },
  cancelled: { label: "Cancelled", className: "bg-neutral-soft text-muted-foreground", icon: Ban },
  cancel_requested: { label: "Stopping", className: "bg-neutral-soft text-muted-foreground", icon: Loader2, spin: true },
  queued: { label: "Queued", className: "bg-neutral-soft text-muted-foreground", icon: CircleDashed },
  starting: { label: "Starting", className: "bg-info-soft text-info", icon: Loader2, spin: true },
  running: { label: "Running", className: "bg-info-soft text-info", icon: Loader2, spin: true },
  warning: { label: "Warning", className: "bg-warning-soft text-warning", icon: TriangleAlert },
  skipped: { label: "Skipped", className: "bg-neutral-soft text-subtle", icon: CircleSlash },
};

export function StatusBadge({ status, className, compact }: { status: RunStatus | StepStatus; className?: string; compact?: boolean }) {
  const s = STATUS[status] ?? STATUS.queued;
  const Icon = s.icon;
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium", s.className, className)}>
      <Icon className={cn("h-3.5 w-3.5", s.spin && "animate-spin")} aria-hidden />
      {compact ? <span className="sr-only">{s.label}</span> : s.label}
    </span>
  );
}

export function StatusDot({ status }: { status: RunStatus | null | undefined }) {
  const color = !status
    ? "bg-border-strong"
    : status === "passed"
      ? "bg-success"
      : ["failed", "timed_out"].includes(status)
        ? "bg-danger"
        : status === "infrastructure_error"
          ? "bg-warning"
          : ["running", "starting"].includes(status)
            ? "bg-info animate-pulse-dot"
            : "bg-border-strong";
  return <span aria-hidden className={cn("inline-block h-2 w-2 shrink-0 rounded-full", color)} />;
}

export function PageHeader({ title, description, actions, eyebrow }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; eyebrow?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        {eyebrow && <div className="eyebrow mb-1.5">{eyebrow}</div>}
        <h1 className="text-[22px] font-semibold leading-tight tracking-[-0.01em]">{title}</h1>
        {description && <p className="mt-1.5 max-w-[68ch] text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function EmptyState({ icon: Icon, title, children, action }: { icon?: typeof CheckCircle2; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed px-6 py-14 text-center">
      {Icon && (
        <div className="mb-4 grid h-10 w-10 place-items-center rounded-full bg-muted text-muted-foreground">
          <Icon className="h-5 w-5" aria-hidden />
        </div>
      )}
      <h3 className="text-[15px] font-medium">{title}</h3>
      {children && <div className="mt-1.5 max-w-[46ch] text-sm text-muted-foreground">{children}</div>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  const msg = error instanceof Error ? error.message : "Something went wrong.";
  const requestId = error instanceof ApiError ? error.requestId : undefined;
  return (
    <div role="alert" className="flex items-start gap-3 rounded-lg border border-danger/25 bg-danger-soft p-4 text-sm">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-danger" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-foreground">{msg}</p>
        {requestId && <p className="mt-1 text-xs text-muted-foreground">Reference: <code className="select-all">{requestId}</code></p>}
      </div>
      {retry && (
        <Button size="sm" variant="outline" onClick={retry}>
          Try again
        </Button>
      )}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn("animate-pulse rounded-md bg-muted", className)} />;
}

export function TableSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="surface divide-y" aria-busy aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-4 px-4 py-3.5">
          <Skeleton className="h-4 w-4 rounded-full" />
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 w-16" />
        </div>
      ))}
    </div>
  );
}

/** Relative time that stays current, with the exact time on hover. */
export function TimeAgo({ iso, exact }: { iso: string | null | undefined; exact?: string }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  if (!iso) return <span className="text-subtle">never</span>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <time dateTime={iso} className="whitespace-nowrap">
          {ago(iso)}
        </time>
      </TooltipTrigger>
      <TooltipContent>{exact ?? new Date(iso).toLocaleString()}</TooltipContent>
    </Tooltip>
  );
}

export function Confirm({
  trigger,
  title,
  description,
  confirmLabel,
  destructive,
  onConfirm,
}: {
  trigger: ReactNode;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: () => void | Promise<unknown>;
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div>{description}</div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction className={cn(destructive && "bg-destructive text-destructive-foreground hover:bg-destructive/90")} onClick={() => void onConfirm()}>
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function Field({ label, hint, error, children, htmlFor, optional }: { label: string; hint?: ReactNode; error?: string | null; children: ReactNode; htmlFor?: string; optional?: boolean }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="flex items-baseline gap-1.5 text-[13px] font-medium">
        {label}
        {optional && <span className="font-normal text-subtle">optional</span>}
      </label>
      {children}
      {error ? <p className="text-xs text-danger">{error}</p> : hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">{children}</kbd>;
}

export function Notice({ tone = "info", title, children, action }: { tone?: "info" | "warning" | "danger" | "success"; title?: ReactNode; children?: ReactNode; action?: ReactNode }) {
  const styles = {
    info: "border-info/25 bg-info-soft",
    warning: "border-warning/30 bg-warning-soft",
    danger: "border-danger/25 bg-danger-soft",
    success: "border-success/25 bg-success-soft",
  }[tone];
  const Icon = tone === "danger" ? OctagonX : tone === "success" ? CheckCircle2 : AlertTriangle;
  const iconColor = { info: "text-info", warning: "text-warning", danger: "text-danger", success: "text-success" }[tone];
  return (
    <div className={cn("flex items-start gap-3 rounded-lg border p-3.5 text-sm", styles)}>
      <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", iconColor)} aria-hidden />
      <div className="min-w-0 flex-1">
        {title && <p className="font-medium">{title}</p>}
        {children && <div className={cn("text-muted-foreground", title && "mt-0.5")}>{children}</div>}
      </div>
      {action}
    </div>
  );
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: "danger" | "success" | "warning" }) {
  return (
    <div className="surface p-4">
      <div className="eyebrow">{label}</div>
      <div className={cn("tabular mt-2 text-[26px] font-semibold leading-none tracking-tight", tone === "danger" && "text-danger", tone === "success" && "text-success", tone === "warning" && "text-warning")}>{value}</div>
      {sub && <div className="mt-2 text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}
