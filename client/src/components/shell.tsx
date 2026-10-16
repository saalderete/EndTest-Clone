// The signed-in frame: sidebar, top bar, command palette.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  BarChart3,
  Bell,
  CalendarClock,
  Check,
  ChevronsUpDown,
  FileText,
  FlaskConical,
  HeartPulse,
  LayoutDashboard,
  LogOut,
  Menu,
  Monitor,
  Moon,
  Plus,
  Search,
  Settings,
  ShieldAlert,
  Sun,
  UserRound,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { post, queryClient } from "@/lib/api";
import { useSession, useWorkspace } from "@/hooks/session";
import type { CaseSummary, Overview } from "@/lib/types";
import { useTheme } from "@/components/theme-provider";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Kbd } from "@/components/common";

const NAV = [
  { href: "", label: "Overview", icon: LayoutDashboard },
  { href: "/tests", label: "Tests", icon: FlaskConical },
  { href: "/runs", label: "Runs", icon: Activity },
  { href: "/schedules", label: "Schedules", icon: CalendarClock },
  { href: "/health", label: "Test health", icon: HeartPulse },
  { href: "/analytics", label: "Analytics", icon: BarChart3 },
  { href: "/reports", label: "Reports", icon: FileText },
  { href: "/alerts", label: "Alerts", icon: Bell },
  { href: "/settings", label: "Settings", icon: Settings },
] as const;

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2 font-semibold tracking-[-0.01em]", className)}>
      <svg viewBox="0 0 32 32" className="h-6 w-6" aria-hidden>
        <rect width="32" height="32" rx="8" className="fill-[hsl(219_47%_20%)] dark:fill-[hsl(219_40%_16%)]" />
        <path d="M9 17.5l4.5 4.5L23 11" fill="none" stroke="hsl(174 64% 52%)" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      TestHarvest
    </span>
  );
}

function WorkspaceSwitcher() {
  const ws = useWorkspace();
  const { data } = useSession();
  const [, navigate] = useLocation();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring">
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-sidebar-primary/15 text-[13px] font-semibold text-sidebar-primary">{ws.name.slice(0, 1).toUpperCase()}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-sidebar-accent-foreground">{ws.name}</span>
          <span className="block text-[11px] capitalize text-sidebar-muted">{ws.role}</span>
        </span>
        <ChevronsUpDown className="h-4 w-4 shrink-0 text-sidebar-muted" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel className="text-xs text-muted-foreground">Workspaces</DropdownMenuLabel>
        {data?.workspaces.map((w) => (
          <DropdownMenuItem key={w.id} onSelect={() => navigate(`~/w/${w.id}`)}>
            <span className="flex-1 truncate">{w.name}</span>
            {w.isDemo && <span className="mr-1 rounded bg-muted px-1.5 text-[10px] uppercase text-muted-foreground">Demo</span>}
            {w.id === ws.id && <Check className="h-4 w-4" />}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => navigate("~/new-workspace")}>
          <Plus className="mr-2 h-4 w-4" /> New workspace
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const [location] = useLocation();
  const ws = useWorkspace();
  return (
    <nav className="space-y-0.5" aria-label="Main">
      {NAV.filter((n) => n.href !== "/settings" || ws.can("viewer")).map((n) => {
        const active = n.href === "" ? location === "/" || location === "" : location.startsWith(n.href);
        const Icon = n.icon;
        return (
          <Link
            key={n.href}
            href={n.href || "/"}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={cn(
              "group relative flex items-center gap-2.5 rounded-md px-2.5 py-[7px] text-[13.5px] transition-colors duration-150",
              active ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
            )}
          >
            {active && <span aria-hidden className="absolute -left-3 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-r bg-sidebar-primary" />}
            <Icon className={cn("h-4 w-4 shrink-0", active ? "text-sidebar-primary" : "text-sidebar-muted group-hover:text-sidebar-foreground")} aria-hidden />
            {n.label}
          </Link>
        );
      })}
    </nav>
  );
}

function UserMenu() {
  const { data } = useSession();
  const { theme, setTheme } = useTheme();
  const [, navigate] = useLocation();
  const signOut = async () => {
    await post("/api/auth/logout");
    queryClient.clear();
    navigate("~/login");
  };
  const u = data?.user;
  if (!u) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring">
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-sidebar-accent text-[12px] font-medium text-sidebar-accent-foreground">
          {(u.firstName?.[0] ?? u.email[0]).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] text-sidebar-foreground">{u.name}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-60">
        <DropdownMenuLabel className="truncate text-xs font-normal text-muted-foreground">{u.email}</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => navigate("~/account")}>
          <UserRound className="mr-2 h-4 w-4" /> Account
        </DropdownMenuItem>
        {u.isSystemAdmin && (
          <DropdownMenuItem onSelect={() => navigate("~/system")}>
            <ShieldAlert className="mr-2 h-4 w-4" /> System
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <div className="flex items-center gap-1 px-2 py-1.5" role="radiogroup" aria-label="Theme">
          {(
            [
              ["light", Sun, "Light"],
              ["dark", Moon, "Dark"],
              ["system", Monitor, "System"],
            ] as const
          ).map(([t, Icon, label]) => (
            <button
              key={t}
              role="radio"
              aria-checked={theme === t}
              onClick={() => setTheme(t)}
              className={cn("flex flex-1 items-center justify-center gap-1.5 rounded px-2 py-1 text-xs transition-colors", theme === t ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted/60")}
            >
              <Icon className="h-3.5 w-3.5" /> {label}
            </button>
          ))}
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void signOut()}>
          <LogOut className="mr-2 h-4 w-4" /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SidebarBody({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <div className="flex h-full flex-col bg-sidebar px-3 py-3">
      <div className="mb-3 px-2 pt-1 text-sidebar-accent-foreground">
        <Logo className="text-[15px]" />
      </div>
      <WorkspaceSwitcher />
      <div className="mt-4 flex-1 overflow-y-auto pl-3 -ml-3">
        <NavLinks onNavigate={onNavigate} />
      </div>
      <div className="border-t border-sidebar-border pt-2">
        <UserMenu />
      </div>
    </div>
  );
}

function ActiveRuns() {
  const ws = useWorkspace();
  const { data } = useQuery({ queryKey: [ws.base, "analytics/overview?range=24h"], refetchInterval: 10_000 });
  const active = (data as Overview | undefined)?.active;
  if (!active || active.queued + active.running === 0) return null;
  return (
    <Link href="/runs?outcome=active" className="hidden items-center gap-2 rounded-full border bg-surface px-3 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground sm:flex">
      <span className="h-2 w-2 rounded-full bg-info animate-pulse-dot" aria-hidden />
      {active.running} running{active.queued ? ` · ${active.queued} queued` : ""}
    </Link>
  );
}

function CommandPalette({ open, setOpen }: { open: boolean; setOpen: (v: boolean) => void }) {
  const ws = useWorkspace();
  const [, navigate] = useLocation();
  const { data: cases } = useQuery({ queryKey: [ws.base, "cases"], enabled: open });
  const go = (href: string) => {
    setOpen(false);
    navigate(href);
  };
  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Jump to a page or test…" />
      <CommandList>
        <CommandEmpty>No matches.</CommandEmpty>
        <CommandGroup heading="Pages">
          {NAV.map((n) => (
            <CommandItem key={n.href} onSelect={() => go(n.href || "/")}>
              <n.icon className="mr-2 h-4 w-4" /> {n.label}
            </CommandItem>
          ))}
        </CommandGroup>
        {Array.isArray(cases) && cases.length > 0 && (
          <CommandGroup heading="Tests">
            {(cases as CaseSummary[]).slice(0, 200).map((c) => (
              <CommandItem key={c.id} value={`${c.name} ${c.suiteName}`} onSelect={() => go(`/tests/${c.id}`)}>
                <FlaskConical className="mr-2 h-4 w-4" />
                <span className="flex-1 truncate">{c.name}</span>
                <span className="ml-2 truncate text-xs text-muted-foreground">{c.suiteName}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const ws = useWorkspace();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const isMac = useMemo(() => typeof navigator !== "undefined" && /Mac/.test(navigator.platform), []);
  return (
    <div className="min-h-[100dvh]">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 lg:block">
        <SidebarBody />
      </aside>
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="left" className="w-72 border-none p-0">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <SidebarBody onNavigate={() => setMobileOpen(false)} />
        </SheetContent>
      </Sheet>
      <div className="lg:pl-60">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b bg-background/85 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/70 sm:px-6">
          <Button variant="ghost" size="icon" className="-ml-2 lg:hidden" onClick={() => setMobileOpen(true)} aria-label="Open navigation">
            <Menu className="h-5 w-5" />
          </Button>
          <span className="truncate text-sm font-medium lg:hidden">{ws.name}</span>
          <div className="flex-1" />
          <ActiveRuns />
          <button
            onClick={() => setPaletteOpen(true)}
            className="flex h-8 items-center gap-2 rounded-md border bg-surface px-2.5 text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:w-64"
          >
            <Search className="h-4 w-4" aria-hidden />
            <span className="hidden flex-1 truncate whitespace-nowrap text-left sm:inline">Search</span>
            <span className="hidden shrink-0 sm:inline">
              <Kbd>{isMac ? "⌘" : "Ctrl"} K</Kbd>
            </span>
          </button>
        </header>
        <main className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">{children}</main>
      </div>
      <CommandPalette open={paletteOpen} setOpen={setPaletteOpen} />
    </div>
  );
}

/** Centered frame for sign-in and other pages outside a workspace. */
export function AuthFrame({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className="relative grid min-h-[100dvh] place-items-center bg-background px-4 py-10">
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-64 bg-[radial-gradient(ellipse_at_top,hsl(var(--brand)/0.10),transparent_70%)]" />
      <div className={cn("relative w-full", wide ? "max-w-lg" : "max-w-[400px]")}>
        <div className="mb-8 flex justify-center">
          <Logo className="text-lg" />
        </div>
        {children}
      </div>
    </div>
  );
}
