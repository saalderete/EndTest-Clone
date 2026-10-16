import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { ArrowRight, CheckCircle2, Circle, CircleCheck, FlaskConical, Loader2, OctagonX, RefreshCw } from "lucide-react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip as ChartTooltip, XAxis, YAxis } from "recharts";
import { useWorkspace } from "@/hooks/session";
import { useUrlState } from "@/hooks/url-state";
import type { Checks, Overview, RunSummary } from "@/lib/types";
import { dateTime, duration, number, percent, tzLabel } from "@/lib/format";
import { EmptyState, ErrorState, PageHeader, Skeleton, Stat, StatusBadge, TimeAgo } from "@/components/common";
import { Segmented } from "@/components/segmented";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

function SetupChecklist() {
  const ws = useWorkspace();
  const { data } = useQuery<Checks>({ queryKey: [ws.base, "checks"], refetchInterval: 20_000 });
  if (!data) return null;
  const items = [
    { done: data.hasEnvironment, label: "Add an environment", detail: "The site to test and the hosts it may visit.", href: "/settings/environments", show: ws.can("admin") },
    { done: data.hasSuite, label: "Create a suite", detail: "A group of related tests.", href: "/tests" },
    { done: data.hasPublishedTest, label: "Publish your first test", detail: "Runs and schedules always use a published version.", href: "/tests" },
    { done: data.workerOnline, label: "Test runner online", detail: data.workerOnline ? (data.browserOk ? "A worker is connected and its browser started." : "A worker is connected but its browser didn't start.") : "No worker has checked in during the last minute. Start one with npm run worker." },
    { done: data.notifications.enabled && data.notifications.email, label: "Email alerts", detail: data.notifications.enabled ? (data.notifications.email ? "Ready." : "Notifications are on, but SMTP isn't configured.") : "Off on this server (NOTIFICATIONS_ENABLED). Alerts are recorded but not sent." },
  ].filter((i) => i.show !== false);
  if (items.every((i) => i.done)) return null;
  const done = items.filter((i) => i.done).length;
  return (
    <section className="surface mb-6 p-5" aria-labelledby="setup">
      <div className="flex items-center justify-between">
        <h2 id="setup" className="text-[15px] font-medium">Finish setting up</h2>
        <span className="text-xs text-muted-foreground tabular">
          {done} of {items.length} done
        </span>
      </div>
      <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-brand transition-[width] duration-500 ease-out" style={{ width: `${(done / items.length) * 100}%` }} />
      </div>
      <ul className="mt-4 grid gap-1 sm:grid-cols-2">
        {items.map((i) => {
          const body = (
            <>
              {i.done ? <CircleCheck className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden /> : <Circle className="mt-0.5 h-4 w-4 shrink-0 text-subtle" aria-hidden />}
              <span className="min-w-0">
                <span className={cn("block text-sm", i.done ? "text-muted-foreground line-through decoration-border-strong" : "font-medium")}>{i.label}</span>
                <span className="block text-xs text-muted-foreground">{i.detail}</span>
              </span>
            </>
          );
          return (
            <li key={i.label}>
              {i.href && !i.done ? (
                <Link href={i.href} className="flex gap-2.5 rounded-md p-2 transition-colors hover:bg-muted/60">
                  {body}
                </Link>
              ) : (
                <div className="flex gap-2.5 p-2">{body}</div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function HealthBanner({ data }: { data: Overview }) {
  const failing = data.openIncidents;
  if (failing.length)
    return (
      <div className="mb-6 flex flex-col gap-3 rounded-lg border border-danger/25 bg-danger-soft p-4 sm:flex-row sm:items-center">
        <OctagonX className="h-5 w-5 shrink-0 text-danger" aria-hidden />
        <div className="flex-1">
          <p className="font-medium">
            {failing.length} {failing.length === 1 ? "test is" : "tests are"} failing
          </p>
          <p className="text-sm text-muted-foreground">{failing.slice(0, 3).map((f) => f.caseName).join(", ")}{failing.length > 3 ? ` and ${failing.length - 3} more` : ""}</p>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link href="/runs?outcome=failed">See failures</Link>
        </Button>
      </div>
    );
  if (!data.totals.judged) return null;
  return (
    <div className="mb-6 flex items-center gap-3 rounded-lg border border-success/25 bg-success-soft p-4">
      <CheckCircle2 className="h-5 w-5 shrink-0 text-success" aria-hidden />
      <p className="text-sm">
        <span className="font-medium">No open incidents.</span> <span className="text-muted-foreground">Every test's most recent result is passing or not yet failing.</span>
      </p>
    </div>
  );
}

function TrendChart({ data, tz }: { data: Overview; tz: string }) {
  const hourly = data.range === "24h";
  const rows = data.trend.map((r) => ({ ...r, label: dateTime(r.t, "UTC", hourly ? { hour: "numeric" } : { month: "short", day: "numeric" }) }));
  if (!rows.length) return <EmptyState title="No runs in this period" icon={FlaskConical}>Results appear here as tests run.</EmptyState>;
  return (
    <div className="h-56" role="img" aria-label="Runs over time by result">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} margin={{ top: 4, right: 4, bottom: 0, left: -18 }} barCategoryGap={hourly ? 2 : "22%"}>
          <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeDasharray="3 3" />
          <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: "hsl(var(--subtle-foreground))" }} interval="preserveStartEnd" minTickGap={16} />
          <YAxis allowDecimals={false} tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: "hsl(var(--subtle-foreground))" }} />
          <ChartTooltip
            cursor={{ fill: "hsl(var(--muted))" }}
            contentStyle={{ background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12 }}
            labelFormatter={(_l, p) => (p?.[0] ? `${dateTime((p[0].payload as { t: string }).t, "UTC", hourly ? { dateStyle: "medium", timeStyle: "short" } : { dateStyle: "medium" })} (${tzLabel(tz)})` : "")}
          />
          <Bar dataKey="passed" name="Passed" stackId="a" fill="hsl(var(--chart-1))" radius={[0, 0, 0, 0]} />
          <Bar dataKey="failed" name="Failed" stackId="a" fill="hsl(var(--chart-2))" />
          <Bar dataKey="infra" name="Infra error" stackId="a" fill="hsl(var(--chart-3))" radius={[3, 3, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export default function OverviewPage() {
  const ws = useWorkspace();
  const [q, setQ] = useUrlState({ range: "7d" });
  const overview = useQuery<Overview>({ queryKey: [ws.base, `analytics/overview?range=${q.range}`], refetchInterval: 30_000 });
  const recent = useQuery<{ items: RunSummary[] }>({ queryKey: [ws.base, "runs?limit=8"], refetchInterval: 15_000 });
  const d = overview.data;
  return (
    <>
      <PageHeader
        title="Overview"
        description={d ? <>Updated <TimeAgo iso={d.generatedAt} /> · times in {ws.timezone}</> : undefined}
        actions={
          <>
            <Segmented label="Period" value={q.range!} onChange={(range) => setQ({ range })} options={[{ value: "24h", label: "24h" }, { value: "7d", label: "7 days" }, { value: "30d", label: "30 days" }]} />
            <Button variant="outline" size="icon" aria-label="Refresh" onClick={() => void overview.refetch()}>
              <RefreshCw className={cn("h-4 w-4", overview.isFetching && "animate-spin")} />
            </Button>
          </>
        }
      />
      <SetupChecklist />
      {overview.error ? (
        <ErrorState error={overview.error} retry={() => void overview.refetch()} />
      ) : !d ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-[104px] rounded-lg" />
          ))}
        </div>
      ) : (
        <>
          <HealthBanner data={d} />
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat
              label="Pass rate"
              value={percent(d.totals.passRate)}
              tone={d.totals.passRate !== null && d.totals.passRate < 0.9 ? "danger" : undefined}
              sub={d.totals.judged ? `${number(d.totals.passed)} of ${number(d.totals.judged)} runs` : "No finished runs yet"}
            />
            <Stat label="Failures" value={number(d.totals.failed + d.totals.timed_out)} tone={d.totals.failed + d.totals.timed_out ? "danger" : undefined} sub={d.totals.infrastructure_error ? `${d.totals.infrastructure_error} infrastructure errors (not counted)` : "Failed or timed out"} />
            <Stat label="Median duration" value={duration(d.totals.p50_ms)} sub={d.totals.p95_ms ? `95th percentile ${duration(d.totals.p95_ms)}` : "Of passing runs"} />
            <Stat
              label="Schedules"
              value={number(d.schedules.active)}
              sub={d.schedules.next_at ? <>Next <TimeAgo iso={d.schedules.next_at} exact={dateTime(d.schedules.next_at, ws.timezone)} /></> : d.schedules.paused ? `${d.schedules.paused} paused` : "None active"}
            />
          </div>
          {(d.totals.passed_on_retry > 0 || d.totals.warnings_on_passes > 0) && (
            <p className="mt-3 text-xs text-muted-foreground">
              {d.totals.passed_on_retry > 0 && <>{d.totals.passed_on_retry} passes needed a retry. </>}
              {d.totals.warnings_on_passes > 0 && <>{d.totals.warnings_on_passes} soft checks failed inside passing runs. </>}
              <Link href="/health" className="underline-offset-4 hover:underline">See test health</Link>
            </p>
          )}

          <div className="mt-6 grid gap-6 xl:grid-cols-[1.6fr_1fr]">
            <section className="surface p-5" aria-labelledby="trend">
              <div className="mb-4 flex items-center justify-between">
                <h2 id="trend" className="text-[15px] font-medium">Runs over time</h2>
                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm bg-chart-1" /> Passed</span>
                  <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm bg-chart-2" /> Failed</span>
                  <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm bg-chart-3" /> Infra</span>
                </div>
              </div>
              <TrendChart data={d} tz={ws.timezone} />
            </section>
            <section className="surface flex flex-col" aria-labelledby="failing">
              <div className="flex items-center justify-between border-b px-5 py-4">
                <h2 id="failing" className="text-[15px] font-medium">Failing now</h2>
                <span className="text-xs text-muted-foreground">{d.openIncidents.length} open</span>
              </div>
              {d.openIncidents.length ? (
                <ul className="divide-y">
                  {d.openIncidents.slice(0, 6).map((i) => (
                    <li key={i.id}>
                      <Link href={`/tests/${i.caseId}`} className="flex items-center gap-3 px-5 py-3 transition-colors hover:bg-muted/50">
                        <span className="h-2 w-2 shrink-0 rounded-full bg-danger" aria-hidden />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">{i.caseName}</span>
                          <span className="block text-xs text-muted-foreground">
                            {i.consecutiveFailures} in a row · since <TimeAgo iso={i.openedAt} />
                          </span>
                        </span>
                        {["critical", "high"].includes(i.priority) && <span className="rounded bg-danger-soft px-1.5 py-0.5 text-[11px] font-medium capitalize text-danger">{i.priority}</span>}
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="flex flex-1 items-center justify-center p-8 text-center text-sm text-muted-foreground">Nothing is failing right now.</div>
              )}
            </section>
          </div>
        </>
      )}

      <section className="surface mt-6" aria-labelledby="recent">
        <div className="flex items-center justify-between border-b px-5 py-4">
          <h2 id="recent" className="text-[15px] font-medium">Recent runs</h2>
          <Link href="/runs" className="flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground">
            All runs <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>
        {recent.data?.items.length ? (
          <ul className="divide-y">
            {recent.data.items.map((r) => (
              <li key={r.id}>
                <Link href={`/runs/${r.id}`} className="flex items-center gap-3 px-5 py-3 text-sm transition-colors hover:bg-muted/50">
                  <StatusBadge status={r.status} />
                  <span className="min-w-0 flex-1 truncate font-medium">{r.caseName}</span>
                  <span className="hidden w-28 text-right text-xs capitalize text-muted-foreground sm:block">{r.trigger}</span>
                  <span className="hidden w-16 text-right tabular text-muted-foreground sm:block">{["running", "starting"].includes(r.status) ? <Loader2 className="ml-auto h-3.5 w-3.5 animate-spin" /> : duration(r.duration)}</span>
                  <span className="w-28 text-right text-xs text-muted-foreground">
                    <TimeAgo iso={r.createdAt} exact={dateTime(r.createdAt, ws.timezone)} />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        ) : recent.isLoading ? (
          <div className="p-5"><Skeleton className="h-24" /></div>
        ) : (
          <div className="p-5">
            <EmptyState title="No runs yet" icon={FlaskConical} action={<Button asChild><Link href="/tests">Go to tests</Link></Button>}>
              Publish a test and run it, or put it on a schedule.
            </EmptyState>
          </div>
        )}
      </section>
    </>
  );
}
