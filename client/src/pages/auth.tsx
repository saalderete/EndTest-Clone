// Pages outside a workspace: sign in, passwords, invitations, first workspace.
import { useEffect, useState, type FormEvent } from "react";
import { Link, useLocation, useParams, useSearch } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { errorMessage, get, post, queryClient } from "@/lib/api";
import type { Me, WorkspaceSummary } from "@/lib/types";
import { AuthFrame } from "@/components/shell";
import { Field, Notice } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSession } from "@/hooks/session";
import { COMMON_TIMEZONES } from "@/lib/format";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

function Card({ title, description, children }: { title: string; description?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="surface p-6 shadow-[0_12px_40px_-12px_hsl(var(--shadow-color)/0.18)] sm:p-7">
      <h1 className="text-lg font-semibold tracking-[-0.01em]">{title}</h1>
      {description && <p className="mt-1.5 text-sm text-muted-foreground">{description}</p>}
      <div className="mt-6">{children}</div>
    </div>
  );
}

function Submit({ pending, children }: { pending: boolean; children: React.ReactNode }) {
  return (
    <Button type="submit" className="w-full" disabled={pending}>
      {pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
      {children}
    </Button>
  );
}

function landing(me: Me) {
  return me.workspaces.length ? `/w/${me.workspaces[0].id}` : "/new-workspace";
}

export function LoginPage() {
  const [, navigate] = useLocation();
  const search = new URLSearchParams(useSearch());
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const { data: me } = useSession();
  const m = useMutation({
    mutationFn: () => post<Me>("/api/auth/login", { email, password }),
    onSuccess: (data) => {
      queryClient.setQueryData(["/api/auth/me"], { ...data, signupEnabled: me?.signupEnabled ?? false });
      const next = search.get("next");
      navigate(next && next.startsWith("/") && !next.startsWith("//") ? next : landing(data));
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    m.mutate();
  };
  return (
    <AuthFrame>
      <Card title="Sign in" description="Browser tests and monitoring for your team.">
        <form onSubmit={submit} className="space-y-4">
          {m.error && <Notice tone="danger">{errorMessage(m.error)}</Notice>}
          <Field label="Email" htmlFor="email">
            <Input id="email" type="email" autoComplete="username" autoCapitalize="none" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label="Password" htmlFor="password">
            <Input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <Submit pending={m.isPending}>Sign in</Submit>
        </form>
        <div className="mt-5 flex items-center justify-between text-sm">
          <Link href="/forgot-password" className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
            Forgot your password?
          </Link>
          {me?.signupEnabled && (
            <Link href="/signup" className="font-medium underline-offset-4 hover:underline">
              Create an account
            </Link>
          )}
        </div>
      </Card>
      <p className="mt-6 text-center text-xs text-muted-foreground">New here? Ask a workspace admin for an invitation.</p>
    </AuthFrame>
  );
}

export function SignupPage() {
  const [, navigate] = useLocation();
  const [form, setForm] = useState({ email: "", password: "", firstName: "", lastName: "" });
  const m = useMutation({
    mutationFn: () => post<Me>("/api/auth/signup", form),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
      navigate(landing(data));
    },
  });
  return (
    <AuthFrame>
      <Card title="Create your account">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            m.mutate();
          }}
          className="space-y-4"
        >
          {m.error && <Notice tone="danger">{errorMessage(m.error)}</Notice>}
          <div className="grid grid-cols-2 gap-3">
            <Field label="First name" htmlFor="fn">
              <Input id="fn" autoComplete="given-name" value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} />
            </Field>
            <Field label="Last name" htmlFor="ln">
              <Input id="ln" autoComplete="family-name" value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} />
            </Field>
          </div>
          <Field label="Work email" htmlFor="email">
            <Input id="email" type="email" autoComplete="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </Field>
          <Field label="Password" htmlFor="pw" hint="At least 10 characters.">
            <Input id="pw" type="password" autoComplete="new-password" required minLength={10} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          </Field>
          <Submit pending={m.isPending}>Create account</Submit>
        </form>
      </Card>
    </AuthFrame>
  );
}

export function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const m = useMutation({ mutationFn: () => post("/api/auth/password/forgot", { email }) });
  return (
    <AuthFrame>
      <Card title="Reset your password" description="We'll email you a link to choose a new one.">
        {m.isSuccess ? (
          <Notice tone="success" title="Check your email">
            If an account exists for {email}, a reset link is on its way. It works for one hour. If email isn't set up on this server, ask an administrator for a reset link.
          </Notice>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              m.mutate();
            }}
            className="space-y-4"
          >
            {m.error && <Notice tone="danger">{errorMessage(m.error)}</Notice>}
            <Field label="Email" htmlFor="email">
              <Input id="email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
            <Submit pending={m.isPending}>Send reset link</Submit>
          </form>
        )}
        <p className="mt-5 text-sm">
          <Link href="/login" className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
            Back to sign in
          </Link>
        </p>
      </Card>
    </AuthFrame>
  );
}

export function SetPasswordPage() {
  const [, navigate] = useLocation();
  const token = new URLSearchParams(useSearch()).get("token") ?? "";
  const info = useQuery({ queryKey: ["token", token], queryFn: () => get<{ valid: boolean; purpose?: string; email?: string }>(`/api/auth/token/${encodeURIComponent(token)}`), enabled: !!token });
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const mismatch = confirm.length > 0 && confirm !== password;
  const m = useMutation({
    mutationFn: () => post<Me>("/api/auth/password/reset", { token, password }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
      navigate(landing(data));
    },
  });
  if (!token || (info.data && !info.data.valid))
    return (
      <AuthFrame>
        <Card title="This link doesn't work">
          <Notice tone="warning">It has expired or was already used. Request a new one, or ask an administrator.</Notice>
          <p className="mt-5 text-sm">
            <Link href="/forgot-password" className="font-medium underline-offset-4 hover:underline">
              Request a new link
            </Link>
          </p>
        </Card>
      </AuthFrame>
    );
  return (
    <AuthFrame>
      <Card title={info.data?.purpose === "set_password" ? "Choose your password" : "Choose a new password"} description={info.data?.email ? <>For {info.data.email}</> : undefined}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!mismatch) m.mutate();
          }}
          className="space-y-4"
        >
          {m.error && <Notice tone="danger">{errorMessage(m.error)}</Notice>}
          <Field label="New password" htmlFor="pw" hint="At least 10 characters. A short sentence works well.">
            <Input id="pw" type="password" autoComplete="new-password" required minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <Field label="Confirm password" htmlFor="pw2" error={mismatch ? "The passwords don't match." : null}>
            <Input id="pw2" type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </Field>
          <Submit pending={m.isPending}>Save and sign in</Submit>
        </form>
      </Card>
    </AuthFrame>
  );
}

export function VerifyEmailPage() {
  const token = new URLSearchParams(useSearch()).get("token") ?? "";
  const m = useMutation({ mutationFn: () => post("/api/auth/verify-email", { token }) });
  useEffect(() => {
    if (token) m.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);
  return (
    <AuthFrame>
      <Card title="Confirm your email">
        {m.isPending && <p className="text-sm text-muted-foreground">Confirming…</p>}
        {m.isSuccess && <Notice tone="success">Your email address is confirmed.</Notice>}
        {(m.isError || !token) && <Notice tone="warning">{m.error ? errorMessage(m.error) : "This link is incomplete."}</Notice>}
        <p className="mt-5 text-sm">
          <Link href="/" className="font-medium underline-offset-4 hover:underline">
            Continue
          </Link>
        </p>
      </Card>
    </AuthFrame>
  );
}

export function AcceptInvitePage() {
  const { token } = useParams<{ token: string }>();
  const [, navigate] = useLocation();
  const { data: me } = useSession();
  const info = useQuery({ queryKey: ["invite", token], queryFn: () => get<{ valid: boolean; workspaceName?: string; email?: string; role?: string; hasAccount?: boolean }>(`/api/invitations/${token}`) });
  const [form, setForm] = useState({ firstName: "", lastName: "", password: "" });
  const m = useMutation({
    mutationFn: () => post<Me & { workspaceId: number }>(`/api/invitations/${token}/accept`, info.data?.hasAccount ? {} : form),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
      navigate(`/w/${data.workspaceId}`);
    },
  });
  if (info.isLoading) return <AuthFrame><Card title="Loading invitation…"><div /></Card></AuthFrame>;
  if (!info.data?.valid)
    return (
      <AuthFrame>
        <Card title="This invitation doesn't work">
          <Notice tone="warning">It has expired, was revoked, or was already used. Ask the person who invited you for a new one.</Notice>
        </Card>
      </AuthFrame>
    );
  const d = info.data;
  const signedInAsOther = me?.user && me.user.email.toLowerCase() !== d.email!.toLowerCase();
  return (
    <AuthFrame>
      <Card title={`Join ${d.workspaceName}`} description={<>You're invited as <span className="font-medium text-foreground">{d.role}</span> with {d.email}.</>}>
        {m.error && <div className="mb-4"><Notice tone="danger">{errorMessage(m.error)}</Notice></div>}
        {signedInAsOther ? (
          <Notice tone="warning">You're signed in as {me!.user!.email}. Sign out, then open this link again to accept as {d.email}.</Notice>
        ) : d.hasAccount ? (
          me?.user ? (
            <Button className="w-full" onClick={() => m.mutate()} disabled={m.isPending}>
              Accept invitation
            </Button>
          ) : (
            <Button className="w-full" onClick={() => navigate(`/login?next=${encodeURIComponent(`/invite/${token}`)}`)}>
              Sign in to accept
            </Button>
          )
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              m.mutate();
            }}
            className="space-y-4"
          >
            <div className="grid grid-cols-2 gap-3">
              <Field label="First name" htmlFor="fn">
                <Input id="fn" autoComplete="given-name" value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} />
              </Field>
              <Field label="Last name" htmlFor="ln">
                <Input id="ln" autoComplete="family-name" value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} />
              </Field>
            </div>
            <Field label="Choose a password" htmlFor="pw" hint="At least 10 characters.">
              <Input id="pw" type="password" autoComplete="new-password" required minLength={10} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
            </Field>
            <Submit pending={m.isPending}>Create account and join</Submit>
          </form>
        )}
      </Card>
    </AuthFrame>
  );
}

export function NewWorkspacePage() {
  const [, navigate] = useLocation();
  const { data: me } = useSession();
  const [name, setName] = useState("");
  const [tz, setTz] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  const m = useMutation({
    mutationFn: () => post<WorkspaceSummary>("/api/workspaces", { name, timezone: tz }),
    onSuccess: async (w) => {
      await queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
      navigate(`/w/${w.id}`);
    },
  });
  const zones = COMMON_TIMEZONES.includes(tz) ? COMMON_TIMEZONES : [tz, ...COMMON_TIMEZONES];
  return (
    <AuthFrame>
      <Card title={me?.workspaces.length ? "New workspace" : "Create your first workspace"} description="A workspace holds one team's environments, tests, schedules and results.">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            m.mutate();
          }}
          className="space-y-4"
        >
          {m.error && <Notice tone="danger">{errorMessage(m.error)}</Notice>}
          <Field label="Name" htmlFor="name" hint="For example: Acme QA">
            <Input id="name" required minLength={2} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Timezone" hint="Schedules and reports use it.">
            <Select value={tz} onValueChange={setTz}>
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
          <Submit pending={m.isPending}>Create workspace</Submit>
        </form>
        {!!me?.workspaces.length && (
          <p className="mt-5 text-sm">
            <Link href={`/w/${me.workspaces[0].id}`} className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
              Cancel
            </Link>
          </p>
        )}
      </Card>
    </AuthFrame>
  );
}
