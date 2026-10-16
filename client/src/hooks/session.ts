import { useQuery } from "@tanstack/react-query";
import { useParams } from "wouter";
import { get } from "@/lib/api";
import type { Me, Role, WorkspaceSummary } from "@/lib/types";

export function useSession() {
  return useQuery({ queryKey: ["/api/auth/me"], queryFn: () => get<Me>("/api/auth/me"), staleTime: 60_000 });
}

const RANK: Record<Role, number> = { viewer: 1, runner: 2, editor: 3, admin: 4, owner: 5 };
export const can = (role: Role | undefined, min: Role) => !!role && RANK[role] >= RANK[min];

/** The workspace in the current URL (/w/:wid/...), from the session's membership list. */
export function useWorkspace(): WorkspaceSummary & { base: string; can: (min: Role) => boolean } {
  const { wid } = useParams<{ wid: string }>();
  const { data } = useSession();
  const ws = data?.workspaces.find((w) => String(w.id) === wid);
  if (!ws) throw new Error("useWorkspace used outside a workspace route");
  return { ...ws, base: `/api/workspaces/${ws.id}`, can: (min) => can(ws.role, min) };
}
