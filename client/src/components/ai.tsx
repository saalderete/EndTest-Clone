// AI assistance in the UI: drafting steps in the builder and explaining failed runs.
// Everything here is shown as a suggestion that a person reviews; nothing is published.
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, Lightbulb, Loader2, Sparkles } from "lucide-react";
import { ACTIONS, describeLocator, type Step } from "@shared/steps";
import { useWorkspace } from "@/hooks/session";
import { errorMessage, get, post, queryClient } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Field, Notice, TimeAgo } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

type AiStatus = { available: boolean; enabled: boolean; model: string; spentCents: number; budgetCents: number; budgetLeft: boolean };

export function useAi() {
  const ws = useWorkspace();
  const q = useQuery<AiStatus>({ queryKey: [ws.base, "ai/status"], staleTime: 60_000 });
  return q.data;
}

function AiLabel({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1 rounded bg-info-soft px-1.5 py-0.5 text-[11px] font-medium text-info", className)}>
      <Sparkles className="h-3 w-3" aria-hidden /> AI suggestion — not verified
    </span>
  );
}

/* ---------- drafting ---------- */

type Draft = {
  name: string;
  steps: Step[];
  issues: { stepIndex: number; message: string }[];
  assumptions: string[];
  missingSecrets: string[];
  requestId: number;
};

export function DraftWithAiButton({ caseId, hasSteps, onApply, variant = "outline" }: { caseId: number; hasSteps: boolean; onApply: (steps: Step[], mode: "replace" | "append") => void; variant?: "outline" | "default" }) {
  const ai = useAi();
  const [open, setOpen] = useState(false);
  if (!ai?.enabled) return null;
  return (
    <>
      <Button variant={variant} size="sm" onClick={() => setOpen(true)}>
        <Sparkles className="mr-1.5 h-4 w-4" /> Draft with AI
      </Button>
      {open && <DraftDialog caseId={caseId} hasSteps={hasSteps} onClose={() => setOpen(false)} onApply={onApply} budgetLeft={ai.budgetLeft} />}
    </>
  );
}

function DraftDialog({ caseId, hasSteps, onClose, onApply, budgetLeft }: { caseId: number; hasSteps: boolean; onClose: () => void; onApply: (steps: Step[], mode: "replace" | "append") => void; budgetLeft: boolean }) {
  const ws = useWorkspace();
  const [description, setDescription] = useState("");
  const m = useMutation({
    mutationFn: () => post<Draft>(`${ws.base}/ai/case-drafts`, { description, caseId }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: [ws.base, "ai/status"] }),
  });
  const d = m.data;
  const issuesFor = (i: number) => d?.issues.filter((x) => x.stepIndex === i) ?? [];
  const apply = (mode: "replace" | "append") => {
    onApply(d!.steps, mode);
    onClose();
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90dvh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Draft steps with AI</DialogTitle>
          <DialogDescription>Describe what a person does and what they should see. You'll review the steps before they're added, and they stay a draft until you publish.</DialogDescription>
        </DialogHeader>
        {!d ? (
          <form
            id="ai-draft"
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              m.mutate();
            }}
          >
            {m.error && <Notice tone="danger">{errorMessage(m.error)}</Notice>}
            {!budgetLeft && <Notice tone="warning">This workspace has used its AI budget for the month.</Notice>}
            <Field label="What should this test do?" htmlFor="ai-desc" hint="Mention the page to start on, what to click or type, and the text that proves it worked. Use secret names for logins, never real passwords.">
              <Textarea
                id="ai-desc"
                rows={5}
                autoFocus
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Go to /login, sign in with SAMPLE_EMAIL and SAMPLE_PASSWORD, add a field named South Pivot with the crop Pecans, save it, and check that “Saved South Pivot” appears."
              />
            </Field>
            <p className="text-xs text-muted-foreground">The AI only sees this description, the environment's address and your secret names. It doesn't visit the site, so it guesses labels and wording; check them against the page.</p>
          </form>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-medium">
                {d.steps.length} steps for “{d.name}”
              </p>
              <AiLabel />
            </div>
            {d.missingSecrets.length > 0 && (
              <Notice tone="warning" title="Secrets to add">
                These aren't in the workspace yet: {d.missingSecrets.map((s) => <code key={s} className="mx-0.5 text-xs">{s}</code>)}. Add them in Settings → Secrets before running.
              </Notice>
            )}
            <ol className="divide-y rounded-lg border">
              {d.steps.map((s, i) => (
                <li key={i} className="flex gap-3 px-3 py-2.5 text-sm">
                  <span className="tabular w-5 shrink-0 text-right text-muted-foreground">{i + 1}</span>
                  <span className="min-w-0 flex-1">
                    <span className="font-medium">{s.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {ACTIONS[s.action]?.label ?? s.action}
                      {describeLocator(s) && (
                        <>
                          {" "}
                          · <code className="text-[11px]">{describeLocator(s)}</code>
                        </>
                      )}
                      {s.value && <> · {s.value}</>}
                    </span>
                    {issuesFor(i).map((x, j) => (
                      <span key={j} className="mt-0.5 flex items-center gap-1 text-xs text-warning">
                        <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden /> {x.message}
                      </span>
                    ))}
                  </span>
                </li>
              ))}
            </ol>
            {d.assumptions.length > 0 && (
              <div>
                <p className="text-[13px] font-medium">Check these guesses</p>
                <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-muted-foreground">
                  {d.assumptions.map((a, i) => (
                    <li key={i}>{a}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
        <DialogFooter className="gap-2">
          {!d ? (
            <>
              <Button variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" form="ai-draft" disabled={m.isPending || description.trim().length < 10 || !budgetLeft}>
                {m.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Sparkles className="mr-2 h-4 w-4" />}
                {m.isPending ? "Drafting…" : "Draft steps"}
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={() => m.reset()}>
                Start over
              </Button>
              {hasSteps && (
                <Button variant="outline" onClick={() => apply("append")}>
                  Add after current steps
                </Button>
              )}
              <Button onClick={() => apply("replace")}>{hasSteps ? "Replace steps" : "Use these steps"}</Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ---------- failure analysis ---------- */

type Analysis = {
  summary: string;
  likelyCause: string;
  confidence: "low" | "medium" | "high";
  evidence: string[];
  suggestedFixes: { stepIndex: number | null; change: string }[];
  checkFirst: string;
  requestId: number;
  createdAt?: string;
};

const CAUSE_LABEL: Record<string, string> = {
  test_needs_update: "The test needs updating",
  application_regression: "Likely a bug in the application",
  timing_or_flakiness: "Timing or flakiness",
  environment_or_data: "Environment or test data",
  infrastructure: "Test infrastructure",
  unclear: "Not enough evidence",
};

export function FailureAnalysis({ runId }: { runId: number }) {
  const ws = useWorkspace();
  const ai = useAi();
  const stored = useQuery<Analysis | null>({ queryKey: [ws.base, `ai/failure-analysis/${runId}`], queryFn: () => get(`${ws.base}/ai/failure-analysis/${runId}`), enabled: !!ai?.enabled });
  const m = useMutation({
    mutationFn: () => post<Analysis>(`${ws.base}/ai/failure-analysis`, { runId }),
    onSuccess: (a) => {
      queryClient.setQueryData([ws.base, `ai/failure-analysis/${runId}`], a);
      void queryClient.invalidateQueries({ queryKey: [ws.base, "ai/status"] });
    },
  });
  if (!ai?.enabled) return null;
  const a = m.data ?? stored.data;

  if (!a)
    return (
      <div className="surface flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
        <Lightbulb className="hidden h-5 w-5 shrink-0 text-info sm:block" aria-hidden />
        <div className="flex-1">
          <p className="text-sm font-medium">Ask AI why this failed</p>
          <p className="text-xs text-muted-foreground">It reads this run's steps, logs and failure screenshot, and the last passing run. Secret values are removed first.</p>
          {m.error && <p className="mt-1 text-xs text-danger">{errorMessage(m.error)}</p>}
        </div>
        {ws.can("runner") && (
          <Button variant="outline" size="sm" onClick={() => m.mutate()} disabled={m.isPending || !ai.budgetLeft || stored.isLoading}>
            {m.isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Sparkles className="mr-1.5 h-4 w-4" />}
            {m.isPending ? "Reading the run…" : ai.budgetLeft ? "Explain failure" : "AI budget used"}
          </Button>
        )}
      </div>
    );

  return (
    <section className="surface p-4" aria-labelledby="ai-h">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="ai-h" className="flex items-center gap-2 text-sm font-medium">
          <Lightbulb className="h-4 w-4 text-info" aria-hidden />
          {CAUSE_LABEL[a.likelyCause] ?? a.likelyCause}
          <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-normal text-muted-foreground">{a.confidence} confidence</span>
        </h2>
        <AiLabel />
      </div>
      <p className="mt-2 text-sm">{a.summary}</p>
      {a.evidence.length > 0 && (
        <>
          <p className="mt-3 text-[13px] font-medium">Based on</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-muted-foreground">
            {a.evidence.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </>
      )}
      {a.suggestedFixes.length > 0 && (
        <>
          <p className="mt-3 text-[13px] font-medium">Things to try</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-muted-foreground">
            {a.suggestedFixes.map((f, i) => (
              <li key={i}>
                {f.stepIndex ? <span className="font-medium text-foreground">Step {f.stepIndex}: </span> : null}
                {f.change}
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="mt-3 text-sm">
        <span className="font-medium">Check first: </span>
        <span className="text-muted-foreground">{a.checkFirst}</span>
      </p>
      <p className="mt-3 text-xs text-muted-foreground">
        Generated by AI from this run's records
        {a.createdAt ? (
          <>
            {" "}
            <TimeAgo iso={a.createdAt} />
          </>
        ) : null}
        . It can be wrong; confirm against the screenshot and steps before changing the test.
      </p>
    </section>
  );
}
