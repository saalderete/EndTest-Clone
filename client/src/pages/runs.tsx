import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { Activity, X } from "lucide-react";
import { useWorkspace } from "@/hooks/session";
import { useUrlState } from "@/hooks/url-state";
import { get } from "@/lib/api";
import type { CaseSummary, RunSummary } from "@/lib/types";
import { dateTime, duration } from "@/lib/format";
import { EmptyState, ErrorState, PageHeader, StatusBadge, TableSkeleton, TimeAgo } from "@/components/common";
import { Segmented } from "@/components/segmented";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const TRIGGERS: Record<string, string> = { manual: "Manual", schedule: "Schedule", api: "API" };

export default function RunsPage() {
  const ws = useWorkspace();
  const [, navigate] = useLocation();
  const [q, setQ] = useUrlState({ outcome: "all", trigger: "all", caseId: "" });
  const params = new URLSearchParams({ limit: "50" });
  if (q.outcome !== "all") params.set("outcome", q.outcome!);
  if (q.trigger !== "all") params.set("trigger", q.trigger!);
  if (q.caseId) params.set("caseId", q.caseId);
  const runs = useInfiniteQuery({
    queryKey: [ws.base, "runs", params.toString()],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => get<{ items: RunSummary[]; nextBefore: number | null }>(`${ws.base}/runs?${params}${pageParam ? `&before=${pageParam}` : ""}`),
    getNextPageParam: (last) => last.nextBefore ?? undefined,
    refetchInterval: (query) => (query.state.data?.pages[0]?.items.some((r) => ["queued", "starting", "running", "cancel_requested"].includes(r.status)) ? 3000 : 20_000),
  });
  const cases = useQuery<CaseSummary[]>({ queryKey: [ws.base, "cases"], enabled: !!q.caseId });
  const filteredCase = cases.data?.find((c) => String(c.id) === q.caseId);
  const items = runs.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <>
      <PageHeader title="Runs" description={`Every run, newest first. Times in ${ws.timezone}.`} />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Segmented
          label="Result"
          value={q.outcome!}
          onChange={(outcome) => setQ({ outcome })}
          options={[
            { value: "all", label: "All" },
            { value: "failed", label: "Failed" },
            { value: "passed", label: "Passed" },
            { value: "active", label: "In progress" },
          ]}
        />
        <Select value={q.trigger} onValueChange={(trigger) => setQ({ trigger })}>
          <SelectTrigger className="h-9 w-40" aria-label="Trigger">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Any trigger</SelectItem>
            {Object.entries(TRIGGERS).map(([k, v]) => (
              <SelectItem key={k} value={k}>
                {v}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {q.caseId && (
          <span className="inline-flex items-center gap-1 rounded-full border bg-surface py-1 pl-3 pr-1 text-sm">
            {filteredCase?.name ?? `Test #${q.caseId}`}
            <button className="rounded-full p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Clear test filter" onClick={() => setQ({ caseId: "" })}>
              <X className="h-3.5 w-3.5" />
            </button>
          </span>
        )}
      </div>
      {runs.error ? (
        <ErrorState error={runs.error} retry={() => void runs.refetch()} />
      ) : runs.isLoading ? (
        <TableSkeleton rows={10} />
      ) : !items.length ? (
        <EmptyState icon={Activity} title="No runs match">
          {q.outcome !== "all" || q.trigger !== "all" || q.caseId ? "Try clearing the filters." : "Runs appear here when tests run, by hand or on a schedule."}
        </EmptyState>
      ) : (
        <div className="surface overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="px-4 py-2.5 font-medium">Result</th>
                <th className="px-4 py-2.5 font-medium">Test</th>
                <th className="hidden px-4 py-2.5 font-medium md:table-cell">Trigger</th>
                <th className="hidden px-4 py-2.5 text-right font-medium sm:table-cell">Duration</th>
                <th className="px-4 py-2.5 text-right font-medium">When</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {items.map((r) => (
                <tr
                  key={r.id}
                  tabIndex={0}
                  onClick={() => navigate(`/runs/${r.id}`)}
                  onKeyDown={(e) => e.key === "Enter" && navigate(`/runs/${r.id}`)}
                  className="cursor-pointer transition-colors hover:bg-muted/40 focus-visible:bg-muted/50 focus-visible:outline-none"
                >
                  <td className="whitespace-nowrap px-4 py-3">
                    <StatusBadge status={r.status} />
                  </td>
                  <td className="max-w-0 px-4 py-3">
                    <Link href={`/runs/${r.id}`} className="block truncate font-medium" onClick={(e) => e.stopPropagation()}>
                      {r.caseName}
                    </Link>
                    <span className="block truncate text-xs text-muted-foreground">
                      {r.suiteName}
                      {r.caseVersion ? ` · v${r.caseVersion}` : ""}
                      {r.attempt > 1 ? ` · attempt ${r.attempt}/${r.maxAttempts}` : ""}
                      {r.warnings ? ` · ${r.warnings} warning${r.warnings > 1 ? "s" : ""}` : ""}
                      {r.errorMessage && ["failed", "timed_out", "infrastructure_error"].includes(r.status) ? ` · ${r.errorMessage}` : ""}
                    </span>
                  </td>
                  <td className="hidden whitespace-nowrap px-4 py-3 text-muted-foreground md:table-cell">
                    {TRIGGERS[r.trigger]}
                    {r.requestedBy && <span className="block text-xs">{r.requestedBy}</span>}
                  </td>
                  <td className="hidden whitespace-nowrap px-4 py-3 text-right tabular text-muted-foreground sm:table-cell">{duration(r.duration)}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-right text-muted-foreground">
                    <TimeAgo iso={r.createdAt} exact={dateTime(r.createdAt, ws.timezone)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {runs.hasNextPage && (
            <div className="border-t p-3 text-center">
              <Button variant="ghost" size="sm" onClick={() => void runs.fetchNextPage()} disabled={runs.isFetchingNextPage}>
                {runs.isFetchingNextPage ? "Loading…" : "Load older runs"}
              </Button>
            </div>
          )}
        </div>
      )}
    </>
  );
}
