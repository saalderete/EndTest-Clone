// Workspace settings: general, environments, secrets, members, audit log.
import { useState } from "react";
import { Link, useLocation, useParams } from "wouter";
import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { Copy, Globe, KeyRound, Plus, RotateCw, Trash2, UserPlus } from "lucide-react";
import { useSession, useWorkspace } from "@/hooks/session";
import { del, errorMessage, get, patch, post, put, queryClient } from "@/lib/api";
import type { Environment, Invitation, Member, Role, Secret, Workspace } from "@/lib/types";
import { COMMON_TIMEZONES, dateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Confirm, EmptyState, ErrorState, Field, Notice, PageHeader, TableSkeleton, TimeAgo } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";

const TABS = [
  { id: "general", label: "General", min: "viewer" },
  { id: "environments", label: "Environments", min: "viewer" },
  { id: "secrets", label: "Secrets", min: "viewer" },
  { id: "members", label: "Members", min: "viewer" },
  { id: "audit", label: "Audit log", min: "admin" },
] as const;

function General() {
  const ws = useWorkspace();
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const q = useQuery<Workspace & { role: Role }>({ queryKey: [ws.base] , queryFn: () => get(ws.base) });
  const checks = useQuery<{ aiAvailable: boolean }>({ queryKey: [ws.base, "checks"] });
  const [f, setF] = useState<{ name: string; timezone: string; aiEnabled: boolean; budget: string } | null>(null);
  const [confirmName, setConfirmName] = useState("");
  const v = f ?? (q.data ? { name: q.data.name, timezone: q.data.timezone, aiEnabled: q.data.aiEnabled, budget: String(q.data.aiMonthlyBudgetCents / 100) } : null);
  const save = useMutation({
    mutationFn: () => patch(ws.base, { name: v!.name, timezone: v!.timezone, aiEnabled: v!.aiEnabled, aiMonthlyBudgetCents: Math.round(Number(v!.budget) * 100) }),
    onSuccess: () => {
      void queryClient.invalidateQueries();
      setF(null);
      toast({ title: "Workspace saved" });
    },
  });
  const remove = useMutation({
    mutationFn: () => del(ws.base, { confirmName }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
      navigate("~/");
    },
  });
  if (!v) return <TableSkeleton rows={3} />;
  const ro = !ws.can("admin");
  const zones = COMMON_TIMEZONES.includes(v.timezone) ? COMMON_TIMEZONES : [v.timezone, ...COMMON_TIMEZONES];
  return (
    <div className="max-w-xl space-y-8">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <fieldset disabled={ro} className="space-y-4">
          {save.error && <Notice tone="danger">{errorMessage(save.error)}</Notice>}
          <Field label="Workspace name" htmlFor="ws-name">
            <Input id="ws-name" value={v.name} onChange={(e) => setF({ ...v, name: e.target.value })} />
          </Field>
          <Field label="Timezone" hint="Default for new schedules, and how times are shown and reported.">
            <Select value={v.timezone} onValueChange={(timezone) => setF({ ...v, timezone })}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {zones.map((z) => (
                  <SelectItem key={z} value={z}>
                    {z}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <div className="rounded-lg border bg-surface-2 p-4">
            <label className="flex items-start gap-3">
              <Switch className="mt-0.5" checked={v.aiEnabled} disabled={!checks.data?.aiAvailable} onCheckedChange={(aiEnabled) => setF({ ...v, aiEnabled })} />
              <span>
                <span className="block text-sm font-medium">AI assistance</span>
                <span className="block text-xs text-muted-foreground">
                  {checks.data?.aiAvailable
                    ? "Draft tests from a description and explain failures. Suggestions are always reviewed by a person; secrets are never sent."
                    : "Not available on this server (AI_ENABLED and ANTHROPIC_API_KEY). Testing works fully without it."}
                </span>
              </span>
            </label>
            {v.aiEnabled && (
              <div className="mt-3 pl-12">
                <Field label="Monthly budget (USD)" htmlFor="ai-budget" hint="AI requests stop for the month once this is reached.">
                  <Input id="ai-budget" type="number" inputMode="decimal" min={0} step="1" className="w-32" value={v.budget} onChange={(e) => setF({ ...v, budget: e.target.value })} />
                </Field>
              </div>
            )}
          </div>
          {!ro && (
            <Button type="submit" disabled={save.isPending || !f}>
              Save changes
            </Button>
          )}
        </fieldset>
      </form>
      {ws.can("owner") && (
        <section className="rounded-lg border border-danger/30 p-4">
          <h3 className="text-sm font-medium text-danger">Delete workspace</h3>
          <p className="mt-1 text-sm text-muted-foreground">Deletes every suite, test, version, schedule, run, screenshot and secret in it. This can't be undone.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Input placeholder={`Type “${ws.name}” to confirm`} value={confirmName} onChange={(e) => setConfirmName(e.target.value)} className="max-w-xs" />
            <Button variant="destructive" disabled={confirmName !== ws.name || remove.isPending} onClick={() => remove.mutate()}>
              Delete workspace
            </Button>
          </div>
          {remove.error && <p className="mt-2 text-sm text-danger">{errorMessage(remove.error)}</p>}
        </section>
      )}
    </div>
  );
}

function EnvironmentDialog({ env, onClose }: { env: Environment | "new"; onClose: () => void }) {
  const ws = useWorkspace();
  const [f, setF] = useState({ name: env === "new" ? "" : env.name, baseUrl: env === "new" ? "https://" : env.baseUrl, allowedHosts: env === "new" ? "" : env.allowedHosts.join("\n") });
  const m = useMutation({
    mutationFn: () => {
      const body = { name: f.name, baseUrl: f.baseUrl.trim(), allowedHosts: f.allowedHosts };
      return env === "new" ? post(`${ws.base}/environments`, body) : patch(`${ws.base}/environments/${env.id}`, body);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [ws.base] });
      onClose();
    },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{env === "new" ? "Add environment" : `Edit ${env.name}`}</DialogTitle>
          <DialogDescription>Only test sites you own or are authorized to test.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {m.error && <Notice tone="danger">{errorMessage(m.error)}</Notice>}
          <Field label="Name" htmlFor="env-name" hint="Production, Staging, QA…">
            <Input id="env-name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          </Field>
          <Field label="Base URL" htmlFor="env-url" hint="Steps can use paths like /login, resolved against this.">
            <Input id="env-url" type="url" autoCapitalize="none" value={f.baseUrl} onChange={(e) => setF({ ...f, baseUrl: e.target.value })} />
          </Field>
          <Field label="Allowed hosts" htmlFor="env-hosts" hint="One per line. The base URL's host is always allowed. Use *.example.com for subdomains, and add sign-in providers the site redirects to.">
            <Textarea id="env-hosts" rows={4} className="font-mono text-[13px]" value={f.allowedHosts} onChange={(e) => setF({ ...f, allowedHosts: e.target.value })} placeholder={"auth.example.com\n*.cdn.example.com"} />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => m.mutate()} disabled={m.isPending || !f.name.trim()}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Environments() {
  const ws = useWorkspace();
  const q = useQuery<Environment[]>({ queryKey: [ws.base, "environments"] });
  const [editing, setEditing] = useState<Environment | "new" | null>(null);
  const remove = useMutation({ mutationFn: (id: number) => del(`${ws.base}/environments/${id}`), onSuccess: () => void queryClient.invalidateQueries({ queryKey: [ws.base] }) });
  return (
    <>
      <div className="mb-4 flex items-center justify-between gap-4">
        <p className="max-w-[60ch] text-sm text-muted-foreground">An environment is a site under test: its base URL and the hosts tests may visit. The runner refuses to open anything else.</p>
        {ws.can("admin") && (
          <Button onClick={() => setEditing("new")}>
            <Plus className="mr-2 h-4 w-4" /> Add environment
          </Button>
        )}
      </div>
      {q.isLoading ? (
        <TableSkeleton rows={2} />
      ) : !q.data?.length ? (
        <EmptyState icon={Globe} title="No environments yet" action={ws.can("admin") ? <Button onClick={() => setEditing("new")}>Add environment</Button> : undefined}>
          Add the site your tests will run against.
        </EmptyState>
      ) : (
        <ul className="surface divide-y">
          {q.data.map((e) => (
            <li key={e.id} className="flex flex-col gap-2 px-4 py-3.5 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1">
                <p className="font-medium">{e.name}</p>
                <p className="truncate font-mono text-xs text-muted-foreground">{e.baseUrl}</p>
                <p className="mt-1 text-xs text-muted-foreground">Allowed: {e.allowedHosts.join(", ")}</p>
              </div>
              {ws.can("admin") && (
                <div className="flex gap-1">
                  <Button variant="outline" size="sm" onClick={() => setEditing(e)}>
                    Edit
                  </Button>
                  <Confirm
                    trigger={
                      <Button variant="ghost" size="icon" aria-label={`Delete ${e.name}`}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    }
                    title={`Delete ${e.name}?`}
                    description="Suites and tests that use it will need another environment before they can run."
                    confirmLabel="Delete"
                    destructive
                    onConfirm={() => remove.mutateAsync(e.id)}
                  />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {editing && <EnvironmentDialog env={editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function SecretDialog({ secret, onClose }: { secret: Secret | "new"; onClose: () => void }) {
  const ws = useWorkspace();
  const [name, setName] = useState(secret === "new" ? "" : secret.name);
  const [value, setValue] = useState("");
  const [description, setDescription] = useState(secret === "new" ? "" : (secret.description ?? ""));
  const m = useMutation({
    mutationFn: () => (secret === "new" ? post(`${ws.base}/secrets`, { name, value, description: description || undefined }) : put(`${ws.base}/secrets/${secret.id}`, { value, description })),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [ws.base, "secrets"] });
      onClose();
    },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{secret === "new" ? "Add secret" : `Rotate ${secret.name}`}</DialogTitle>
          <DialogDescription>Encrypted at rest. Nobody can read it back, including admins; only the test runner uses it, and it's masked in every log and screenshot caption.</DialogDescription>
        </DialogHeader>
        <form
          id="secret-form"
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            m.mutate();
          }}
        >
          {m.error && <Notice tone="danger">{errorMessage(m.error)}</Notice>}
          {secret === "new" && (
            <Field label="Name" htmlFor="sec-name" hint="Use it in steps as {{secrets.NAME}}.">
              <Input id="sec-name" className="font-mono" autoCapitalize="characters" value={name} onChange={(e) => setName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_"))} placeholder="STAGING_PASSWORD" />
            </Field>
          )}
          <Field label={secret === "new" ? "Value" : "New value"} htmlFor="sec-value">
            <Input id="sec-value" type="password" autoComplete="new-password" value={value} onChange={(e) => setValue(e.target.value)} />
          </Field>
          <Field label="Description" htmlFor="sec-desc" optional>
            <Input id="sec-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Login for the qa-robot account on staging" />
          </Field>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="secret-form" disabled={m.isPending || !value || !name}>
            {secret === "new" ? "Add secret" : "Rotate"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Secrets() {
  const ws = useWorkspace();
  const q = useQuery<Secret[]>({ queryKey: [ws.base, "secrets"] });
  const [editing, setEditing] = useState<Secret | "new" | null>(null);
  const remove = useMutation({ mutationFn: (id: number) => del(`${ws.base}/secrets/${id}`), onSuccess: () => void queryClient.invalidateQueries({ queryKey: [ws.base, "secrets"] }) });
  return (
    <>
      <div className="mb-4 flex items-center justify-between gap-4">
        <p className="max-w-[60ch] text-sm text-muted-foreground">Passwords and tokens tests type into forms. Steps refer to them by name, so values never appear in tests, exports, logs or AI requests.</p>
        {ws.can("admin") && (
          <Button onClick={() => setEditing("new")}>
            <Plus className="mr-2 h-4 w-4" /> Add secret
          </Button>
        )}
      </div>
      {q.isLoading ? (
        <TableSkeleton rows={2} />
      ) : !q.data?.length ? (
        <EmptyState icon={KeyRound} title="No secrets yet">Add one for each login your tests use.</EmptyState>
      ) : (
        <ul className="surface divide-y">
          {q.data.map((s) => (
            <li key={s.id} className="flex flex-col gap-2 px-4 py-3.5 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1">
                <code className="text-sm font-medium">{s.name}</code>
                <p className="text-xs text-muted-foreground">
                  {s.description ? `${s.description} · ` : ""}
                  Used by {s.usedByTests} {s.usedByTests === 1 ? "test" : "tests"} · rotated <TimeAgo iso={s.rotatedAt} exact={dateTime(s.rotatedAt, ws.timezone)} />
                </p>
              </div>
              {ws.can("admin") && (
                <div className="flex gap-1">
                  <Button variant="outline" size="sm" onClick={() => setEditing(s)}>
                    <RotateCw className="mr-1.5 h-3.5 w-3.5" /> Rotate
                  </Button>
                  <Confirm
                    trigger={
                      <Button variant="ghost" size="icon" aria-label={`Delete ${s.name}`}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    }
                    title={`Delete ${s.name}?`}
                    description={s.usedByTests ? `${s.usedByTests} tests use it and will fail until it's added again.` : "No tests use it."}
                    confirmLabel="Delete secret"
                    destructive
                    onConfirm={() => remove.mutateAsync(s.id)}
                  />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {editing && <SecretDialog secret={editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function Members() {
  const ws = useWorkspace();
  const { data: me } = useSession();
  const { toast } = useToast();
  const q = useQuery<{ members: Member[]; invitations: Invitation[]; roles: Record<Role, string> }>({ queryKey: [ws.base, "members"] });
  const [invite, setInvite] = useState<{ email: string; role: Role } | null>(null);
  const [link, setLink] = useState<{ link: string; emailStatus: string } | null>(null);
  const sendInvite = useMutation({
    mutationFn: () => post<{ link: string; emailStatus: string }>(`${ws.base}/invitations`, invite),
    onSuccess: (r) => {
      setLink(r);
      setInvite(null);
      void queryClient.invalidateQueries({ queryKey: [ws.base, "members"] });
    },
  });
  const changeRole = useMutation({
    mutationFn: ({ id, role }: { id: string; role: Role }) => patch(`${ws.base}/members/${id}`, { role }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: [ws.base, "members"] }),
    onError: (e) => toast({ title: "Couldn't change the role", description: errorMessage(e), variant: "destructive" }),
  });
  const removeMember = useMutation({
    mutationFn: (id: string) => del(`${ws.base}/members/${id}`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: [ws.base, "members"] }),
    onError: (e) => toast({ title: "Couldn't remove", description: errorMessage(e), variant: "destructive" }),
  });
  const revoke = useMutation({ mutationFn: (id: number) => del(`${ws.base}/invitations/${id}`), onSuccess: () => void queryClient.invalidateQueries({ queryKey: [ws.base, "members"] }) });
  if (q.error) return <ErrorState error={q.error} />;
  if (!q.data) return <TableSkeleton rows={3} />;
  const roles = Object.keys(q.data.roles) as Role[];
  return (
    <>
      <div className="mb-4 flex items-center justify-between gap-4">
        <p className="text-sm text-muted-foreground">People who can see and work in this workspace.</p>
        {ws.can("admin") && (
          <Button onClick={() => setInvite({ email: "", role: "editor" })}>
            <UserPlus className="mr-2 h-4 w-4" /> Invite
          </Button>
        )}
      </div>
      <ul className="surface divide-y">
        {q.data.members.map((m) => (
          <li key={m.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">
                {[m.firstName, m.lastName].filter(Boolean).join(" ") || m.email}
                {m.id === me?.user?.id && <span className="ml-1.5 text-xs font-normal text-muted-foreground">(you)</span>}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {[m.firstName, m.lastName].some(Boolean) && `${m.email} · `}
                {m.canSignIn ? (m.lastLoginAt ? <>last signed in <TimeAgo iso={m.lastLoginAt} /></> : "hasn't signed in yet") : "no password set yet"}
              </p>
            </div>
            {ws.can("admin") && m.id !== me?.user?.id ? (
              <div className="flex items-center gap-1">
                <Select value={m.role} onValueChange={(role) => changeRole.mutate({ id: m.id, role: role as Role })}>
                  <SelectTrigger className="h-8 w-28 capitalize" aria-label={`Role for ${m.email}`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {roles.filter((r) => r !== "owner" || ws.can("owner")).map((r) => (
                      <SelectItem key={r} value={r} className="capitalize">
                        {r}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Confirm
                  trigger={
                    <Button variant="ghost" size="icon" aria-label={`Remove ${m.email}`}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  }
                  title={`Remove ${m.email}?`}
                  description="They lose access to this workspace immediately. Their past work stays."
                  confirmLabel="Remove"
                  destructive
                  onConfirm={() => removeMember.mutateAsync(m.id)}
                />
              </div>
            ) : (
              <span className="rounded bg-muted px-2 py-0.5 text-xs capitalize text-muted-foreground">{m.role}</span>
            )}
          </li>
        ))}
      </ul>
      {q.data.invitations.length > 0 && (
        <>
          <h3 className="mb-2 mt-6 text-[13px] font-medium">Pending invitations</h3>
          <ul className="surface divide-y">
            {q.data.invitations.map((i) => (
              <li key={i.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                <span className="min-w-0 flex-1 truncate">{i.email}</span>
                <span className="text-xs capitalize text-muted-foreground">{i.role}</span>
                <span className="text-xs text-muted-foreground">
                  expires <TimeAgo iso={i.expiresAt} />
                </span>
                <Button variant="ghost" size="sm" onClick={() => revoke.mutate(i.id)}>
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="mt-6 grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
        {roles.map((r) => (
          <p key={r}>
            <span className="font-medium capitalize text-foreground">{r}:</span> {q.data.roles[r]}
          </p>
        ))}
      </div>

      <Dialog open={!!invite} onOpenChange={(o) => !o && setInvite(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Invite someone</DialogTitle>
            <DialogDescription>They get a link that works for 7 days.</DialogDescription>
          </DialogHeader>
          {invite && (
            <div className="space-y-4">
              {sendInvite.error && <Notice tone="danger">{errorMessage(sendInvite.error)}</Notice>}
              <Field label="Email" htmlFor="inv-email">
                <Input id="inv-email" type="email" autoCapitalize="none" value={invite.email} onChange={(e) => setInvite({ ...invite, email: e.target.value })} />
              </Field>
              <Field label="Role" hint={q.data.roles[invite.role]}>
                <Select value={invite.role} onValueChange={(role) => setInvite({ ...invite, role: role as Role })}>
                  <SelectTrigger className="capitalize">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {roles.filter((r) => r !== "owner" || ws.can("owner")).map((r) => (
                      <SelectItem key={r} value={r} className="capitalize">
                        {r}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setInvite(null)}>
              Cancel
            </Button>
            <Button onClick={() => sendInvite.mutate()} disabled={sendInvite.isPending || !invite?.email}>
              Create invitation
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={!!link} onOpenChange={(o) => !o && setLink(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Invitation created</DialogTitle>
            <DialogDescription>{link?.emailStatus === "sent" ? "We emailed it. You can also share the link directly." : "Email is off on this server, so share this link with them yourself. It works once."}</DialogDescription>
          </DialogHeader>
          <div className="flex gap-2">
            <Input readOnly value={link?.link ?? ""} className="font-mono text-xs" onFocus={(e) => e.target.select()} />
            <Button
              variant="outline"
              size="icon"
              aria-label="Copy link"
              onClick={() => {
                void navigator.clipboard.writeText(link!.link);
                toast({ title: "Link copied" });
              }}
            >
              <Copy className="h-4 w-4" />
            </Button>
          </div>
          <DialogFooter>
            <Button onClick={() => setLink(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

type AuditItem = { id: number; action: string; targetType: string | null; targetId: string | null; details: Record<string, unknown>; aiInvolved: boolean; createdAt: string; actorEmail: string | null };

function Audit() {
  const ws = useWorkspace();
  const q = useInfiniteQuery({
    queryKey: [ws.base, "audit"],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => get<{ items: AuditItem[]; nextBefore: number | null }>(`${ws.base}/audit?limit=50${pageParam ? `&before=${pageParam}` : ""}`),
    getNextPageParam: (last) => last.nextBefore ?? undefined,
  });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  if (q.error) return <ErrorState error={q.error} />;
  if (q.isLoading) return <TableSkeleton />;
  return (
    <>
      <p className="mb-4 text-sm text-muted-foreground">Security-relevant changes: publishing, schedules, secrets (names only), members, runs and AI-assisted changes.</p>
      <ul className="surface divide-y text-sm">
        {items.map((a) => (
          <li key={a.id} className="flex flex-col gap-1 px-4 py-2.5 sm:flex-row sm:items-center sm:gap-4">
            <code className="w-56 shrink-0 text-xs">{a.action}</code>
            <span className="min-w-0 flex-1 truncate text-muted-foreground">
              {a.actorEmail ?? "system"}
              {a.targetType && ` · ${a.targetType} #${a.targetId}`}
              {Object.keys(a.details).length > 0 && ` · ${JSON.stringify(a.details).slice(0, 140)}`}
              {a.aiInvolved && <span className="ml-1.5 rounded bg-info-soft px-1 text-[10.5px] font-medium text-info">AI</span>}
            </span>
            <span className="shrink-0 text-xs text-muted-foreground">
              <TimeAgo iso={a.createdAt} exact={dateTime(a.createdAt, ws.timezone)} />
            </span>
          </li>
        ))}
        {!items.length && <li className="px-4 py-8 text-center text-muted-foreground">No events yet.</li>}
      </ul>
      {q.hasNextPage && (
        <div className="mt-3 text-center">
          <Button variant="ghost" size="sm" onClick={() => void q.fetchNextPage()}>
            Load older
          </Button>
        </div>
      )}
    </>
  );
}

export default function SettingsPage() {
  const ws = useWorkspace();
  const { tab = "general" } = useParams<{ tab?: string }>();
  const visible = TABS.filter((t) => ws.can(t.min));
  const current = visible.find((t) => t.id === tab) ?? visible[0];
  return (
    <>
      <PageHeader title="Settings" description={ws.name} />
      <nav className="mb-6 flex gap-1 overflow-x-auto border-b" aria-label="Settings sections">
        {visible.map((t) => (
          <Link
            key={t.id}
            href={`/settings/${t.id}`}
            aria-current={current.id === t.id ? "page" : undefined}
            className={cn("-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm transition-colors", current.id === t.id ? "border-brand font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}
          >
            {t.label}
          </Link>
        ))}
      </nav>
      {current.id === "general" && <General />}
      {current.id === "environments" && <Environments />}
      {current.id === "secrets" && <Secrets />}
      {current.id === "members" && <Members />}
      {current.id === "audit" && <Audit />}
    </>
  );
}
