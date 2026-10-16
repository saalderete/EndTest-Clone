import { useEffect, type ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { Redirect, Route, Switch, useLocation, useParams } from "wouter";
import { queryClient } from "@/lib/api";
import { useSession } from "@/hooks/session";
import { ThemeProvider } from "@/components/theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/toaster";
import { AppShell, AuthFrame } from "@/components/shell";
import { Skeleton } from "@/components/common";
import { AcceptInvitePage, ForgotPasswordPage, LoginPage, NewWorkspacePage, SetPasswordPage, SignupPage, VerifyEmailPage } from "@/pages/auth";
import OverviewPage from "@/pages/overview";
import TestsPage from "@/pages/tests";
import TestBuilderPage from "@/pages/builder";
import RunsPage from "@/pages/runs";
import RunDetailPage from "@/pages/run-detail";
import SchedulesPage from "@/pages/schedules";
import HealthPage from "@/pages/health";
import AnalyticsPage from "@/pages/analytics";
import ReportsPage from "@/pages/reports";
import AlertsPage from "@/pages/alerts";
import SettingsPage from "@/pages/settings";
import { AccountPage, SystemPage } from "@/pages/account";

function Loading() {
  return (
    <div className="grid min-h-[100dvh] place-items-center">
      <Skeleton className="h-6 w-40" />
    </div>
  );
}

function NotFound() {
  return (
    <AuthFrame>
      <div className="surface p-7 text-center">
        <h1 className="text-lg font-semibold">Page not found</h1>
        <p className="mt-2 text-sm text-muted-foreground">The link may be old, or you may not have access to it.</p>
        <a href="/" className="mt-5 inline-block text-sm font-medium underline-offset-4 hover:underline">
          Go to your workspace
        </a>
      </div>
    </AuthFrame>
  );
}

/** Signed-in only. Sends everyone else to sign-in, then back here. */
function RequireUser({ children }: { children: ReactNode }) {
  const { data, isLoading } = useSession();
  const [location] = useLocation();
  if (isLoading) return <Loading />;
  if (!data?.user) return <Redirect to={`~/login?next=${encodeURIComponent(window.location.pathname + window.location.search || location)}`} />;
  return <>{children}</>;
}

function Home() {
  const { data } = useSession();
  if (!data?.user) return <Redirect to="/login" />;
  return <Redirect to={data.workspaces.length ? `/w/${data.workspaces[0].id}` : "/new-workspace"} />;
}

function WorkspaceRoutes() {
  const { wid } = useParams<{ wid: string }>();
  const { data } = useSession();
  if (!data?.workspaces.some((w) => String(w.id) === wid)) return <NotFound />;
  return (
    <AppShell>
      <Switch>
        <Route path="/" component={OverviewPage} />
        <Route path="/tests" component={TestsPage} />
        <Route path="/tests/:caseId" component={TestBuilderPage} />
        <Route path="/runs" component={RunsPage} />
        <Route path="/runs/:runId" component={RunDetailPage} />
        <Route path="/schedules" component={SchedulesPage} />
        <Route path="/health" component={HealthPage} />
        <Route path="/analytics" component={AnalyticsPage} />
        <Route path="/reports" component={ReportsPage} />
        <Route path="/alerts" component={AlertsPage} />
        <Route path="/settings" component={SettingsPage} />
        <Route path="/settings/:tab" component={SettingsPage} />
        <Route component={NotFound} />
      </Switch>
    </AppShell>
  );
}

function SessionWatcher() {
  const [, navigate] = useLocation();
  useEffect(() => {
    const onUnauthorized = () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
      if (!window.location.pathname.startsWith("/login")) navigate(`~/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
    };
    window.addEventListener("th:unauthorized", onUnauthorized);
    return () => window.removeEventListener("th:unauthorized", onUnauthorized);
  }, [navigate]);
  return null;
}

export default function App() {
  return (
    <ThemeProvider defaultTheme="system" storageKey="th-theme">
      <QueryClientProvider client={queryClient}>
        <TooltipProvider delayDuration={250}>
          <SessionWatcher />
          <Switch>
            <Route path="/login" component={LoginPage} />
            <Route path="/signup" component={SignupPage} />
            <Route path="/forgot-password" component={ForgotPasswordPage} />
            <Route path="/set-password" component={SetPasswordPage} />
            <Route path="/verify-email" component={VerifyEmailPage} />
            <Route path="/invite/:token" component={AcceptInvitePage} />
            <Route path="/new-workspace">
              <RequireUser>
                <NewWorkspacePage />
              </RequireUser>
            </Route>
            <Route path="/account">
              <RequireUser>
                <AccountPage />
              </RequireUser>
            </Route>
            <Route path="/system">
              <RequireUser>
                <SystemPage />
              </RequireUser>
            </Route>
            <Route path="/w/:wid" nest>
              <RequireUser>
                <WorkspaceRoutes />
              </RequireUser>
            </Route>
            <Route path="/">
              <RequireUser>
                <Home />
              </RequireUser>
            </Route>
            <Route component={NotFound} />
          </Switch>
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
