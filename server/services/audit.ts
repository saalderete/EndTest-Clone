// Append-only audit trail for security-relevant changes.
import type { Request } from "express";
import { db } from "../db/client";
import { auditEvents } from "@shared/schema";
import { log, errorFields } from "../lib/log";

export async function audit(
  req: Pick<Request, "user" | "workspace" | "requestId"> | null,
  action: string,
  target?: { type: string; id: string | number },
  details: Record<string, unknown> = {},
  opts: { workspaceId?: number | null; aiInvolved?: boolean; actorUserId?: string | null } = {},
) {
  try {
    await db.insert(auditEvents).values({
      workspaceId: opts.workspaceId !== undefined ? opts.workspaceId : (req?.workspace?.id ?? null),
      actorUserId: opts.actorUserId !== undefined ? opts.actorUserId : (req?.user?.id ?? null),
      action,
      targetType: target?.type ?? null,
      targetId: target ? String(target.id) : null,
      details,
      aiInvolved: opts.aiInvolved ?? false,
      requestId: req?.requestId ?? null,
    });
  } catch (err) {
    // An audit write must never break the action it records, but it must be visible.
    log.error("audit write failed", { action, ...errorFields(err) });
  }
}
