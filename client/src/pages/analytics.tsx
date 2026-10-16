import { useMemo } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { BarChart3 } from "lucide-react";
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip as ChartTooltip, XAxis, YAxis } from "recharts";
import { ACTIONS } from "@shared/steps";
import { useWorkspace } from "@/hooks/session";
import { useUrlState } from "@/hooks/url-state";
import type { CaseStats, Overview } from "@/lib/types";
import { dateTime, duration, percent } from "@/lib/format";
import { EmptyState, ErrorState, PageHeader, Skeleton, TimeAgo } from "@/components/common";
import { Segmented } from "@/components/segmented";

const axis = { tickLine: false, axisLine: false, tick: { fontSize: 11, fill: "hsl(var(--subtle-foreground))" } } as const;
const tip = { contentStyle: { background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12 } };

type FailingStep = { caseId: number; caseName: string; stepIndex: number; stepName: string; action: string; failures: number; lastFailedAt: string; lastError: string | null };

export default function AnalyticsPage() {
  const ws = useWorkspace();
  const [q, setQ] = useUrlState({ range: "30d" });
  const overview = useQuery<Overview>({ queryKey: [ws.base, `analytics/overview?range=${q.range}`] });
  const cases = useQuery<{ cases: CaseStats[] }>({ queryKey: [ws.base, `analytics/cases?range=${q.range}`] });
  const steps = useQuery<FailingStep[]>({ queryKey: [ws.base, `analytics/failing-steps?range=${q.range}`] });

  const rate = useMemo(
    () =>
      (overview.data?.trend ?? []).map((t) => {
        const judged = t.passed + t.failed;
        return { label: dateTime(t.t, "UTC", q.range === "24h" ? { hour: "numeric" } : { month: "short", day: "numeric" }), rate: judged ? Math.round((t.passed / judged) * 1000) / 10 : null, runs: judged };
      }),
    [overview.data, q.range],
  );
  const slowest = useMemo(
    () =>
      (cases.data?.cases ?? [])
        .filter((c) => c.p95Ms)
        .sort((a, b) => (b.p95Ms ?? 0) - (a.p95Ms ?? 0))
        .slice(0, 8)
        .map((c) => ({ name: c.name.length > 28 ? c.name.slice(0, 27) + "…" : c.name, p50: Math.round((c.p50Ms ?? 0) / 100) / 10, p95: Math.round((c.p95Ms ?? 0) / 100) / 10 })),
    [cases.data],
  );
  const bySuite = useMemo(() => {
    const m = new Map<string, { suite: string; passed: number; failed: number; infra: number }>();
    for (const c of cases.data?.cases ?? []) {
      const s = m.get(c.suiteName) ?? { suite: c.suiteName, passed: 0, failed: 0, infra: 0 };
      s.passed += c.passed;
      s.failed += c.failed;
      s.infra += c.infra;
      m.set(c.suiteName, s);
    }
    return [...m.values()].sort((a, b) => b.failed - a.failed);
  }, [cases.data]);

  const err = overview.error || cases.error;
  return (
    <>
      <PageHeader
        title="Analytics"
        description="Trends across all tests, computed from stored runs. Infrastructure errors are excluded from pass rates."
        actions={<Segmented label="Period" value={q.range!} onChange={(range) => setQ({ range })} options={[{ value: "7d", label: "7 days" }, { value: "30d", label: "30 days" }, { value: "90d", label: "90 days" }]} />}
      />
      {err ? (
        <ErrorState error={err} />
      ) : !overview.data || !cases.data ? (
        <div className="grid gap-6 lg:grid-cols-2">
          <Skeleton className="h-72 rounded-lg" />
          <Skeleton className="h-72 rounded-lg" />
        </div>
      ) : !overview.data.totals.judged && !overview.data.totals.infrastructure_error ? (
        <EmptyState icon={BarChart3} title="No runs in this period">Charts appear once tests have run.</EmptyState>
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          <section className="surface p-5" aria-labelledby="rate-h">
            <h2 id="rate-h" className="text-[15px] font-medium">Pass rate by day</h2>
            <p className="mb-4 text-xs text-muted-foreground">Overall {percent(overview.data.totals.passRate)} across {overview.data.totals.judged} runs.</p>
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={rate} margin={{ top: 4, right: 8, bottom: 0, left: -18 }}>
                  <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeDasharray="3 3" />
                  <XAxis dataKey="label" {...axis} minTickGap={16} />
                  <YAxis domain={[0, 100]} {...axis} tickFormatter={(v) => `${v}%`} />
                  <ChartTooltip {...tip} formatter={(v: number, _n, p) => [`${v}% (${(p.payload as { runs: number }).runs} runs)`, "Pass rate"]} />
                  <Line type="monotone" dataKey="rate" stroke="hsl(var(--chart-1))" strokeWidth={2} dot={{ r: 2.5 }} connectNulls />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </section>

          <section className="surface p-5" aria-labelledby="slow-h">
            <h2 id="slow-h" className="text-[15px] font-medium">Slowest tests</h2>
            <p className="mb-4 text-xs text-muted-foreground">Median and 95th percentile duration of passing runs, in seconds.</p>
            {slowest.length ? (
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={slowest} layout="vertical" margin={{ top: 0, right: 8, bottom: 0, left: 8 }} barGap={2} maxBarSize={14}>
                    <CartesianGrid horizontal={false} stroke="hsl(var(--border))" strokeDasharray="3 3" />
                    <XAxis type="number" {...axis} />
                    <YAxis type="category" dataKey="name" width={150} {...axis} />
                    <ChartTooltip {...tip} cursor={{ fill: "hsl(var(--muted))" }} formatter={(v: number, n) => [`${v}s`, n === "p50" ? "Median" : "95th percentile"]} />
                    <Bar dataKey="p50" fill="hsl(var(--chart-4))" radius={[0, 3, 3, 0]} />
                    <Bar dataKey="p95" fill="hsl(var(--chart-5))" radius={[0, 3, 3, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <p className="py-10 text-center text-sm text-muted-foreground">No passing runs yet.</p>
            )}
          </section>

          <section className="surface lg:col-span-2" aria-labelledby="steps-h">
            <div className="border-b px-5 py-4">
              <h2 id="steps-h" className="text-[15px] font-medium">Steps that fail most</h2>
              <p className="text-xs text-muted-foreground">Where failures happen, so fixes go to the right place.</p>
            </div>
            {steps.data?.length ? (
              <ul className="divide-y">
                {steps.data.map((s) => (
                  <li key={`${s.caseId}-${s.stepIndex}`} className="flex items-start gap-4 px-5 py-3">
                    <span className="tabular mt-0.5 w-10 shrink-0 text-right text-sm font-medium text-danger">{s.failures}×</span>
                    <span className="min-w-0 flex-1">
                      <Link href={`/tests/${s.caseId}`} className="block truncate text-sm font-medium hover:underline">
                        {s.caseName} · step {s.stepIndex}: {s.stepName}
                      </Link>
                      <span className="block truncate text-xs text-muted-foreground">
                        {ACTIONS[s.action as keyof typeof ACTIONS]?.label ?? s.action} · last <TimeAgo iso={s.lastFailedAt} /> {s.lastError ? `· ${s.lastError}` : ""}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-5 py-8 text-center text-sm text-muted-foreground">No step failures in this period.</p>
            )}
          </section>

          <section className="surface lg:col-span-2" aria-labelledby="suite-h">
            <div className="border-b px-5 py-4">
              <h2 id="suite-h" className="text-[15px] font-medium">By suite</h2>
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="px-5 py-2.5 font-medium">Suite</th>
                  <th className="px-3 py-2.5 text-right font-medium">Passed</th>
                  <th className="px-3 py-2.5 text-right font-medium">Failed</th>
                  <th className="px-3 py-2.5 text-right font-medium">Infra errors</th>
                  <th className="px-5 py-2.5 text-right font-medium">Pass rate</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {bySuite.map((s) => (
                  <tr key={s.suite}>
                    <td className="px-5 py-2.5 font-medium">{s.suite}</td>
                    <td className="tabular px-3 py-2.5 text-right">{s.passed}</td>
                    <td className="tabular px-3 py-2.5 text-right">{s.failed}</td>
                    <td className="tabular px-3 py-2.5 text-right text-muted-foreground">{s.infra}</td>
                    <td className="tabular px-5 py-2.5 text-right">{s.passed + s.failed ? percent(s.passed / (s.passed + s.failed)) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <p className="text-xs text-muted-foreground lg:col-span-2">Median passing duration across all tests: {duration(overview.data.totals.p50_ms)}. Need the raw data? <Link href="/reports" className="underline underline-offset-2">Export it from Reports</Link>.</p>
        </div>
      )}
    </>
  );
}
