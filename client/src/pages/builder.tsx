// The test builder: steps (left), the selected step (middle), evidence,
// versions and settings (right). Drafts save automatically; publishing makes
// an immutable version that runs and schedules use.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useParams } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowLeft, CalendarClock, Check, CircleAlert, Loader2, Play, Redo2, Rocket, Undo2 } from "lucide-react";
import { ACTIONS, stepSchema, type Step } from "@shared/steps";
import { errorMessage, patch, post, put, queryClient } from "@/lib/api";
import { useWorkspace } from "@/hooks/session";
import type { CaseDetail, Secret, StepStatus } from "@/lib/types";
import { ErrorState, Field, Kbd, Notice, Skeleton } from "@/components/common";
import { StepList } from "@/components/builder/step-list";
import { DraftWithAiButton } from "@/components/ai";
import { StepEditor } from "@/components/builder/step-editor";
import { LastRunPanel, SettingsPanel, VersionsPanel, useLastRun } from "@/components/builder/panels";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useToast } from "@/hooks/use-toast";

const newStep = (): Step => ({ name: ACTIONS.click.label, action: "click", locatorType: "role", locatorValue: "", value: null, options: {}, enabled: true });

function useHistory(initial: Step[]) {
  const [state, setState] = useState({ past: [] as Step[][], present: initial, future: [] as Step[][] });
  const set = useCallback((next: Step[], coalesce = false) => {
    setState((s) => ({ past: coalesce && s.past.length ? s.past : [...s.past.slice(-99), s.present], present: next, future: [] }));
  }, []);
  const undo = useCallback(() => setState((s) => (s.past.length ? { past: s.past.slice(0, -1), present: s.past[s.past.length - 1], future: [s.present, ...s.future] } : s)), []);
  const redo = useCallback(() => setState((s) => (s.future.length ? { past: [...s.past, s.present], present: s.future[0], future: s.future.slice(1) } : s)), []);
  const reset = useCallback((steps: Step[]) => setState({ past: [], present: steps, future: [] }), []);
  return { steps: state.present, set, undo, redo, reset, canUndo: state.past.length > 0, canRedo: state.future.length > 0 };
}

type SaveState = "saved" | "dirty" | "saving" | "error";

export default function TestBuilderPage() {
  const ws = useWorkspace();
  const { caseId } = useParams<{ caseId: string }>();
  const id = Number(caseId);
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const key = [ws.base, `cases/${id}`];
  const q = useQuery<CaseDetail>({ queryKey: key });
  const secrets = useQuery<Secret[]>({ queryKey: [ws.base, "secrets"] });
  const h = useHistory([]);
  const [selected, setSelected] = useState(0);
  const [save, setSave] = useState<SaveState>("saved");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);
  const loadedFor = useRef<string | null>(null);
  const readOnly = !ws.can("editor");

  // Load (and reload after a revert) the server's draft, unless there are local edits.
  useEffect(() => {
    if (!q.data) return;
    const stamp = `${q.data.id}:${q.data.draftUpdatedAt ?? ""}:${q.data.published?.version ?? ""}`;
    if (loadedFor.current === null || (loadedFor.current !== stamp && save === "saved")) {
      h.reset(q.data.steps);
      loadedFor.current = stamp;
      setSelected((s) => Math.min(s, Math.max(0, q.data!.steps.length - 1)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.data]);

  // Autosave, 700 ms after the last edit.
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const latest = useRef(h.steps);
  latest.current = h.steps;
  const flush = useCallback(async () => {
    clearTimeout(timer.current);
    setSave("saving");
    try {
      await put(`${ws.base}/cases/${id}/steps`, { steps: latest.current });
      setSave("saved");
      setSaveError(null);
      loadedFor.current = null; // accept the server's new draft stamp
      await queryClient.invalidateQueries({ queryKey: key });
    } catch (err) {
      setSave("error");
      setSaveError(errorMessage(err));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws.base, id]);
  const update = useCallback(
    (steps: Step[], coalesce = false) => {
      h.set(steps, coalesce);
      setSave("dirty");
      clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), 700);
    },
    [h, flush],
  );
  const afterHistory = useCallback(() => {
    setSave("dirty");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), 700);
  }, [flush]);
  const applyDraft = useCallback(
    (steps: Step[], mode: "replace" | "append") => {
      const base = mode === "append" ? h.steps : [];
      update([...base, ...steps]);
      setSelected(base.length);
      toast({ title: mode === "append" ? "Draft steps added" : "Steps replaced", description: "Review each step, then publish. Undo with ⌘Z." });
    },
    [h.steps, update, toast],
  );
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (save === "dirty" || save === "saving") e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [save]);

  // Undo/redo outside text fields (text fields keep their own undo).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (readOnly || ["INPUT", "TEXTAREA"].includes(t.tagName) || t.isContentEditable) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) h.redo();
        else h.undo();
        afterHistory();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [h, afterHistory, readOnly]);

  const { run: lastRun } = useLastRun(id);
  const lastResults = useMemo(() => {
    if (!lastRun || lastRun.caseVersion !== q.data?.publishedVersion) return undefined;
    return new Map(lastRun.steps.filter((s) => s.attempt === lastRun.attempt && s.stepIndex).map((s) => [s.stepIndex!, s.status as StepStatus]));
  }, [lastRun, q.data?.publishedVersion]);

  const problems = useMemo(() => h.steps.map((s, i) => ({ i, r: stepSchema.safeParse(s) })).filter((x) => !x.r.success), [h.steps]);

  const runNow = useMutation({
    mutationFn: () => post<{ runId: number }>(`${ws.base}/runs`, { caseId: id }),
    onSuccess: (r) => {
      void queryClient.invalidateQueries({ queryKey: [ws.base] });
      navigate(`/runs/${r.runId}`);
    },
    onError: (e) => toast({ title: "Couldn't start the run", description: errorMessage(e), variant: "destructive" }),
  });
  const rename = useMutation({ mutationFn: (name: string) => patch(`${ws.base}/cases/${id}`, { name }), onSuccess: () => void queryClient.invalidateQueries({ queryKey: [ws.base] }) });
  const reviewed = useMutation({
    mutationFn: () => patch(`${ws.base}/cases/${id}`, { reviewed: true }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [ws.base] });
      toast({ title: "Marked as reviewed", description: "It can now be scheduled." });
    },
  });

  if (q.error) return <ErrorState error={q.error} retry={() => void q.refetch()} />;
  if (!q.data) return <Skeleton className="h-[70vh]" />;
  const c = q.data;
  const step = h.steps[selected];
  const unpublished = c.hasUnpublishedChanges || save !== "saved";

  return (
    <div className="-mx-4 -my-6 flex min-h-[calc(100dvh-3.5rem)] flex-col sm:-mx-6 lg:-mx-8 lg:-my-8">
      {/* header */}
      <div className="border-b bg-surface px-4 py-3 sm:px-6">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Link href="/tests" className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground" aria-label="Back to tests">
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <input
                defaultValue={c.name}
                key={c.name}
                readOnly={readOnly}
                aria-label="Test name"
                onBlur={(e) => e.target.value.trim() && e.target.value !== c.name && rename.mutate(e.target.value.trim())}
                onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                className="min-w-0 flex-1 truncate rounded bg-transparent px-1 -mx-1 text-[17px] font-semibold tracking-[-0.01em] outline-none hover:bg-muted/50 focus:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
              <span>{c.suiteName}</span>
              <span aria-hidden>·</span>
              {c.published ? <span className="font-medium text-success">v{c.published.version} live</span> : <span>Never published</span>}
              {c.published && unpublished && <span className="rounded bg-warning-soft px-1.5 py-0.5 font-medium text-warning">Unpublished changes</span>}
              <span aria-hidden>·</span>
              <SaveIndicator state={save} error={saveError} retry={() => void flush()} />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {!readOnly && (
              <>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="icon" aria-label="Undo" disabled={!h.canUndo} onClick={() => { h.undo(); afterHistory(); }}>
                      <Undo2 className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    Undo <Kbd>⌘Z</Kbd>
                  </TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="icon" aria-label="Redo" disabled={!h.canRedo} onClick={() => { h.redo(); afterHistory(); }}>
                      <Redo2 className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    Redo <Kbd>⇧⌘Z</Kbd>
                  </TooltipContent>
                </Tooltip>
              </>
            )}
            {!readOnly && h.steps.length > 0 && <DraftWithAiButton caseId={c.id} hasSteps onApply={applyDraft} />}
            <Button variant="outline" size="sm" asChild>
              <Link href={`/schedules?caseId=${c.id}`} aria-label="Schedule">
                <CalendarClock className="h-4 w-4 sm:mr-1.5" /> <span className="hidden sm:inline">Schedule</span>
              </Link>
            </Button>
            {ws.can("runner") && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>
                    <Button variant="outline" size="sm" disabled={!c.publishedVersion || runNow.isPending} onClick={() => runNow.mutate()}>
                      {runNow.isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Play className="mr-1.5 h-4 w-4" />}
                      Run v{c.publishedVersion ?? "–"}
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>{c.publishedVersion ? "Runs the published version, not your draft." : "Publish first."}</TooltipContent>
              </Tooltip>
            )}
            {!readOnly && (
              <Button size="sm" onClick={() => setPublishOpen(true)} disabled={!unpublished && !!c.published}>
                <Rocket className="mr-1.5 h-4 w-4" /> Publish
              </Button>
            )}
          </div>
        </div>
        {c.needsReview && (
          <div className="mt-3">
            <Notice
              tone="warning"
              title="Needs review before it can be scheduled"
              action={ws.can("editor") ? <Button size="sm" variant="outline" onClick={() => reviewed.mutate()} disabled={reviewed.isPending}><Check className="mr-1.5 h-4 w-4" /> Mark reviewed</Button> : undefined}
            >
              {c.reviewNote}
            </Notice>
          </div>
        )}
        {c.missingSecrets.length > 0 && (
          <div className="mt-3">
            <Notice tone="danger" title="Missing secrets">
              These steps use secrets that don't exist in this workspace: {c.missingSecrets.map((s) => <code key={s} className="mx-0.5 text-xs">{s}</code>)}. An admin can add them in Settings → Secrets.
            </Notice>
          </div>
        )}
      </div>

      {/* three panes */}
      <div className="grid flex-1 lg:grid-cols-[300px_minmax(0,1fr)] xl:grid-cols-[300px_minmax(0,1fr)_400px]">
        <div className="max-h-[50vh] border-b bg-surface-2 lg:sticky lg:top-14 lg:max-h-[calc(100dvh-3.5rem)] lg:self-start lg:border-b-0 lg:border-r">
          <StepList
            steps={h.steps}
            selected={selected}
            onSelect={setSelected}
            readOnly={readOnly}
            lastResults={lastResults}
            onMove={(from, to) => {
              const next = [...h.steps];
              const [m] = next.splice(from, 1);
              next.splice(to, 0, m);
              update(next);
              setSelected(to);
            }}
            onAdd={(after) => {
              const at = h.steps.length ? after + 1 : 0;
              const next = [...h.steps];
              next.splice(at, 0, newStep());
              update(next);
              setSelected(at);
              setTimeout(() => document.getElementById("step-name")?.focus(), 30);
            }}
            onDuplicate={(i) => {
              const next = [...h.steps];
              next.splice(i + 1, 0, structuredClone(h.steps[i]));
              update(next);
              setSelected(i + 1);
            }}
            onRemove={(i) => {
              update(h.steps.filter((_, j) => j !== i));
              setSelected(Math.max(0, Math.min(i, h.steps.length - 2)));
              toast({ title: "Step deleted", description: "Undo with ⌘Z." });
            }}
          />
        </div>
        <div className="min-w-0 border-b p-4 sm:p-6 xl:border-b-0 xl:border-r">
          {step ? (
            <div className="mx-auto max-w-2xl">
              <StepEditor key={selected} step={step} index={selected} readOnly={readOnly} secrets={secrets.data ?? []} scriptStepsAllowed={c.scriptStepsAllowed} onChange={(s) => update(h.steps.map((x, j) => (j === selected ? s : x)), true)} />
            </div>
          ) : (
            <div className="grid h-full place-items-center py-16 text-center">
              <div>
                <p className="font-medium">Start with where the test begins</p>
                <p className="mt-1 text-sm text-muted-foreground">Usually “Go to URL”, then the clicks and checks a person would do.</p>
                {!readOnly && (
                  <Button
                    className="mt-4"
                    onClick={() => {
                      update([{ name: "Open the start page", action: "navigate", value: "/", options: {}, enabled: true, locatorType: null, locatorValue: null }]);
                      setSelected(0);
                    }}
                  >
                    Add “Go to URL”
                  </Button>
                )}
                {!readOnly && (
                  <div className="mt-2">
                    <DraftWithAiButton caseId={c.id} hasSteps={false} onApply={applyDraft} />
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
        <div className="min-w-0 p-4 sm:p-6 lg:col-span-2 xl:col-span-1">
          <Tabs defaultValue="run">
            <TabsList className="w-full">
              <TabsTrigger value="run" className="flex-1">Last run</TabsTrigger>
              <TabsTrigger value="versions" className="flex-1">Versions</TabsTrigger>
              <TabsTrigger value="settings" className="flex-1">Settings</TabsTrigger>
            </TabsList>
            <TabsContent value="run" className="mt-4">
              <LastRunPanel caseId={c.id} stepIndex={selected} publishedVersion={c.publishedVersion} />
            </TabsContent>
            <TabsContent value="versions" className="mt-4">
              <VersionsPanel
                c={c}
                onReverted={() => {
                  loadedFor.current = null;
                  setSave("saved");
                  void queryClient.invalidateQueries({ queryKey: key });
                }}
              />
            </TabsContent>
            <TabsContent value="settings" className="mt-4">
              <SettingsPanel key={c.updatedAt} c={c} />
            </TabsContent>
          </Tabs>
        </div>
      </div>

      <PublishDialog
        open={publishOpen}
        onOpenChange={setPublishOpen}
        caseId={c.id}
        problems={problems.map((p) => ({ index: p.i, message: !p.r.success ? p.r.error.issues[0]?.message ?? "Invalid" : "" }))}
        onBefore={async () => {
          if (save !== "saved") await flush();
        }}
        onGoTo={(i) => {
          setSelected(i);
          setPublishOpen(false);
        }}
        nextVersion={(c.publishedVersion ?? 0) + 1}
      />
    </div>
  );
}

function SaveIndicator({ state, error, retry }: { state: SaveState; error: string | null; retry: () => void }) {
  if (state === "saving")
    return (
      <span className="flex items-center gap-1">
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> Saving…
      </span>
    );
  if (state === "dirty") return <span>Unsaved edits</span>;
  if (state === "error")
    return (
      <span className="flex items-center gap-1 text-danger">
        <CircleAlert className="h-3 w-3" aria-hidden /> Not saved: {error}{" "}
        <button onClick={retry} className="underline underline-offset-2">
          Retry
        </button>
      </span>
    );
  return (
    <span className="flex items-center gap-1">
      <Check className="h-3 w-3" aria-hidden /> Draft saved
    </span>
  );
}

function PublishDialog({
  open,
  onOpenChange,
  caseId,
  problems,
  onBefore,
  onGoTo,
  nextVersion,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  caseId: number;
  problems: { index: number; message: string }[];
  onBefore: () => Promise<void>;
  onGoTo: (i: number) => void;
  nextVersion: number;
}) {
  const ws = useWorkspace();
  const { toast } = useToast();
  const [note, setNote] = useState("");
  const m = useMutation({
    mutationFn: async () => {
      await onBefore();
      return post<{ version: number }>(`${ws.base}/cases/${caseId}/publish`, { note: note || undefined });
    },
    onSuccess: (r) => {
      void queryClient.invalidateQueries({ queryKey: [ws.base] });
      onOpenChange(false);
      setNote("");
      toast({ title: `Version ${r.version} is live`, description: "Runs and schedules use it from now on." });
    },
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Publish version {nextVersion}</DialogTitle>
          <DialogDescription>Publishing saves a copy that can't change. Scheduled and manual runs use it from now on; earlier versions stay in the history.</DialogDescription>
        </DialogHeader>
        {problems.length ? (
          <Notice tone="danger" title={`${problems.length} ${problems.length === 1 ? "step needs" : "steps need"} attention`}>
            <ul className="mt-1 space-y-1">
              {problems.slice(0, 5).map((p) => (
                <li key={p.index}>
                  <button className="text-left underline-offset-2 hover:underline" onClick={() => onGoTo(p.index)}>
                    Step {p.index + 1}: {p.message}
                  </button>
                </li>
              ))}
            </ul>
          </Notice>
        ) : (
          <Field label="What changed" htmlFor="pub-note" optional>
            <Textarea id="pub-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Wait for the report dialog before clicking Next" />
          </Field>
        )}
        {m.error && <Notice tone="danger">{errorMessage(m.error)}</Notice>}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => m.mutate()} disabled={m.isPending || problems.length > 0}>
            {m.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Publish
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

