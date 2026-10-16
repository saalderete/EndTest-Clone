import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, HeartPulse, Info } from "lucide-react";
import { useWorkspace } from "@/hooks/session";
import { useUrlState } from "@/hooks/url-state";
import type { CaseStats } from "@/lib/types";
import { dateTime, duration, percent } from "@/lib/format";
import { cn } from "@/lib/utils";
import { EmptyState, ErrorState, PageHeader, StatusDot, TableSkeleton, TimeAgo } from "@/components/common";
import { Segmented } from "@/components/segmented";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

type SortKey = "name" | "passRate" | "consecutiveFailures" | "flakiness" | "p95Ms" | "runs";

export const isFlaky = (c: CaseStats) => c.flakiness !== null && c.flakiness >= 0.3 && (c.flipWindow ?? 0) >= 4;

export default function HealthPage() {
  const ws = useWorkspace();
  const [q, setQ] = useUrlState({ range: "7d", problems: "", sort: "consecutiveFailures", dir: "desc" });
  const { data, error, isLoading, refetch } = useQuery<{ cases: CaseStats[]; generatedAt: string }>({ queryKey: [ws.base, `analytics/cases?range=${q.range}`] });
  const [showFormula, setShowFormula] = useState(false);
  const rows = useMemo(() => {
    let r = data?.cases ?? [];
    if (q.problems) r = r.filter((c) => c.consecutiveFailures > 0 || isFlaky(c) || c.needsReview || c.warnings > 0);
    const key = q.sort as SortKey;
    const dir = q.dir === "asc" ? 1 : -1;
    return [...r].sort((a, b) => {
      const av = a[key] ?? (key === "name" ? "" : -1);
      const bv = b[key] ?? (key === "name" ? "" : -1);
      return (av < bv ? -1 : av > bv ? 1 : 0) * dir;
    });
  }, [data, q.problems, q.sort, q.dir]);

  const Th = ({ k, children, className }: { k: SortKey; children: React.ReactNode; className?: string }) => (
    <th className={cn("px-3 py-2.5 font-medium", className)} aria-sort={q.sort === k ? (q.dir === "asc" ? "ascending" : "descending") : "none"}>
      <button className="inline-flex items-center gap-1 hover:text-foreground" onClick={() => setQ({ sort: k, dir: q.sort === k && q.dir === "desc" ? "asc" : "desc" })}>
        {children}
        {q.sort === k && (q.dir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
      </button>
    </th>
  );

  return (
    <>
      <PageHeader
        title="Test health"
        description="Which tests are failing, slowing down or flipping between pass and fail."
        actions={<Segmented label="Period" value={q.range!} onChange={(range) => setQ({ range })} options={[{ value: "7d", label: "7 days" }, { value: "30d", label: "30 days" }, { value: "90d", label: "90 days" }]} />}
      />
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={!!q.problems} onCheckedChange={(v) => setQ({ problems: v ? "1" : "" })} /> Only tests with problems
        </label>
        <button onClick={() => setShowFormula((v) => !v)} className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground" aria-expanded={showFormula}>
          <Info className="h-4 w-4" /> How these are calculated
        </button>
      </div>
      {showFormula && (
        <div className="surface mb-4 space-y-1.5 p-4 text-sm text-muted-foreground">
          <p><span className="font-medium text-foreground">Pass rate</span> = passed ÷ (passed + failed + timed out) in the period. Infrastructure errors and cancellations are left out: they say nothing about the application.</p>
          <p><span className="font-medium text-foreground">Failures in a row</span> = failed or timed-out runs since the last pass.</p>
          <p><span className="font-medium text-foreground">Flakiness</span> = how often the result flipped between pass and fail across the last 20 finished runs, divided by the number of comparisons. A test is flagged flaky at 0.30 or more, with at least 5 runs.</p>
          <p><span className="font-medium text-foreground">Durations</span> are of passing runs; failed runs stop early and would make tests look faster.</p>
        </div>
      )}
      {error ? (
        <ErrorState error={error} retry={() => void refetch()} />
      ) : isLoading ? (
        <TableSkeleton rows={8} />
      ) : !rows.length ? (
        <EmptyState icon={HeartPulse} title={q.problems ? "No problems found" : "No tests yet"}>
          {q.problems ? "Every test is passing consistently in this period." : "Create and run tests to see their health."}
        </EmptyState>
      ) : (
        <div className="surface overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <Th k="name" className="w-[45%] min-w-[160px] pl-4">Test</Th>
                <Th k="passRate" className="text-right">Pass rate</Th>
                <Th k="consecutiveFailures" className="text-right">In a row</Th>
                <Th k="flakiness" className="text-right">Flakiness</Th>
                <Th k="p95Ms" className="hidden text-right lg:table-cell">P50 / P95</Th>
                <Th k="runs" className="hidden text-right md:table-cell">Runs</Th>
                <th className="hidden px-3 py-2.5 text-right font-medium md:table-cell">Last pass</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((c) => (
                <tr key={c.caseId} className="hover:bg-muted/30">
                  <td className="max-w-0 py-3 pl-4 pr-3">
                    <Link href={`/tests/${c.caseId}`} className="flex items-center gap-2.5">
                      <StatusDot status={c.lastStatus} />
                      <span className="min-w-0">
                        <span className="flex items-center gap-1.5">
                          <span className="truncate font-medium">{c.name}</span>
                          {c.needsReview && <span className="shrink-0 rounded bg-warning-soft px-1 text-[10.5px] font-medium text-warning">Review</span>}
                          {isFlaky(c) && <span className="shrink-0 rounded bg-warning-soft px-1 text-[10.5px] font-medium text-warning">Flaky</span>}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {c.suiteName}
                          {c.passedOnRetry ? ` · ${c.passedOnRetry} passed on retry` : ""}
                          {c.warnings ? ` · ${c.warnings} warnings` : ""}
                        </span>
                      </span>
                    </Link>
                  </td>
                  <td className="px-3 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <span className={cn("tabular", c.passRate !== null && c.passRate < 0.9 && "font-medium text-danger")}>{percent(c.passRate, 0)}</span>
                      <span className="hidden h-1.5 w-14 overflow-hidden rounded-full bg-danger/20 sm:block" aria-hidden>
                        {c.passRate !== null && <span className="block h-full bg-success" style={{ width: `${c.passRate * 100}%` }} />}
                      </span>
                    </div>
                  </td>
                  <td className={cn("tabular px-3 py-3 text-right", c.consecutiveFailures > 0 && "font-medium text-danger")}>{c.consecutiveFailures || "—"}</td>
                  <td className="px-3 py-3 text-right">
                    {c.flakiness === null ? (
                      <span className="text-subtle">—</span>
                    ) : (
                      <Tooltip>
                        <TooltipTrigger className={cn("tabular", isFlaky(c) && "font-medium text-warning")}>{c.flakiness.toFixed(2)}</TooltipTrigger>
                        <TooltipContent>
                          {c.flips} flips in {c.flipWindow} comparisons
                        </TooltipContent>
                      </Tooltip>
                    )}
                  </td>
                  <td className="tabular hidden px-3 py-3 text-right text-muted-foreground lg:table-cell">
                    {duration(c.p50Ms)} / {duration(c.p95Ms)}
                  </td>
                  <td className="tabular hidden px-3 py-3 text-right text-muted-foreground md:table-cell">{c.runs}</td>
                  <td className="hidden whitespace-nowrap px-3 py-3 text-right text-muted-foreground md:table-cell">{c.lastPassAt ? <TimeAgo iso={c.lastPassAt} exact={dateTime(c.lastPassAt, ws.timezone)} /> : "never"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
