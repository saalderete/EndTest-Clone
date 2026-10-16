import { useState } from "react";
import { Link } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Bell, Mail, MessageSquare, Plus, Send, Trash2, Webhook } from "lucide-react";
import { useWorkspace } from "@/hooks/session";
import { useUrlState } from "@/hooks/url-state";
import { del, errorMessage, patch, post, queryClient } from "@/lib/api";
import type { CaseSummary, Delivery, Incident, NotificationRule, Suite } from "@/lib/types";
import { dateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Confirm, EmptyState, ErrorState, Field, Notice, PageHeader, TableSkeleton, TimeAgo } from "@/components/common";
import { Segmented } from "@/components/segmented";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";

const CHANNEL_ICON = { email: Mail, sms: MessageSquare, webhook: Webhook };
const CHANNEL_LABEL = { email: "Email", sms: "Text message", webhook: "Webhook" };

function RuleDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const ws = useWorkspace();
  const cases = useQuery<CaseSummary[]>({ queryKey: [ws.base, "cases"], enabled: open });
  const suites = useQuery<Suite[]>({ queryKey: [ws.base, "suites"], enabled: open });
  const [f, setF] = useState({ scope: "workspace", caseId: "", suiteId: "", channel: "email" as "email" | "sms" | "webhook", target: "", onFailure: true, onRecovery: true, failureThreshold: "1" });
  const m = useMutation({
    mutationFn: () =>
      post(`${ws.base}/notification-rules`, {
        caseId: f.scope === "case" ? Number(f.caseId) : null,
        suiteId: f.scope === "suite" ? Number(f.suiteId) : null,
        channel: f.channel,
        target: f.target.trim(),
        onFailure: f.onFailure,
        onRecovery: f.onRecovery,
        failureThreshold: Number(f.failureThreshold),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [ws.base, "notification-rules"] });
      onOpenChange(false);
    },
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New alert</DialogTitle>
          <DialogDescription>One message when a test starts failing, and one when it recovers. Never one per failed run.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {m.error && <Notice tone="danger">{errorMessage(m.error)}</Notice>}
          <Field label="For">
            <Segmented label="Scope" value={f.scope} onChange={(scope) => setF({ ...f, scope })} options={[{ value: "workspace", label: "Every test" }, { value: "suite", label: "A suite" }, { value: "case", label: "One test" }]} />
          </Field>
          {f.scope === "suite" && (
            <Select value={f.suiteId} onValueChange={(suiteId) => setF({ ...f, suiteId })}>
              <SelectTrigger aria-label="Suite">
                <SelectValue placeholder="Choose a suite" />
              </SelectTrigger>
              <SelectContent>
                {suites.data?.map((s) => (
                  <SelectItem key={s.id} value={String(s.id)}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {f.scope === "case" && (
            <Select value={f.caseId} onValueChange={(caseId) => setF({ ...f, caseId })}>
              <SelectTrigger aria-label="Test">
                <SelectValue placeholder="Choose a test" />
              </SelectTrigger>
              <SelectContent>
                {cases.data?.map((c) => (
                  <SelectItem key={c.id} value={String(c.id)}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <div className="grid gap-3 sm:grid-cols-[150px_1fr]">
            <Field label="Send by">
              <Select value={f.channel} onValueChange={(channel) => setF({ ...f, channel: channel as typeof f.channel, target: "" })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="email">Email</SelectItem>
                  <SelectItem value="sms">Text message</SelectItem>
                  <SelectItem value="webhook">Webhook</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label={f.channel === "email" ? "Email address" : f.channel === "sms" ? "Phone number" : "Webhook URL"} htmlFor="target">
              <Input
                id="target"
                type={f.channel === "email" ? "email" : f.channel === "sms" ? "tel" : "url"}
                inputMode={f.channel === "sms" ? "tel" : undefined}
                autoCapitalize="none"
                placeholder={f.channel === "email" ? "qa-team@example.com" : f.channel === "sms" ? "+15551234567" : "https://hooks.example.com/…"}
                value={f.target}
                onChange={(e) => setF({ ...f, target: e.target.value })}
              />
            </Field>
          </div>
          <Field label="Alert after" hint="Waiting for a second failure filters out one-off blips.">
            <Select value={f.failureThreshold} onValueChange={(failureThreshold) => setF({ ...f, failureThreshold })}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {["1", "2", "3", "5"].map((n) => (
                  <SelectItem key={n} value={n}>
                    {n === "1" ? "The first failure" : `${n} failures in a row`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <div className="flex flex-wrap gap-6">
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={f.onFailure} onCheckedChange={(onFailure) => setF({ ...f, onFailure })} /> When it starts failing
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={f.onRecovery} onCheckedChange={(onRecovery) => setF({ ...f, onRecovery })} /> When it recovers
            </label>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => m.mutate()} disabled={m.isPending || !f.target.trim() || (f.scope === "case" && !f.caseId) || (f.scope === "suite" && !f.suiteId)}>
            Create alert
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function AlertsPage() {
  const ws = useWorkspace();
  const { toast } = useToast();
  const [q, setQ] = useUrlState({ tab: "rules" });
  const [open, setOpen] = useState(false);
  const rules = useQuery<{ rules: NotificationRule[]; channels: { enabled: boolean; email: boolean; sms: boolean; webhook: boolean } }>({ queryKey: [ws.base, "notification-rules"] });
  const incidents = useQuery<Incident[]>({ queryKey: [ws.base, "incidents"], enabled: q.tab === "incidents" });
  const deliveries = useQuery<Delivery[]>({ queryKey: [ws.base, "notification-deliveries"], enabled: q.tab === "deliveries", refetchInterval: 15_000 });
  const toggle = useMutation({ mutationFn: (r: NotificationRule) => patch(`${ws.base}/notification-rules/${r.id}`, { enabled: !r.enabled }), onSuccess: () => void queryClient.invalidateQueries({ queryKey: [ws.base, "notification-rules"] }) });
  const remove = useMutation({ mutationFn: (id: number) => del(`${ws.base}/notification-rules/${id}`), onSuccess: () => void queryClient.invalidateQueries({ queryKey: [ws.base, "notification-rules"] }) });
  const test = useMutation({
    mutationFn: (id: number) => post<{ status: string; error: string | null }>(`${ws.base}/notification-rules/${id}/test`, {}),
    onSuccess: (r) =>
      toast({
        title: r.status === "sent" ? "Test alert sent" : r.status === "suppressed" ? "Recorded, not sent" : "Test alert failed",
        description: r.status === "suppressed" ? "Notifications are turned off on this server." : (r.error ?? undefined),
        variant: r.status === "failed" ? "destructive" : undefined,
      }),
  });
  const ch = rules.data?.channels;

  return (
    <>
      <PageHeader
        title="Alerts"
        description="Who hears about failures, and a record of every message sent."
        actions={ws.can("editor") && <Button onClick={() => setOpen(true)}><Plus className="mr-2 h-4 w-4" /> New alert</Button>}
      />
      {ch && !ch.enabled && (
        <div className="mb-4">
          <Notice tone="warning" title="Alerts are recorded but not sent">
            This server has notifications turned off (NOTIFICATIONS_ENABLED). Rules still open incidents and log what would have been sent.
          </Notice>
        </div>
      )}
      {ch?.enabled && !ch.email && (
        <div className="mb-4">
          <Notice tone="warning">Email isn't configured on this server (SMTP_HOST and MAIL_FROM), so email alerts will fail.</Notice>
        </div>
      )}
      <div className="mb-4">
        <Segmented label="View" value={q.tab!} onChange={(tab) => setQ({ tab })} options={[{ value: "rules", label: "Rules" }, { value: "incidents", label: "Incidents" }, { value: "deliveries", label: "Delivery log" }]} />
      </div>

      {q.tab === "rules" &&
        (rules.error ? (
          <ErrorState error={rules.error} />
        ) : rules.isLoading ? (
          <TableSkeleton />
        ) : !rules.data?.rules.length ? (
          <EmptyState icon={Bell} title="No alerts yet" action={ws.can("editor") ? <Button onClick={() => setOpen(true)}>New alert</Button> : undefined}>
            Add an email, text or webhook alert so failures reach someone.
          </EmptyState>
        ) : (
          <ul className="surface divide-y">
            {rules.data.rules.map((r) => {
              const Icon = CHANNEL_ICON[r.channel];
              return (
                <li key={r.id} className={cn("flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center", !r.enabled && "opacity-60")}>
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground">
                    <Icon className="h-4 w-4" aria-hidden />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{r.target}</p>
                    <p className="text-xs text-muted-foreground">
                      {CHANNEL_LABEL[r.channel]} · {r.caseName ? `test “${r.caseName}”` : r.suiteName ? `suite “${r.suiteName}”` : "every test"} ·{" "}
                      {[r.onFailure && (r.failureThreshold > 1 ? `after ${r.failureThreshold} failures` : "on first failure"), r.onRecovery && "on recovery"].filter(Boolean).join(", ")}
                    </p>
                  </div>
                  {ws.can("editor") && (
                    <div className="flex items-center gap-2">
                      <Button variant="outline" size="sm" onClick={() => test.mutate(r.id)} disabled={test.isPending}>
                        <Send className="mr-1.5 h-3.5 w-3.5" /> Send test
                      </Button>
                      <Switch checked={r.enabled} onCheckedChange={() => toggle.mutate(r)} aria-label={r.enabled ? "Turn off" : "Turn on"} />
                      <Confirm
                        trigger={
                          <Button variant="ghost" size="icon" aria-label="Delete alert">
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        }
                        title="Delete this alert?"
                        description="Past deliveries stay in the log."
                        confirmLabel="Delete"
                        destructive
                        onConfirm={() => remove.mutateAsync(r.id)}
                      />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        ))}

      {q.tab === "incidents" &&
        (incidents.isLoading ? (
          <TableSkeleton />
        ) : !incidents.data?.length ? (
          <EmptyState icon={Bell} title="No incidents in the last 30 days" />
        ) : (
          <ul className="surface divide-y">
            {incidents.data.map((i) => (
              <li key={i.id} className="flex items-center gap-3 px-4 py-3 text-sm">
                <span className={cn("h-2 w-2 shrink-0 rounded-full", i.resolvedAt ? "bg-success" : "bg-danger")} aria-hidden />
                <Link href={`/tests/${i.caseId}`} className="min-w-0 flex-1 truncate font-medium hover:underline">
                  {i.caseName}
                </Link>
                <span className="text-xs text-muted-foreground">{i.consecutiveFailures} failures</span>
                <span className="w-56 text-right text-xs text-muted-foreground">
                  {i.resolvedAt ? (
                    <>Resolved <TimeAgo iso={i.resolvedAt} exact={dateTime(i.resolvedAt, ws.timezone)} /></>
                  ) : (
                    <>Open since <TimeAgo iso={i.openedAt} exact={dateTime(i.openedAt, ws.timezone)} /></>
                  )}
                </span>
              </li>
            ))}
          </ul>
        ))}

      {q.tab === "deliveries" &&
        (deliveries.isLoading ? (
          <TableSkeleton />
        ) : !deliveries.data?.length ? (
          <EmptyState icon={Send} title="Nothing sent yet" />
        ) : (
          <div className="surface overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="px-4 py-2.5 font-medium">Status</th>
                  <th className="px-4 py-2.5 font-medium">What</th>
                  <th className="px-4 py-2.5 font-medium">To</th>
                  <th className="px-4 py-2.5 text-right font-medium">When</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {deliveries.data.map((d) => (
                  <tr key={d.id}>
                    <td className="px-4 py-2.5">
                      <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium", d.status === "sent" ? "bg-success-soft text-success" : d.status === "failed" ? "bg-danger-soft text-danger" : "bg-neutral-soft text-muted-foreground")}>
                        {d.status === "suppressed" ? "Not sent (off)" : d.status}
                      </span>
                    </td>
                    <td className="px-4 py-2.5">
                      <span className="capitalize">{d.kind}</span>
                      {d.caseName && <span className="text-muted-foreground"> · {d.caseName}</span>}
                      {d.error && d.status === "failed" && <span className="block text-xs text-danger">{d.error}</span>}
                    </td>
                    <td className="px-4 py-2.5 text-muted-foreground">
                      {CHANNEL_LABEL[d.channel as keyof typeof CHANNEL_LABEL] ?? d.channel} {d.targetMasked}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-right text-muted-foreground">
                      <TimeAgo iso={d.createdAt} exact={dateTime(d.createdAt, ws.timezone)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      {open && <RuleDialog open onOpenChange={setOpen} />}
    </>
  );
}
