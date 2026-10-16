import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useLocation } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowLeft, ChevronDown, Download, FileArchive, Image as ImageIcon, Loader2, RotateCcw, Square } from "lucide-react";
import { ACTIONS } from "@shared/steps";
import { useWorkspace } from "@/hooks/session";
import { errorMessage, post, queryClient } from "@/lib/api";
import type { ArtifactMeta, RunDetail, StepResult } from "@/lib/types";
import { bytes, dateTime, duration } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Confirm, ErrorState, Notice, Skeleton, StatusBadge, TimeAgo } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { FailureAnalysis } from "@/components/ai";

const ACTIVE = ["queued", "starting", "running", "cancel_requested"];

const CATEGORY: Record<string, { title: string; body: string }> = {
  assertion: { title: "A check failed", body: "The page didn't show what the test expected. Either the application changed, or this is a regression." },
  element_not_found: { title: "An element couldn't be found", body: "Usually the page's layout or wording changed and the step's element locator needs updating." },
  navigation: { title: "A page couldn't be opened", body: "The browser got a network or server error opening the page." },
  timeout: { title: "Something took too long", body: "A step or the whole test went over its time limit. The app may be slow, or the test may be waiting for something that never happens." },
  configuration: { title: "The test isn't set up correctly", body: "A secret, URL or environment setting is missing or invalid." },
  policy: { title: "Blocked by the environment's rules", body: "The test tried to reach a host outside the environment's allowed hosts, or a private network address." },
  infrastructure: { title: "The runner had a problem", body: "A browser crash or worker restart, not a problem with the application. It isn't counted in pass rates." },
  cancelled: { title: "Cancelled", body: "Someone stopped this run, or it was replaced by a newer scheduled run." },
};

/** Live updates: refetch the run whenever the server reports progress. */
function useLiveRun(base: string, runId: number, active: boolean) {
  const [lastEvent, setLastEvent] = useState<string | null>(null);
  useEffect(() => {
    if (!active) return;
    const es = new EventSource(`${base}/runs/${runId}/events`, { withCredentials: true });
    let pending: ReturnType<typeof setTimeout> | null = null;
    const refresh = () => {
      if (pending) return;
      pending = setTimeout(() => {
        pending = null;
        void queryClient.invalidateQueries({ queryKey: [base, `runs/${runId}`] });
      }, 250);
    };
    const onEvent = (e: MessageEvent) => {
      try {
        const d = JSON.parse(e.data);
        if (d.message) setLastEvent(d.message);
      } catch {
        // keep-alive
      }
      refresh();
    };
    for (const t of ["status", "step_started", "step_finished", "artifact", "attempt", "requeued"]) es.addEventListener(t, onEvent);
    es.addEventListener("end", () => {
      refresh();
      es.close();
    });
    return () => {
      if (pending) clearTimeout(pending);
      es.close();
    };
  }, [base, runId, active]);
  return lastEvent;
}

function Lightbox({ items, index, onClose, base }: { items: ArtifactMeta[]; index: number | null; onClose: () => void; base: string }) {
  const [i, setI] = useState(index ?? 0);
  useEffect(() => setI(index ?? 0), [index]);
  const a = index !== null ? items[i] : null;
  return (
    <Dialog open={index !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-[min(1200px,95vw)] p-2" onKeyDown={(e) => {
        if (e.key === "ArrowRight") setI((x) => Math.min(items.length - 1, x + 1));
        if (e.key === "ArrowLeft") setI((x) => Math.max(0, x - 1));
      }}>
        <DialogTitle className="sr-only">Screenshot</DialogTitle>
        {a && (
          <>
            <div className="max-h-[80vh] overflow-auto rounded-md bg-muted">
              <img src={`${base}/artifacts/${a.id}`} alt={a.stepIndex ? `Screenshot at step ${a.stepIndex}` : "Final screenshot"} className="w-full" />
            </div>
            <div className="flex items-center justify-between px-2 pb-1 pt-2 text-xs text-muted-foreground">
              <span>
                {a.stepIndex ? `Step ${a.stepIndex}` : "End of run"} · attempt {a.attempt} · {bytes(a.sizeBytes)} · {i + 1} of {items.length} (← →)
              </span>
              <a href={`${base}/artifacts/${a.id}?download=1`} className="flex items-center gap-1 hover:text-foreground">
                <Download className="h-3.5 w-3.5" /> Download
              </a>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function StepRow({ s, shots, onOpen, base, defaultOpen }: { s: StepResult; shots: ArtifactMeta[]; onOpen: (a: ArtifactMeta) => void; base: string; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const expandable = !!(s.errorMessage || s.log || shots.length);
  return (
    <li className={cn("rounded-lg border bg-surface", s.status === "failed" && "border-danger/40", s.status === "warning" && "border-warning/40")}>
      <button
        className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left disabled:cursor-default"
        onClick={() => expandable && setOpen((o) => !o)}
        disabled={!expandable}
        aria-expanded={expandable ? open : undefined}
      >
        <span className="tabular w-6 shrink-0 text-right text-xs text-subtle">{s.stepIndex}</span>
        <StatusBadge status={s.status} compact />
        <span className="min-w-0 flex-1">
          <span className={cn("block truncate text-sm", s.status === "skipped" ? "text-subtle" : "font-medium")}>{s.stepName}</span>
          <span className="block truncate text-xs text-muted-foreground">{ACTIONS[s.action as keyof typeof ACTIONS]?.label ?? s.action}</span>
        </span>
        {shots.length > 0 && <ImageIcon className="h-3.5 w-3.5 text-subtle" aria-label="Has screenshots" />}
        <span className="tabular w-16 shrink-0 text-right text-xs text-muted-foreground">{duration(s.duration)}</span>
        {expandable && <ChevronDown className={cn("h-4 w-4 shrink-0 text-subtle transition-transform duration-200", open && "rotate-180")} aria-hidden />}
      </button>
      {open && expandable && (
        <div className="space-y-3 border-t px-3.5 py-3">
          {s.errorMessage && <p className={cn("text-sm", s.status === "warning" ? "text-warning" : "text-danger")}>{s.errorMessage}</p>}
          {s.log && <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-muted/60 p-2.5 text-xs text-muted-foreground">{s.log}</pre>}
          {shots.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {shots.map((a) => (
                <button key={a.id} onClick={() => onOpen(a)} className="overflow-hidden rounded-md border transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <img src={`${base}/artifacts/${a.id}`} alt={`Screenshot at step ${s.stepIndex}`} className="h-28 w-44 object-cover object-top" loading="lazy" />
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

export default function RunDetailPage() {
  const ws = useWorkspace();
  const { runId } = useParams<{ runId: string }>();
  const id = Number(runId);
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const q = useQuery<RunDetail>({ queryKey: [ws.base, `runs/${id}`], refetchInterval: (query) => (query.state.data && ACTIVE.includes(query.state.data.status) ? 4000 : false) });
  const run = q.data;
  const active = !!run && ACTIVE.includes(run.status);
  const lastEvent = useLiveRun(ws.base, id, active);
  const [attempt, setAttempt] = useState<number | null>(null);
  const [lightbox, setLightbox] = useState<number | null>(null);
  const shownAttempt = attempt ?? run?.attempt ?? 1;
  const topRef = useRef<HTMLDivElement>(null);

  const cancel = useMutation({
    mutationFn: () => post(`${ws.base}/runs/${id}/cancel`, {}),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: [ws.base, `runs/${id}`] }),
    onError: (e) => toast({ title: "Couldn't cancel", description: errorMessage(e), variant: "destructive" }),
  });
  const rerun = useMutation({
    mutationFn: () => post<{ runId: number }>(`${ws.base}/runs/${id}/rerun`, {}),
    onSuccess: (r) => navigate(`/runs/${r.runId}`),
    onError: (e) => toast({ title: "Couldn't start the run", description: errorMessage(e), variant: "destructive" }),
  });

  const steps = useMemo(() => run?.steps.filter((s) => s.attempt === shownAttempt) ?? [], [run, shownAttempt]);
  const shots = useMemo(() => run?.artifacts.filter((a) => a.kind === "screenshot" && a.attempt === shownAttempt) ?? [], [run, shownAttempt]);
  const traces = run?.artifacts.filter((a) => a.kind === "trace") ?? [];

  if (q.error) return <ErrorState error={q.error} retry={() => void q.refetch()} />;
  if (!run) return <Skeleton className="h-[60vh]" />;

  const planned = run.plannedSteps?.length ?? 0;
  const done = steps.length;
  const failed = ["failed", "timed_out", "infrastructure_error"].includes(run.status);
  const cat = run.errorCategory ? CATEGORY[run.errorCategory] : null;
  const attempts = Array.from({ length: run.attempt }, (_, i) => i + 1);
  const pendingSteps = active && run.plannedSteps ? run.plannedSteps.slice(done) : [];

  return (
    <div ref={topRef}>
      <Link href="/runs" className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> Runs
      </Link>
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <StatusBadge status={run.status} className="text-[13px]" />
            <h1 className="truncate text-[22px] font-semibold tracking-[-0.01em]">{run.caseName}</h1>
          </div>
          <p className="mt-1.5 text-sm text-muted-foreground">
            Run #{run.id} · {run.suiteName} · version {run.caseVersion ?? "—"} · {run.environment ? `${run.environment.name} (${run.environment.baseUrl})` : "no environment"} ·{" "}
            {run.trigger === "manual" ? `started by ${run.requestedByEmail ?? "someone"}` : run.trigger === "schedule" ? "scheduled" : "via API"}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button variant="outline" size="sm" asChild>
            <Link href={`/tests/${run.caseId}`}>Open test</Link>
          </Button>
          {ws.can("runner") && active && run.status !== "cancel_requested" && (
            <Confirm
              trigger={
                <Button variant="outline" size="sm">
                  <Square className="mr-1.5 h-3.5 w-3.5" /> Cancel
                </Button>
              }
              title="Cancel this run?"
              description="The browser stops at the next step. Results so far are kept."
              confirmLabel="Cancel run"
              destructive
              onConfirm={() => cancel.mutateAsync()}
            />
          )}
          {ws.can("runner") && !active && (
            <Button size="sm" onClick={() => rerun.mutate()} disabled={rerun.isPending}>
              <RotateCcw className="mr-1.5 h-4 w-4" /> Run again
            </Button>
          )}
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-5">
          {active && (
            <div className="surface p-4" aria-live="polite">
              <div className="flex items-center gap-2 text-sm">
                <Loader2 className="h-4 w-4 animate-spin text-info" aria-hidden />
                <span className="font-medium">{run.status === "queued" ? "Waiting for a runner…" : run.status === "cancel_requested" ? "Stopping…" : `Running step ${Math.min(done + 1, planned || done + 1)}${planned ? ` of ${planned}` : ""}`}</span>
                {lastEvent && <span className="truncate text-muted-foreground">· {lastEvent}</span>}
              </div>
              {planned > 0 && (
                <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full bg-info transition-[width] duration-500 ease-out" style={{ width: `${Math.round((done / planned) * 100)}%` }} />
                </div>
              )}
            </div>
          )}

          {failed && (
            <div className="rounded-lg border border-danger/25 bg-danger-soft p-4">
              <p className="font-medium">{cat?.title ?? "The run failed"}</p>
              {run.errorMessage && <p className="mt-1 break-words font-mono text-[13px] text-danger">{run.errorMessage}</p>}
              {cat && <p className="mt-2 text-sm text-muted-foreground">{cat.body}</p>}
              <p className="mt-2 text-xs text-muted-foreground">
                {run.previousPass ? (
                  <>
                    Last passed <Link href={`/runs/${run.previousPass.id}`} className="underline underline-offset-2">run #{run.previousPass.id}</Link>, <TimeAgo iso={run.previousPass.createdAt} exact={dateTime(run.previousPass.createdAt, ws.timezone)} />.
                  </>
                ) : (
                  "No earlier passing run."
                )}
              </p>
            </div>
          )}
          {run.status === "passed" && run.warnings > 0 && (
            <Notice tone="warning" title={`Passed with ${run.warnings} warning${run.warnings > 1 ? "s" : ""}`}>
              Some soft checks didn't find what they were looking for. Open the steps marked Warning below.
            </Notice>
          )}
          {failed && <FailureAnalysis runId={run.id} />}

          {attempts.length > 1 && (
            <div className="flex items-center gap-2 text-sm" role="tablist" aria-label="Attempts">
              {attempts.map((a) => (
                <button
                  key={a}
                  role="tab"
                  aria-selected={shownAttempt === a}
                  onClick={() => setAttempt(a)}
                  className={cn("rounded-md border px-3 py-1.5 transition-colors", shownAttempt === a ? "border-primary bg-primary text-primary-foreground" : "bg-surface text-muted-foreground hover:text-foreground")}
                >
                  Attempt {a}
                </button>
              ))}
              <span className="text-xs text-muted-foreground">Every attempt is kept; the last one decides the result.</span>
            </div>
          )}

          <section aria-labelledby="steps-h">
            <h2 id="steps-h" className="mb-3 text-[15px] font-medium">
              Steps
            </h2>
            <ol className="space-y-2">
              {steps.map((s) => (
                <StepRow
                  key={s.id}
                  s={s}
                  base={ws.base}
                  shots={shots.filter((a) => a.stepIndex === s.stepIndex)}
                  defaultOpen={s.status === "failed"}
                  onOpen={(a) => setLightbox(shots.indexOf(a))}
                />
              ))}
              {pendingSteps.map((p, i) => (
                <li key={`p${i}`} className="flex items-center gap-3 rounded-lg border border-dashed px-3.5 py-2.5 text-sm text-subtle">
                  <span className="tabular w-6 text-right text-xs">{done + i + 1}</span>
                  {i === 0 && run.status === "running" ? <Loader2 className="h-4 w-4 animate-spin text-info" aria-hidden /> : <span className="h-4 w-4" />}
                  <span className="truncate">{p.name}</span>
                </li>
              ))}
            </ol>
          </section>
        </div>

        <aside className="space-y-5" aria-label="Run details">
          <div className="surface divide-y text-sm">
            {[
              ["Queued", run.queuedAt],
              ["Started", run.startTime],
              ["Finished", run.endTime],
            ].map(([label, iso]) => (
              <div key={label} className="flex justify-between gap-3 px-4 py-2.5">
                <span className="text-muted-foreground">{label}</span>
                <span className="text-right">{iso ? dateTime(iso, ws.timezone, { dateStyle: "medium", timeStyle: "medium" }) : "—"}</span>
              </div>
            ))}
            <div className="flex justify-between gap-3 px-4 py-2.5">
              <span className="text-muted-foreground">Duration</span>
              <span className="tabular">{duration(run.duration)}</span>
            </div>
            <div className="flex justify-between gap-3 px-4 py-2.5">
              <span className="text-muted-foreground">Attempts</span>
              <span>
                {run.attempt} of {run.maxAttempts}
              </span>
            </div>
          </div>

          {shots.length > 0 && (
            <div>
              <h3 className="mb-2 text-[13px] font-medium">Screenshots</h3>
              <div className="grid grid-cols-2 gap-2">
                {shots.map((a, i) => (
                  <button key={a.id} onClick={() => setLightbox(i)} className="group relative overflow-hidden rounded-md border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    <img src={`${ws.base}/artifacts/${a.id}`} alt={a.stepIndex ? `Step ${a.stepIndex}` : "End of run"} className="h-24 w-full object-cover object-top transition-transform duration-300 group-hover:scale-[1.03]" loading="lazy" />
                    <span className="absolute bottom-1 left-1 rounded bg-background/85 px-1.5 text-[10px]">{a.stepIndex ? `Step ${a.stepIndex}` : "End"}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {traces.length > 0 && (
            <div className="surface p-4">
              <h3 className="flex items-center gap-2 text-[13px] font-medium">
                <FileArchive className="h-4 w-4" aria-hidden /> Playwright trace
              </h3>
              <p className="mt-1 text-xs text-muted-foreground">A step-by-step recording of the failed attempt. Open it locally with <code>npx playwright show-trace</code>.</p>
              {traces.map((t) => (
                <a key={t.id} href={`${ws.base}/artifacts/${t.id}?download=1`} className="mt-2 flex items-center gap-1.5 text-sm font-medium underline-offset-4 hover:underline">
                  <Download className="h-3.5 w-3.5" /> Attempt {t.attempt} ({bytes(t.sizeBytes)})
                </a>
              ))}
            </div>
          )}

        </aside>
      </div>
      <Lightbox items={shots} index={lightbox} onClose={() => setLightbox(null)} base={ws.base} />
    </div>
  );
}

