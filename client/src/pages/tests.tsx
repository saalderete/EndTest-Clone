import { useMemo, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CalendarClock, Copy, Download, FlaskConical, FolderPlus, MoreHorizontal, Pause, Play, Plus, Search, Trash2, Upload } from "lucide-react";
import { useWorkspace } from "@/hooks/session";
import { useUrlState } from "@/hooks/url-state";
import { del, errorMessage, get, patch, post, queryClient } from "@/lib/api";
import type { CaseSummary, Environment, Suite } from "@/lib/types";
import { dateTime, describeCron, percent } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Confirm, EmptyState, ErrorState, Field, Notice, PageHeader, StatusDot, TableSkeleton, TimeAgo } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useToast } from "@/hooks/use-toast";

function SuiteDialog({ open, onOpenChange, suite }: { open: boolean; onOpenChange: (v: boolean) => void; suite?: Suite }) {
  const ws = useWorkspace();
  const envs = useQuery<Environment[]>({ queryKey: [ws.base, "environments"], enabled: open });
  const [name, setName] = useState(suite?.name ?? "");
  const [description, setDescription] = useState(suite?.description ?? "");
  const [envId, setEnvId] = useState<string>(suite?.environmentId ? String(suite.environmentId) : "");
  const m = useMutation({
    mutationFn: () => {
      const body = { name, description: description || null, environmentId: envId ? Number(envId) : null };
      return suite ? patch(`${ws.base}/suites/${suite.id}`, body) : post(`${ws.base}/suites`, body);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [ws.base, "suites"] });
      onOpenChange(false);
    },
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{suite ? "Edit suite" : "New suite"}</DialogTitle>
          <DialogDescription>Group related tests, like everything about sign-in or reports.</DialogDescription>
        </DialogHeader>
        <form
          id="suite-form"
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            m.mutate();
          }}
        >
          {m.error && <Notice tone="danger">{errorMessage(m.error)}</Notice>}
          <Field label="Name" htmlFor="suite-name">
            <Input id="suite-name" required value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </Field>
          <Field label="Description" htmlFor="suite-desc" optional>
            <Textarea id="suite-desc" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          <Field label="Environment" hint="Tests in the suite run against it unless they choose their own.">
            <Select value={envId} onValueChange={setEnvId}>
              <SelectTrigger>
                <SelectValue placeholder={envs.data?.length ? "Choose an environment" : "No environments yet"} />
              </SelectTrigger>
              <SelectContent>
                {envs.data?.map((e) => (
                  <SelectItem key={e.id} value={String(e.id)}>
                    {e.name} · {e.baseUrl}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="suite-form" disabled={m.isPending || !name.trim()}>
            {suite ? "Save" : "Create suite"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function NewTestDialog({ open, onOpenChange, suites, defaultSuite }: { open: boolean; onOpenChange: (v: boolean) => void; suites: Suite[]; defaultSuite?: number }) {
  const ws = useWorkspace();
  const [, navigate] = useLocation();
  const [name, setName] = useState("");
  const [suiteId, setSuiteId] = useState(defaultSuite ? String(defaultSuite) : suites[0] ? String(suites[0].id) : "");
  const m = useMutation({
    mutationFn: () => post<{ id: number }>(`${ws.base}/cases`, { name, suiteId: Number(suiteId), steps: [] }),
    onSuccess: (c) => {
      void queryClient.invalidateQueries({ queryKey: [ws.base, "cases"] });
      navigate(`/tests/${c.id}`);
    },
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New test</DialogTitle>
          <DialogDescription>You'll add steps in the builder next. Nothing runs until you publish.</DialogDescription>
        </DialogHeader>
        <form
          id="test-form"
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            m.mutate();
          }}
        >
          {m.error && <Notice tone="danger">{errorMessage(m.error)}</Notice>}
          <Field label="Name" htmlFor="test-name" hint="Say what a pass proves, e.g. “Grower can sign in and see the dashboard”.">
            <Input id="test-name" required value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </Field>
          <Field label="Suite">
            <Select value={suiteId} onValueChange={setSuiteId}>
              <SelectTrigger>
                <SelectValue placeholder="Choose a suite" />
              </SelectTrigger>
              <SelectContent>
                {suites.map((s) => (
                  <SelectItem key={s.id} value={String(s.id)}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="test-form" disabled={m.isPending || !name.trim() || !suiteId}>
            Create and open builder
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ImportDialog({ open, onOpenChange, suites, defaultSuite }: { open: boolean; onOpenChange: (v: boolean) => void; suites: Suite[]; defaultSuite?: number }) {
  const ws = useWorkspace();
  const [, navigate] = useLocation();
  const fileRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [suiteId, setSuiteId] = useState(defaultSuite ? String(defaultSuite) : suites[0] ? String(suites[0].id) : "");
  const [parseError, setParseError] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: () => {
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error("That isn't valid JSON. Use a file exported from TestHarvest.");
      }
      return post<{ id: number }>(`${ws.base}/cases/import`, { suiteId: Number(suiteId), data });
    },
    onSuccess: (c) => {
      void queryClient.invalidateQueries({ queryKey: [ws.base, "cases"] });
      navigate(`/tests/${c.id}`);
    },
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Import a test</DialogTitle>
          <DialogDescription>Paste or choose a file exported from TestHarvest. It's imported as a draft; secrets stay as references.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {(m.error || parseError) && <Notice tone="danger">{parseError ?? errorMessage(m.error)}</Notice>}
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
              <Upload className="mr-2 h-4 w-4" /> Choose file
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                if (f.size > 1_000_000) return setParseError("That file is too large.");
                setParseError(null);
                setText(await f.text());
              }}
            />
            <span className="text-xs text-muted-foreground">or paste below</span>
          </div>
          <Textarea rows={8} className="font-mono text-xs" value={text} onChange={(e) => setText(e.target.value)} placeholder='{"format": "testharvest.case.v1", ...}' />
          <Field label="Into suite">
            <Select value={suiteId} onValueChange={setSuiteId}>
              <SelectTrigger>
                <SelectValue placeholder="Choose a suite" />
              </SelectTrigger>
              <SelectContent>
                {suites.map((s) => (
                  <SelectItem key={s.id} value={String(s.id)}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => m.mutate()} disabled={m.isPending || !text.trim() || !suiteId}>
            Import as draft
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function downloadJson(name: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `${name.replace(/[^\w-]+/g, "-").toLowerCase()}.testharvest.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export default function TestsPage() {
  const ws = useWorkspace();
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const [q, setQ] = useUrlState({ suite: "", q: "" });
  const [dialog, setDialog] = useState<"suite" | "test" | "import" | null>(null);
  const suites = useQuery<Suite[]>({ queryKey: [ws.base, "suites"] });
  const cases = useQuery<CaseSummary[]>({ queryKey: [ws.base, "cases"], refetchInterval: 20_000 });
  const suiteId = q.suite ? Number(q.suite) : undefined;
  const selectedSuite = suites.data?.find((s) => s.id === suiteId);

  const visible = useMemo(() => {
    const needle = (q.q ?? "").toLowerCase();
    return (cases.data ?? []).filter((c) => (!suiteId || c.suiteId === suiteId) && (!needle || c.name.toLowerCase().includes(needle) || (c.description ?? "").toLowerCase().includes(needle) || c.tags.some((t) => t.toLowerCase().includes(needle))));
  }, [cases.data, suiteId, q.q]);

  const run = useMutation({
    mutationFn: (body: { caseId?: number; suiteId?: number }) => post<{ runId?: number; queued?: number[]; skipped?: { name: string; reason: string }[] }>(`${ws.base}/runs`, body),
    onSuccess: (r) => {
      void queryClient.invalidateQueries({ queryKey: [ws.base] });
      if (r.runId) {
        toast({ title: "Run queued", description: "Opening the live run…" });
        navigate(`/runs/${r.runId}`);
      } else toast({ title: `${r.queued?.length ?? 0} tests queued`, description: r.skipped?.length ? `${r.skipped.length} skipped: ${r.skipped.map((s) => s.name).join(", ")}` : undefined });
    },
    onError: (e) => toast({ title: "Couldn't start the run", description: errorMessage(e), variant: "destructive" }),
  });
  const remove = useMutation({
    mutationFn: (id: number) => del(`${ws.base}/cases/${id}`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: [ws.base, "cases"] }),
  });
  const duplicate = useMutation({
    mutationFn: (id: number) => post<{ id: number }>(`${ws.base}/cases/${id}/duplicate`, {}),
    onSuccess: (c) => {
      void queryClient.invalidateQueries({ queryKey: [ws.base, "cases"] });
      navigate(`/tests/${c.id}`);
    },
  });

  const noSuites = suites.data && suites.data.length === 0;
  return (
    <>
      <PageHeader
        title="Tests"
        description="Each test is a list of browser steps. Edits are drafts until you publish them; runs always use the published version."
        actions={
          ws.can("editor") && (
            <>
              <Button variant="outline" onClick={() => setDialog("import")} disabled={noSuites}>
                <Upload className="mr-2 h-4 w-4" /> Import
              </Button>
              <Button variant="outline" onClick={() => setDialog("suite")}>
                <FolderPlus className="mr-2 h-4 w-4" /> New suite
              </Button>
              <Button onClick={() => setDialog("test")} disabled={noSuites}>
                <Plus className="mr-2 h-4 w-4" /> New test
              </Button>
            </>
          )
        }
      />
      {suites.error && <ErrorState error={suites.error} retry={() => void suites.refetch()} />}
      {noSuites ? (
        <EmptyState
          icon={FlaskConical}
          title="Create your first suite"
          action={ws.can("editor") ? <Button onClick={() => setDialog("suite")}>New suite</Button> : undefined}
        >
          A suite groups related tests and sets the environment they run against.
        </EmptyState>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[240px_1fr]">
          <nav aria-label="Suites" className="space-y-0.5 lg:sticky lg:top-20 lg:self-start">
            <div className="eyebrow mb-2 px-2.5">Suites</div>
            {[{ id: undefined as number | undefined, name: "All tests", caseCount: cases.data?.length ?? 0 }, ...(suites.data ?? [])].map((s) => (
              <button
                key={s.id ?? "all"}
                onClick={() => setQ({ suite: s.id ? String(s.id) : "" })}
                aria-current={suiteId === s.id ? "true" : undefined}
                className={cn("flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors", suiteId === s.id ? "bg-surface font-medium shadow-sm ring-1 ring-border" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground")}
              >
                <span className="truncate">{s.name}</span>
                <span className="tabular text-xs text-subtle">{s.caseCount}</span>
              </button>
            ))}
          </nav>

          <div className="min-w-0">
            <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" aria-hidden />
                <Input value={q.q} onChange={(e) => setQ({ q: e.target.value })} placeholder="Search by name, description or tag" className="pl-9" aria-label="Search tests" />
              </div>
              {selectedSuite && ws.can("runner") && (
                <Button variant="outline" onClick={() => run.mutate({ suiteId: selectedSuite.id })} disabled={run.isPending}>
                  <Play className="mr-2 h-4 w-4" /> Run suite
                </Button>
              )}
            </div>
            {selectedSuite && (
              <p className="mb-3 text-sm text-muted-foreground">
                {selectedSuite.description ? `${selectedSuite.description} · ` : ""}
                Environment: {selectedSuite.environmentName ?? "none"} · 7-day pass rate {selectedSuite.finished7d ? percent(selectedSuite.passed7d / selectedSuite.finished7d) : "—"}
              </p>
            )}

            {cases.isLoading ? (
              <TableSkeleton />
            ) : !visible.length ? (
              <EmptyState icon={FlaskConical} title={q.q ? "No tests match" : "No tests here yet"} action={!q.q && ws.can("editor") ? <Button onClick={() => setDialog("test")}>New test</Button> : undefined}>
                {q.q ? "Try a different search." : "Create a test and add its steps in the builder."}
              </EmptyState>
            ) : (
              <ul className="surface divide-y" aria-label="Tests">
                {visible.map((c) => (
                  <li key={c.id} className="group flex items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/40">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="grid h-5 w-5 place-items-center">
                          <StatusDot status={c.lastRun?.status} />
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>{c.lastRun ? `Last run ${c.lastRun.status.replace("_", " ")}` : "Never run"}</TooltipContent>
                    </Tooltip>
                    <Link href={`/tests/${c.id}`} className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium">{c.name}</span>
                        {c.needsReview && <span className="shrink-0 rounded bg-warning-soft px-1.5 py-0.5 text-[11px] font-medium text-warning">Needs review</span>}
                        {!c.isActive && <span className="shrink-0 rounded bg-neutral-soft px-1.5 py-0.5 text-[11px] text-muted-foreground">Off</span>}
                        {c.priority === "critical" && <span className="shrink-0 rounded bg-danger-soft px-1.5 py-0.5 text-[11px] font-medium text-danger">Critical</span>}
                      </span>
                      <span className="mt-0.5 flex items-center gap-2 truncate text-xs text-muted-foreground">
                        {!suiteId && <span className="truncate">{c.suiteName}</span>}
                        {!suiteId && <span aria-hidden>·</span>}
                        <span>{c.stepCount} steps</span>
                        <span aria-hidden>·</span>
                        <span>{c.publishedVersion ? `v${c.publishedVersion}` : "Draft"}</span>
                        {c.schedule && (
                          <>
                            <span aria-hidden>·</span>
                            <span className="flex items-center gap-1">
                              {c.schedule.paused ? <Pause className="h-3 w-3" aria-hidden /> : <CalendarClock className="h-3 w-3" aria-hidden />}
                              {describeCron(c.schedule.cron)}
                              {c.schedule.paused && " (paused)"}
                            </span>
                          </>
                        )}
                      </span>
                    </Link>
                    <span className="hidden w-28 text-right text-xs text-muted-foreground md:block">{c.lastRun ? <TimeAgo iso={c.lastRun.createdAt} exact={dateTime(c.lastRun.createdAt, ws.timezone)} /> : "Never run"}</span>
                    {ws.can("runner") && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`Run ${c.name}`} disabled={!c.publishedVersion || run.isPending} onClick={() => run.mutate({ caseId: c.id })}>
                            <Play className="h-4 w-4" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>{c.publishedVersion ? `Run version ${c.publishedVersion}` : "Publish before running"}</TooltipContent>
                      </Tooltip>
                    )}
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`More actions for ${c.name}`}>
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => navigate(`/runs?caseId=${c.id}`)}>See runs</DropdownMenuItem>
                        <DropdownMenuItem onSelect={async () => downloadJson(c.name, await get(`${ws.base}/cases/${c.id}/export`))}>
                          <Download className="mr-2 h-4 w-4" /> Export
                        </DropdownMenuItem>
                        {ws.can("editor") && (
                          <>
                            <DropdownMenuItem onSelect={() => duplicate.mutate(c.id)}>
                              <Copy className="mr-2 h-4 w-4" /> Duplicate
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <Confirm
                              trigger={
                                <DropdownMenuItem onSelect={(e) => e.preventDefault()} className="text-danger focus:text-danger">
                                  <Trash2 className="mr-2 h-4 w-4" /> Delete
                                </DropdownMenuItem>
                              }
                              title={`Delete “${c.name}”?`}
                              description="Its versions, schedules and run history are deleted too. This can't be undone. Export it first if you might need it."
                              confirmLabel="Delete test"
                              destructive
                              onConfirm={() => remove.mutateAsync(c.id)}
                            />
                          </>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
      {dialog === "suite" && <SuiteDialog open onOpenChange={(v) => !v && setDialog(null)} />}
      {dialog === "test" && suites.data && <NewTestDialog open onOpenChange={(v) => !v && setDialog(null)} suites={suites.data} defaultSuite={suiteId} />}
      {dialog === "import" && suites.data && <ImportDialog open onOpenChange={(v) => !v && setDialog(null)} suites={suites.data} defaultSuite={suiteId} />}
    </>
  );
}
