// On-demand reports from stored runs: a printable summary plus CSV/JSON exports.
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, FileText, Printer } from "lucide-react";
import { useWorkspace } from "@/hooks/session";
import { useUrlState } from "@/hooks/url-state";
import type { Environment } from "@/lib/types";
import { dateTime, duration, percent } from "@/lib/format";
import { EmptyState, ErrorState, Field, PageHeader, Skeleton } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Logo } from "@/components/shell";

type Summary = {
  workspace: { name: string; timezone: string };
  period: { from: string; to: string };
  generatedAt: string;
  generatedBy: string;
  totals: { total: number; passed: number; failed: number; infra: number; cancelled: number; p95_ms: number | null; passRate: number | null };
  cases: { name: string; suite: string; priority: string; runs: number; passed: number; failed: number; infra: number; p50_ms: number | null }[];
  incidents: { caseName: string; openedAt: string; resolvedAt: string | null; consecutiveFailures: number }[];
};

const day = (d: Date) => d.toISOString().slice(0, 10);

function presetRange(p: string): { from: string; to: string } {
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const tomorrow = new Date(today.getTime() + 86400_000);
  switch (p) {
    case "7d":
      return { from: day(new Date(today.getTime() - 6 * 86400_000)), to: day(tomorrow) };
    case "month":
      return { from: day(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1))), to: day(tomorrow) };
    case "last-month":
      return { from: day(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1))), to: day(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1))) };
    default:
      return { from: day(new Date(today.getTime() - 29 * 86400_000)), to: day(tomorrow) };
  }
}

export default function ReportsPage() {
  const ws = useWorkspace();
  const initial = presetRange("30d");
  const [q, setQ] = useUrlState({ from: initial.from, to: initial.to, env: "" });
  const envs = useQuery<Environment[]>({ queryKey: [ws.base, "environments"] });
  const params = useMemo(() => {
    const p = new URLSearchParams({ from: `${q.from}T00:00:00Z`, to: `${q.to}T00:00:00Z` });
    if (q.env) p.set("environmentId", q.env);
    return p.toString();
  }, [q.from, q.to, q.env]);
  const summary = useQuery<Summary>({ queryKey: [ws.base, `reports/summary?${params}`], enabled: !!q.from && !!q.to && q.from < q.to! });
  const s = summary.data;
  const envName = envs.data?.find((e) => String(e.id) === q.env)?.name;

  return (
    <>
      <div className="no-print">
        <PageHeader title="Reports" description="Generated on demand from stored runs. Print the summary (or save it as PDF), or download every run as CSV or JSON." />
        <div className="surface mb-6 flex flex-wrap items-end gap-4 p-4">
          <div className="flex flex-wrap gap-1.5">
            {[
              ["7d", "Last 7 days"],
              ["30d", "Last 30 days"],
              ["month", "This month"],
              ["last-month", "Last month"],
            ].map(([k, label]) => (
              <Button key={k} variant="outline" size="sm" onClick={() => setQ(presetRange(k))}>
                {label}
              </Button>
            ))}
          </div>
          <Field label="From" htmlFor="r-from">
            <Input id="r-from" type="date" value={q.from} onChange={(e) => setQ({ from: e.target.value })} className="w-40" />
          </Field>
          <Field label="To (exclusive)" htmlFor="r-to">
            <Input id="r-to" type="date" value={q.to} onChange={(e) => setQ({ to: e.target.value })} className="w-40" />
          </Field>
          <Field label="Environment">
            <Select value={q.env || "all"} onValueChange={(v) => setQ({ env: v === "all" ? "" : v })}>
              <SelectTrigger className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All environments</SelectItem>
                {envs.data?.map((e) => (
                  <SelectItem key={e.id} value={String(e.id)}>
                    {e.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <div className="ml-auto flex flex-wrap gap-2">
            <Button variant="outline" asChild>
              <a href={`${ws.base}/reports/runs.csv?${params}`} download>
                <Download className="mr-2 h-4 w-4" /> CSV
              </a>
            </Button>
            <Button variant="outline" asChild>
              <a href={`${ws.base}/reports/runs.json?${params}`} download>
                <Download className="mr-2 h-4 w-4" /> JSON
              </a>
            </Button>
            <Button onClick={() => window.print()} disabled={!s}>
              <Printer className="mr-2 h-4 w-4" /> Print or save PDF
            </Button>
          </div>
        </div>
      </div>

      {q.from >= q.to! ? (
        <ErrorState error={new Error("The end date must be after the start date.")} />
      ) : summary.error ? (
        <ErrorState error={summary.error} retry={() => void summary.refetch()} />
      ) : !s ? (
        <Skeleton className="h-96 rounded-lg" />
      ) : (
        <article className="surface mx-auto max-w-4xl p-8 print:border-0 print:p-0 print:shadow-none">
          <header className="flex items-start justify-between border-b pb-6">
            <div>
              <div className="eyebrow">Test report</div>
              <h2 className="mt-1 text-2xl font-semibold tracking-[-0.01em]">{s.workspace.name}</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {dateTime(s.period.from, "UTC", { dateStyle: "long" })} – {dateTime(new Date(new Date(s.period.to).getTime() - 1).toISOString(), "UTC", { dateStyle: "long" })}
                {envName ? ` · ${envName}` : " · all environments"}
              </p>
            </div>
            <Logo className="text-sm text-muted-foreground" />
          </header>
          {!s.totals.total ? (
            <div className="py-10">
              <EmptyState icon={FileText} title="No runs in this period" />
            </div>
          ) : (
            <>
              <dl className="grid grid-cols-2 gap-6 border-b py-6 sm:grid-cols-4">
                {[
                  ["Pass rate", percent(s.totals.passRate)],
                  ["Runs", String(s.totals.total)],
                  ["Failed", String(s.totals.failed)],
                  ["P95 duration", duration(s.totals.p95_ms)],
                ].map(([k, v]) => (
                  <div key={k}>
                    <dt className="eyebrow">{k}</dt>
                    <dd className="tabular mt-1.5 text-2xl font-semibold">{v}</dd>
                  </div>
                ))}
              </dl>
              <p className="pt-3 text-xs text-muted-foreground">
                Pass rate = passed ÷ (passed + failed or timed out). {s.totals.infra} infrastructure errors and {s.totals.cancelled} cancelled runs are excluded.
              </p>
              <h3 className="mt-6 text-[15px] font-semibold">By test</h3>
              <table className="mt-2 w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="py-2 font-medium">Test</th>
                    <th className="py-2 text-right font-medium">Runs</th>
                    <th className="py-2 text-right font-medium">Passed</th>
                    <th className="py-2 text-right font-medium">Failed</th>
                    <th className="py-2 text-right font-medium">Pass rate</th>
                    <th className="py-2 text-right font-medium">Median</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {s.cases.map((c) => (
                    <tr key={`${c.suite}/${c.name}`} className="break-inside-avoid">
                      <td className="py-2 pr-3">
                        <span className="font-medium">{c.name}</span>
                        <span className="block text-xs text-muted-foreground">{c.suite}</span>
                      </td>
                      <td className="tabular py-2 text-right">{c.runs}</td>
                      <td className="tabular py-2 text-right">{c.passed}</td>
                      <td className="tabular py-2 text-right">{c.failed}</td>
                      <td className="tabular py-2 text-right">{c.passed + c.failed ? percent(c.passed / (c.passed + c.failed), 0) : "—"}</td>
                      <td className="tabular py-2 text-right">{duration(c.p50_ms)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <h3 className="mt-8 text-[15px] font-semibold">Incidents</h3>
              {s.incidents.length ? (
                <ul className="mt-2 divide-y text-sm">
                  {s.incidents.map((i, n) => (
                    <li key={n} className="flex justify-between gap-3 py-2">
                      <span className="font-medium">{i.caseName}</span>
                      <span className="text-right text-muted-foreground">
                        {dateTime(i.openedAt, ws.timezone)} → {i.resolvedAt ? dateTime(i.resolvedAt, ws.timezone) : "still open"} · {i.consecutiveFailures} failures
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-sm text-muted-foreground">No incidents in this period.</p>
              )}
            </>
          )}
          <footer className="mt-8 border-t pt-4 text-xs text-muted-foreground">
            Generated {dateTime(s.generatedAt, ws.timezone)} ({ws.timezone}) by {s.generatedBy} from stored run records.
          </footer>
        </article>
      )}
    </>
  );
}
