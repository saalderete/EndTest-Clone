import { useEffect, useState } from "react";
import { Link } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, CalendarClock, Pause, Pencil, Play, Plus, Trash2 } from "lucide-react";
import { useWorkspace } from "@/hooks/session";
import { useUrlState } from "@/hooks/url-state";
import { del, errorMessage, get, patch, post, queryClient } from "@/lib/api";
import type { CaseSummary, Schedule, Suite } from "@/lib/types";
import { COMMON_TIMEZONES, dateTime, describeCron, tzLabel } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Confirm, EmptyState, ErrorState, Field, Notice, PageHeader, TableSkeleton, TimeAgo } from "@/components/common";
import { Segmented } from "@/components/segmented";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";

const PRESETS = [
  { label: "Every 15 min", cron: "*/15 * * * *" },
  { label: "Every 30 min", cron: "*/30 * * * *" },
  { label: "Hourly", cron: "0 * * * *" },
  { label: "Daily 7:00", cron: "0 7 * * *" },
  { label: "Weekdays 7:00", cron: "0 7 * * 1-5" },
];

function useDebounced<T>(v: T, ms: number) {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}

function ScheduleDialog({ open, onOpenChange, editing, initialCaseId }: { open: boolean; onOpenChange: (v: boolean) => void; editing?: Schedule; initialCaseId?: string }) {
  const ws = useWorkspace();
  const cases = useQuery<CaseSummary[]>({ queryKey: [ws.base, "cases"], enabled: open });
  const suites = useQuery<Suite[]>({ queryKey: [ws.base, "suites"], enabled: open });
  const [target, setTarget] = useState<"case" | "suite">(editing?.suiteId ? "suite" : "case");
  const [caseId, setCaseId] = useState(editing?.caseId ? String(editing.caseId) : initialCaseId ?? "");
  const [suiteId, setSuiteId] = useState(editing?.suiteId ? String(editing.suiteId) : "");
  const [cron, setCron] = useState(editing?.cron ?? "*/30 * * * *");
  const [tz, setTz] = useState(editing?.timezone ?? ws.timezone);
  const [paused, setPaused] = useState(editing?.paused ?? false);
  const dCron = useDebounced(cron, 300);
  const preview = useQuery({
    queryKey: ["cron-preview", dCron, tz],
    queryFn: () => get<{ valid: boolean; next?: string[]; error?: string }>(`${ws.base}/schedules/preview?cron=${encodeURIComponent(dCron)}&timezone=${encodeURIComponent(tz)}`),
    enabled: open && !!dCron.trim(),
  });
  const chosen = cases.data?.find((c) => String(c.id) === caseId);
  const m = useMutation({
    mutationFn: () =>
      editing
        ? patch(`${ws.base}/schedules/${editing.id}`, { cron, timezone: tz, paused })
        : post(`${ws.base}/schedules`, { ...(target === "case" ? { caseId: Number(caseId) } : { suiteId: Number(suiteId) }), cron, timezone: tz, paused }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [ws.base] });
      onOpenChange(false);
    },
  });
  const zones = COMMON_TIMEZONES.includes(tz) ? COMMON_TIMEZONES : [tz, ...COMMON_TIMEZONES];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit schedule" : "New schedule"}</DialogTitle>
          <DialogDescription>Scheduled runs use the test's published version. Missed times while the runner is offline are skipped, not run late.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {m.error && <Notice tone="danger">{errorMessage(m.error)}</Notice>}
          {!editing && (
            <>
              <Segmented label="Schedule" value={target} onChange={setTarget} options={[{ value: "case", label: "One test" }, { value: "suite", label: "A whole suite" }]} />
              {target === "case" ? (
                <Field label="Test">
                  <Select value={caseId} onValueChange={setCaseId}>
                    <SelectTrigger>
                      <SelectValue placeholder="Choose a test" />
                    </SelectTrigger>
                    <SelectContent>
                      {cases.data?.map((c) => (
                        <SelectItem key={c.id} value={String(c.id)} disabled={!c.publishedVersion}>
                          {c.name} {!c.publishedVersion ? "(not published)" : c.needsReview ? "(needs review)" : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              ) : (
                <Field label="Suite" hint="Every published, active test in the suite runs at each time.">
                  <Select value={suiteId} onValueChange={setSuiteId}>
                    <SelectTrigger>
                      <SelectValue placeholder="Choose a suite" />
                    </SelectTrigger>
                    <SelectContent>
                      {suites.data?.map((s) => (
                        <SelectItem key={s.id} value={String(s.id)}>
                          {s.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              )}
              {chosen?.needsReview && !paused && <Notice tone="warning">This test needs review before it can run on a schedule. Create it paused, or mark the test reviewed first.</Notice>}
            </>
          )}
          <div>
            <div className="mb-2 text-[13px] font-medium">How often</div>
            <div className="flex flex-wrap gap-1.5">
              {PRESETS.map((p) => (
                <button
                  key={p.cron}
                  onClick={() => setCron(p.cron)}
                  className={cn("rounded-full border px-3 py-1 text-[13px] transition-colors", cron === p.cron ? "border-primary bg-primary text-primary-foreground" : "bg-surface text-muted-foreground hover:text-foreground")}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Cron expression" htmlFor="cron" hint="minute hour day month weekday" error={preview.data && !preview.data.valid ? preview.data.error : null}>
              <Input id="cron" className="font-mono" value={cron} onChange={(e) => setCron(e.target.value)} autoCapitalize="none" autoCorrect="off" spellCheck={false} />
            </Field>
            <Field label="Timezone">
              <Select value={tz} onValueChange={setTz}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {zones.map((z) => (
                    <SelectItem key={z} value={z}>
                      {z}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
          <div className="rounded-lg border bg-surface-2 p-3.5">
            <div className="eyebrow mb-2">Next 5 runs ({tzLabel(tz)})</div>
            {preview.data?.valid ? (
              <ol className="space-y-1 text-sm tabular">
                {preview.data.next!.map((t) => (
                  <li key={t} className="flex justify-between">
                    <span>{dateTime(t, tz, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
                    <span className="text-muted-foreground">
                      <TimeAgo iso={t} />
                    </span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-sm text-muted-foreground">{preview.isFetching ? "Checking…" : "Enter a valid expression to see upcoming times."}</p>
            )}
          </div>
          <label className="flex items-center gap-3">
            <Switch checked={paused} onCheckedChange={setPaused} />
            <span className="text-sm">Start paused</span>
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => m.mutate()} disabled={m.isPending || !preview.data?.valid || (!editing && (target === "case" ? !caseId : !suiteId))}>
            {editing ? "Save" : "Create schedule"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function SchedulesPage() {
  const ws = useWorkspace();
  const { toast } = useToast();
  const [q, setQ] = useUrlState({ caseId: "" });
  const [dialog, setDialog] = useState<{ editing?: Schedule } | null>(q.caseId ? {} : null);
  const list = useQuery<Schedule[]>({ queryKey: [ws.base, "schedules"], refetchInterval: 30_000 });
  const toggle = useMutation({
    mutationFn: (s: Schedule) => patch(`${ws.base}/schedules/${s.id}`, { paused: !s.paused }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: [ws.base] }),
    onError: (e) => toast({ title: "Couldn't change the schedule", description: errorMessage(e), variant: "destructive" }),
  });
  const remove = useMutation({ mutationFn: (id: number) => del(`${ws.base}/schedules/${id}`), onSuccess: () => void queryClient.invalidateQueries({ queryKey: [ws.base] }) });
  const pauseAll = useMutation({
    mutationFn: () => post<{ paused: number }>(`${ws.base}/schedules/pause-all`, {}),
    onSuccess: (r) => {
      void queryClient.invalidateQueries({ queryKey: [ws.base] });
      toast({ title: `${r.paused} schedules paused` });
    },
  });
  const activeCount = list.data?.filter((s) => !s.paused).length ?? 0;
  return (
    <>
      <PageHeader
        title="Schedules"
        description={`Recurring runs. Each schedule shows times in its own timezone; the workspace default is ${ws.timezone}.`}
        actions={
          <>
            {ws.can("admin") && activeCount > 0 && (
              <Confirm
                trigger={<Button variant="outline"><Pause className="mr-2 h-4 w-4" /> Pause all</Button>}
                title="Pause every schedule in this workspace?"
                description="Nothing runs on a schedule until you resume each one. Runs already in progress finish."
                confirmLabel={`Pause ${activeCount}`}
                onConfirm={() => pauseAll.mutateAsync()}
              />
            )}
            {ws.can("editor") && (
              <Button onClick={() => setDialog({})}>
                <Plus className="mr-2 h-4 w-4" /> New schedule
              </Button>
            )}
          </>
        }
      />
      {list.error ? (
        <ErrorState error={list.error} retry={() => void list.refetch()} />
      ) : list.isLoading ? (
        <TableSkeleton />
      ) : !list.data?.length ? (
        <EmptyState icon={CalendarClock} title="No schedules yet" action={ws.can("editor") ? <Button onClick={() => setDialog({})}>New schedule</Button> : undefined}>
          Run a critical workflow every 30 minutes, or a whole suite every morning.
        </EmptyState>
      ) : (
        <ul className="surface divide-y">
          {list.data.map((s) => (
            <li key={s.id} className={cn("flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center", s.paused && "bg-muted/30")}>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  {s.caseId ? (
                    <Link href={`/tests/${s.caseId}`} className="truncate font-medium hover:underline">
                      {s.caseName}
                    </Link>
                  ) : (
                    <span className="truncate font-medium">Suite: {s.suiteName}</span>
                  )}
                  {s.paused ? <span className="rounded bg-neutral-soft px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">Paused</span> : <span className="rounded bg-success-soft px-1.5 py-0.5 text-[11px] font-medium text-success">Active</span>}
                  {s.needsReview && <span className="rounded bg-warning-soft px-1.5 py-0.5 text-[11px] font-medium text-warning">Test needs review</span>}
                </div>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  {describeCron(s.cron)} <code className="ml-1 text-xs text-subtle">{s.cron}</code> · {s.timezone}
                </p>
                {s.lastError && (
                  <p className="mt-1 flex items-start gap-1.5 text-xs text-warning">
                    <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden /> {s.lastError}
                  </p>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-6 text-sm">
                <div className="text-right">
                  <div className="eyebrow">Next</div>
                  <div className="tabular">{s.paused || !s.nextRunAt ? "—" : <TimeAgo iso={s.nextRunAt} exact={dateTime(s.nextRunAt, s.timezone)} />}</div>
                </div>
                <div className="text-right">
                  <div className="eyebrow">Last</div>
                  <div className="tabular text-muted-foreground">{s.lastRunAt ? <TimeAgo iso={s.lastRunAt} exact={dateTime(s.lastRunAt, s.timezone)} /> : "—"}</div>
                </div>
                {ws.can("editor") && (
                  <div className="flex items-center gap-1">
                    <Button variant="outline" size="sm" onClick={() => toggle.mutate(s)} disabled={toggle.isPending}>
                      {s.paused ? (
                        <>
                          <Play className="mr-1.5 h-3.5 w-3.5" /> Resume
                        </>
                      ) : (
                        <>
                          <Pause className="mr-1.5 h-3.5 w-3.5" /> Pause
                        </>
                      )}
                    </Button>
                    <Button variant="ghost" size="icon" aria-label="Edit schedule" onClick={() => setDialog({ editing: s })}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Confirm
                      trigger={
                        <Button variant="ghost" size="icon" aria-label="Delete schedule">
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      }
                      title="Delete this schedule?"
                      description="Past runs are kept. Pausing is usually enough."
                      confirmLabel="Delete schedule"
                      destructive
                      onConfirm={() => remove.mutateAsync(s.id)}
                    />
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {dialog && (
        <ScheduleDialog
          open
          editing={dialog.editing}
          initialCaseId={q.caseId}
          onOpenChange={(v) => {
            if (!v) {
              setDialog(null);
              if (q.caseId) setQ({ caseId: "" });
            }
          }}
        />
      )}
    </>
  );
}
