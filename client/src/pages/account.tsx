// Account settings and the system-admin page (outside any workspace).
import { useState } from "react";
import { Link } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowLeft, OctagonX, Play } from "lucide-react";
import { errorMessage, get, patch, post, queryClient } from "@/lib/api";
import { useSession } from "@/hooks/session";
import { Logo } from "@/components/shell";
import { Confirm, ErrorState, Field, Notice, PageHeader, Skeleton, TimeAgo } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";

function Frame({ children }: { children: React.ReactNode }) {
  const { data } = useSession();
  const back = data?.workspaces[0] ? `/w/${data.workspaces[0].id}` : "/";
  return (
    <div className="min-h-[100dvh]">
      <header className="flex h-14 items-center gap-4 border-b bg-surface px-4 sm:px-8">
        <Link href={back} className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> Back
        </Link>
        <Logo className="text-sm" />
      </header>
      <main className="mx-auto max-w-3xl px-4 py-8 sm:px-8">{children}</main>
    </div>
  );
}

export function AccountPage() {
  const { data } = useSession();
  const { toast } = useToast();
  const u = data?.user;
  const [name, setName] = useState<{ firstName: string; lastName: string } | null>(null);
  const [pw, setPw] = useState({ current: "", password: "", confirm: "" });
  const v = name ?? { firstName: u?.firstName ?? "", lastName: u?.lastName ?? "" };
  const saveName = useMutation({
    mutationFn: () => patch("/api/auth/me", v),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
      setName(null);
      toast({ title: "Saved" });
    },
  });
  const changePw = useMutation({
    mutationFn: () => post("/api/auth/password/change", { current: pw.current, password: pw.password }),
    onSuccess: () => {
      setPw({ current: "", password: "", confirm: "" });
      toast({ title: "Password changed", description: "Your other sessions were signed out." });
    },
  });
  if (!u) return null;
  return (
    <Frame>
      <PageHeader title="Your account" description={u.email} />
      <div className="space-y-8">
        <form
          className="surface max-w-xl space-y-4 p-5"
          onSubmit={(e) => {
            e.preventDefault();
            saveName.mutate();
          }}
        >
          <h2 className="text-[15px] font-medium">Profile</h2>
          {saveName.error && <Notice tone="danger">{errorMessage(saveName.error)}</Notice>}
          <div className="grid grid-cols-2 gap-3">
            <Field label="First name" htmlFor="fn">
              <Input id="fn" autoComplete="given-name" value={v.firstName} onChange={(e) => setName({ ...v, firstName: e.target.value })} />
            </Field>
            <Field label="Last name" htmlFor="ln">
              <Input id="ln" autoComplete="family-name" value={v.lastName} onChange={(e) => setName({ ...v, lastName: e.target.value })} />
            </Field>
          </div>
          <Button type="submit" disabled={!name || saveName.isPending}>
            Save
          </Button>
        </form>
        <form
          className="surface max-w-xl space-y-4 p-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (pw.password === pw.confirm) changePw.mutate();
          }}
        >
          <h2 className="text-[15px] font-medium">Change password</h2>
          {changePw.error && <Notice tone="danger">{errorMessage(changePw.error)}</Notice>}
          <Field label="Current password" htmlFor="cur">
            <Input id="cur" type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} />
          </Field>
          <Field label="New password" htmlFor="new" hint="At least 10 characters.">
            <Input id="new" type="password" autoComplete="new-password" value={pw.password} onChange={(e) => setPw({ ...pw, password: e.target.value })} />
          </Field>
          <Field label="Confirm new password" htmlFor="conf" error={pw.confirm && pw.confirm !== pw.password ? "The passwords don't match." : null}>
            <Input id="conf" type="password" autoComplete="new-password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} />
          </Field>
          <Button type="submit" disabled={!pw.current || pw.password.length < 10 || pw.password !== pw.confirm || changePw.isPending}>
            Change password
          </Button>
        </form>
      </div>
    </Frame>
  );
}

type Status = {
  dispatchPaused: boolean;
  workers: { workerId: string; hostname: string; version: string; startedAt: string; heartbeatAt: string; currentExecutionId: number | null; browserOk: boolean | null; online: boolean }[];
  queue: { queued: number; running: number; oldestQueuedSeconds: number | null };
  lateSchedules: number;
};

export function SystemPage() {
  const { data: me } = useSession();
  const { toast } = useToast();
  const q = useQuery<Status>({ queryKey: ["/api/system/status"], queryFn: () => get("/api/system/status"), refetchInterval: 10_000, enabled: !!me?.user?.isSystemAdmin });
  const stop = useMutation({
    mutationFn: () => post<{ cancelledQueued: number; stoppingRunning: number }>("/api/system/emergency-stop", {}),
    onSuccess: (r) => {
      void q.refetch();
      toast({ title: "Emergency stop", description: `${r.cancelledQueued} queued runs cancelled, ${r.stoppingRunning} running runs stopping.` });
    },
  });
  const resume = useMutation({ mutationFn: () => post("/api/system/resume", {}), onSuccess: () => void q.refetch() });
  if (!me?.user?.isSystemAdmin)
    return (
      <Frame>
        <Notice tone="warning">This page is for system administrators.</Notice>
      </Frame>
    );
  const s = q.data;
  return (
    <Frame>
      <PageHeader title="System" description="Every workspace on this server." />
      {q.error ? (
        <ErrorState error={q.error} />
      ) : !s ? (
        <Skeleton className="h-64" />
      ) : (
        <div className="space-y-6">
          {s.dispatchPaused ? (
            <Notice tone="danger" title="Emergency stop is on" action={<Button size="sm" onClick={() => resume.mutate()} disabled={resume.isPending}><Play className="mr-1.5 h-3.5 w-3.5" /> Resume</Button>}>
              No runs start and no schedules fire. Resuming doesn't fire the times that were missed.
            </Notice>
          ) : (
            <div className="surface flex flex-col gap-3 p-5 sm:flex-row sm:items-center">
              <div className="flex-1">
                <h2 className="text-[15px] font-medium">Emergency stop</h2>
                <p className="text-sm text-muted-foreground">Cancels every queued run, stops running ones at the next step, and stops all schedules from firing, in every workspace.</p>
              </div>
              <Confirm
                trigger={
                  <Button variant="destructive">
                    <OctagonX className="mr-2 h-4 w-4" /> Stop everything
                  </Button>
                }
                title="Stop all testing on this server?"
                description="Recorded in the audit log. Each schedule keeps its own paused or active setting for when you resume."
                confirmLabel="Stop everything"
                destructive
                onConfirm={() => stop.mutateAsync()}
              />
            </div>
          )}
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="surface p-4">
              <div className="eyebrow">Queued</div>
              <div className="tabular mt-1.5 text-2xl font-semibold">{s.queue.queued}</div>
              {s.queue.oldestQueuedSeconds ? <div className="mt-1 text-xs text-muted-foreground">oldest waiting {Math.round(s.queue.oldestQueuedSeconds / 60)} min</div> : null}
            </div>
            <div className="surface p-4">
              <div className="eyebrow">Running</div>
              <div className="tabular mt-1.5 text-2xl font-semibold">{s.queue.running}</div>
            </div>
            <div className="surface p-4">
              <div className="eyebrow">Late schedules</div>
              <div className="tabular mt-1.5 text-2xl font-semibold">{s.lateSchedules}</div>
              <div className="mt-1 text-xs text-muted-foreground">due over 2 minutes ago</div>
            </div>
          </div>
          <section className="surface">
            <h2 className="border-b px-5 py-4 text-[15px] font-medium">Workers</h2>
            {s.workers.length ? (
              <ul className="divide-y text-sm">
                {s.workers.map((w) => (
                  <li key={w.workerId} className="flex items-center gap-3 px-5 py-3">
                    <span className={`h-2 w-2 rounded-full ${w.online ? "bg-success" : "bg-border-strong"}`} aria-hidden />
                    <code className="min-w-0 flex-1 truncate text-xs">{w.workerId}</code>
                    <span className="text-xs text-muted-foreground">{w.browserOk === false ? "browser failed" : w.currentExecutionId ? `run #${w.currentExecutionId}` : "idle"}</span>
                    <span className="text-xs text-muted-foreground">
                      seen <TimeAgo iso={w.heartbeatAt} />
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-5 py-8 text-center text-sm text-muted-foreground">No worker has ever checked in. Start one with npm run worker.</p>
            )}
          </section>
        </div>
      )}
    </Frame>
  );
}
