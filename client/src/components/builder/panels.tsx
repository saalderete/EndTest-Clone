// Right pane of the builder: last run evidence, versions, settings.
import { useState } from "react";
import { Link } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ExternalLink, History, ImageOff, RotateCcw } from "lucide-react";
import { ACTIONS, type Step } from "@shared/steps";
import { errorMessage, patch, post, queryClient } from "@/lib/api";
import { useWorkspace } from "@/hooks/session";
import type { CaseDetail, Environment, RunDetail, RunSummary, Suite } from "@/lib/types";
import { dateTime, duration } from "@/lib/format";
import { EmptyState, Field, Notice, Skeleton, StatusBadge, TimeAgo } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";

export function useLastRun(caseId: number) {
  const ws = useWorkspace();
  const list = useQuery<{ items: RunSummary[] }>({ queryKey: [ws.base, `runs?caseId=${caseId}&limit=1`], refetchInterval: (q) => (q.state.data?.items[0] && ["queued", "starting", "running", "cancel_requested"].includes(q.state.data.items[0].status) ? 3000 : 30_000) });
  const id = list.data?.items[0]?.id;
  const detail = useQuery<RunDetail>({ queryKey: [ws.base, `runs/${id}`], enabled: !!id, refetchInterval: (q) => (q.state.data && ["queued", "starting", "running", "cancel_requested"].includes(q.state.data.status) ? 2000 : false) });
  return { run: detail.data, loading: list.isLoading || (!!id && detail.isLoading), none: list.data && !list.data.items.length };
}

export function LastRunPanel({ caseId, stepIndex, publishedVersion }: { caseId: number; stepIndex: number; publishedVersion: number | null }) {
  const ws = useWorkspace();
  const { run, loading, none } = useLastRun(caseId);
  if (loading) return <Skeleton className="h-48" />;
  if (none || !run) return <EmptyState title="Not run yet">Publish and run the test to see each step's result and screenshots here.</EmptyState>;
  const attempt = run.attempt;
  const result = run.steps.filter((s) => s.attempt === attempt).find((s) => s.stepIndex === stepIndex + 1);
  const shots = run.artifacts.filter((a) => a.kind === "screenshot" && a.attempt === attempt && a.stepIndex === stepIndex + 1);
  const finalShot = run.artifacts.filter((a) => a.kind === "screenshot" && a.attempt === attempt && a.stepIndex === null).at(-1);
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <StatusBadge status={run.status} />
          <span className="text-xs text-muted-foreground">
            v{run.caseVersion} · <TimeAgo iso={run.createdAt} exact={dateTime(run.createdAt, ws.timezone)} />
          </span>
        </div>
        <Link href={`/runs/${run.id}`} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          Open run <ExternalLink className="h-3 w-3" />
        </Link>
      </div>
      {publishedVersion && run.caseVersion !== publishedVersion && <Notice tone="info">This run used version {run.caseVersion}; the test is now on version {publishedVersion}. Step numbers may differ.</Notice>}
      <div className="rounded-lg border bg-surface-2 p-3.5">
        <div className="eyebrow mb-2">Step {stepIndex + 1} in that run</div>
        {result ? (
          <>
            <div className="flex items-center gap-2">
              <StatusBadge status={result.status} />
              <span className="truncate text-sm font-medium">{result.stepName}</span>
              <span className="ml-auto tabular text-xs text-muted-foreground">{duration(result.duration)}</span>
            </div>
            {result.errorMessage && <p className="mt-2 text-sm text-danger">{result.errorMessage}</p>}
            {result.log && <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted/60 p-2 text-[11.5px] text-muted-foreground">{result.log}</pre>}
          </>
        ) : (
          <p className="text-sm text-muted-foreground">{["queued", "starting", "running"].includes(run.status) ? "Not reached yet…" : "This step didn't run (the test stopped before it, or it was added later)."}</p>
        )}
      </div>
      {(shots.length > 0 || finalShot) && (
        <figure>
          <a href={`${ws.base}/artifacts/${(shots.at(-1) ?? finalShot)!.id}`} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-lg border bg-muted">
            <img src={`${ws.base}/artifacts/${(shots.at(-1) ?? finalShot)!.id}`} alt={shots.length ? `Screenshot at step ${stepIndex + 1}` : "Screenshot at the end of the run"} className="max-h-[420px] w-full object-cover object-top" loading="lazy" />
          </a>
          <figcaption className="mt-1.5 text-xs text-muted-foreground">{shots.length ? `Screenshot at step ${stepIndex + 1}` : "No screenshot for this step; showing the end of the run."}</figcaption>
        </figure>
      )}
      {!shots.length && !finalShot && (
        <div className="flex items-center gap-2 rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
          <ImageOff className="h-4 w-4" aria-hidden /> No screenshots for this step. Failed steps and screenshot steps capture one.
        </div>
      )}
    </div>
  );
}

type Version = { version: number; note: string | null; publishedAt: string; publishedBy: string | null; stepCount: number };

export function VersionsPanel({ c, onReverted }: { c: CaseDetail; onReverted: () => void }) {
  const ws = useWorkspace();
  const { toast } = useToast();
  const versions = useQuery<Version[]>({ queryKey: [ws.base, `cases/${c.id}/versions`] });
  const [viewing, setViewing] = useState<number | null>(null);
  const v = useQuery<{ steps: Step[]; note: string | null }>({ queryKey: [ws.base, `cases/${c.id}/versions/${viewing}`], enabled: viewing !== null });
  const revert = useMutation({
    mutationFn: (version: number) => post(`${ws.base}/cases/${c.id}/revert`, { version }),
    onSuccess: () => {
      setViewing(null);
      onReverted();
      toast({ title: "Draft restored", description: "Review it, then publish to make it the running version." });
    },
  });
  if (versions.isLoading) return <Skeleton className="h-40" />;
  if (!versions.data?.length) return <EmptyState title="No published versions" icon={History}>Publishing saves an immutable copy of the steps. Runs and schedules always use the latest one.</EmptyState>;
  return (
    <>
      <ol className="space-y-2">
        {versions.data.map((x) => (
          <li key={x.version} className="rounded-lg border bg-surface p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium">
                Version {x.version}
                {x.version === c.publishedVersion && <span className="ml-2 rounded bg-success-soft px-1.5 py-0.5 text-[11px] font-medium text-success">Live</span>}
              </span>
              <Button size="sm" variant="ghost" className="h-7" onClick={() => setViewing(x.version)}>
                View
              </Button>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {x.stepCount} steps · {x.publishedBy ?? "imported"} · <TimeAgo iso={x.publishedAt} exact={dateTime(x.publishedAt, ws.timezone)} />
            </p>
            {x.note && <p className="mt-1.5 text-[13px]">{x.note}</p>}
          </li>
        ))}
      </ol>
      <Dialog open={viewing !== null} onOpenChange={(o) => !o && setViewing(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Version {viewing}</DialogTitle>
            <DialogDescription>{v.data?.note ?? "Published steps, read-only."}</DialogDescription>
          </DialogHeader>
          <ol className="max-h-[50vh] space-y-1 overflow-y-auto text-sm">
            {v.data?.steps.map((s, i) => (
              <li key={i} className="flex gap-2 rounded px-2 py-1.5 odd:bg-muted/50">
                <span className="tabular w-6 shrink-0 text-xs text-subtle">{i + 1}</span>
                <span className="min-w-0">
                  <span className={s.enabled === false ? "text-subtle line-through" : "font-medium"}>{s.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">{ACTIONS[s.action]?.label ?? s.action}</span>
                </span>
              </li>
            ))}
          </ol>
          {revert.error && <Notice tone="danger">{errorMessage(revert.error)}</Notice>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setViewing(null)}>
              Close
            </Button>
            {ws.can("editor") && viewing !== null && (
              <Button onClick={() => revert.mutate(viewing)} disabled={revert.isPending}>
                <RotateCcw className="mr-2 h-4 w-4" /> Restore as draft
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function SettingsPanel({ c }: { c: CaseDetail }) {
  const ws = useWorkspace();
  const { toast } = useToast();
  const suites = useQuery<Suite[]>({ queryKey: [ws.base, "suites"] });
  const envs = useQuery<Environment[]>({ queryKey: [ws.base, "environments"] });
  const [f, setF] = useState({
    description: c.description ?? "",
    suiteId: String(c.suiteId),
    environmentId: c.environmentId ? String(c.environmentId) : "suite",
    priority: c.priority,
    tags: c.tags.join(", "),
    maxRetries: String(c.maxRetries),
    timeout: String(c.timeoutMs / 1000),
    stepTimeout: String(c.stepTimeoutMs / 1000),
    overlapPolicy: c.overlapPolicy,
    isActive: c.isActive,
  });
  const save = useMutation({
    mutationFn: () =>
      patch(`${ws.base}/cases/${c.id}`, {
        description: f.description || null,
        suiteId: Number(f.suiteId),
        environmentId: f.environmentId === "suite" ? null : Number(f.environmentId),
        priority: f.priority,
        tags: f.tags.split(",").map((t) => t.trim()).filter(Boolean),
        maxRetries: Number(f.maxRetries),
        timeoutMs: Math.round(Number(f.timeout) * 1000),
        stepTimeoutMs: Math.round(Number(f.stepTimeout) * 1000),
        overlapPolicy: f.overlapPolicy,
        isActive: f.isActive,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [ws.base] });
      toast({ title: "Settings saved" });
    },
  });
  const ro = !ws.can("editor");
  const suiteEnv = suites.data?.find((s) => String(s.id) === f.suiteId)?.environmentName;
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <fieldset disabled={ro} className="space-y-4">
        {save.error && <Notice tone="danger">{errorMessage(save.error)}</Notice>}
        <Field label="Description" htmlFor="c-desc" optional>
          <Textarea id="c-desc" rows={3} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="What a pass proves, and who to ask when it fails." />
        </Field>
        <Field label="Suite">
          <Select value={f.suiteId} onValueChange={(v) => setF({ ...f, suiteId: v })}>
            <SelectTrigger>
              <SelectValue />
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
        <Field label="Environment">
          <Select value={f.environmentId} onValueChange={(v) => setF({ ...f, environmentId: v })}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="suite">Suite default{suiteEnv ? ` (${suiteEnv})` : " (none)"}</SelectItem>
              {envs.data?.map((e) => (
                <SelectItem key={e.id} value={String(e.id)}>
                  {e.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Priority">
            <Select value={f.priority} onValueChange={(v) => setF({ ...f, priority: v as typeof f.priority })}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {["critical", "high", "normal", "low"].map((p) => (
                  <SelectItem key={p} value={p} className="capitalize">
                    {p}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Retries" hint="Failed runs are retried; every attempt is kept.">
            <Select value={f.maxRetries} onValueChange={(v) => setF({ ...f, maxRetries: v })}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {["0", "1", "2", "3"].map((n) => (
                  <SelectItem key={n} value={n}>
                    {n === "0" ? "No retries" : `${n} ${n === "1" ? "retry" : "retries"}`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Test time limit (s)" htmlFor="c-timeout">
            <Input id="c-timeout" type="number" inputMode="numeric" min={10} max={1800} value={f.timeout} onChange={(e) => setF({ ...f, timeout: e.target.value })} />
          </Field>
          <Field label="Step timeout (s)" htmlFor="c-step">
            <Input id="c-step" type="number" inputMode="numeric" min={1} max={300} value={f.stepTimeout} onChange={(e) => setF({ ...f, stepTimeout: e.target.value })} />
          </Field>
        </div>
        <Field label="If a scheduled run is still going" hint="What happens when the next scheduled time arrives.">
          <Select value={f.overlapPolicy} onValueChange={(v) => setF({ ...f, overlapPolicy: v as typeof f.overlapPolicy })}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="skip">Skip the new run</SelectItem>
              <SelectItem value="queue">Queue it behind the current one</SelectItem>
              <SelectItem value="cancel_previous">Cancel the current one and start fresh</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label="Tags" htmlFor="c-tags" hint="Comma-separated." optional>
          <Input id="c-tags" value={f.tags} onChange={(e) => setF({ ...f, tags: e.target.value })} />
        </Field>
        <label className="flex items-start gap-3">
          <Switch className="mt-0.5" checked={f.isActive} onCheckedChange={(v) => setF({ ...f, isActive: v })} />
          <span>
            <span className="block text-[13px] font-medium">Test is on</span>
            <span className="block text-xs text-muted-foreground">When off, it can't be run or scheduled.</span>
          </span>
        </label>
        {!ro && (
          <Button type="submit" disabled={save.isPending}>
            Save settings
          </Button>
        )}
      </fieldset>
    </form>
  );
}
