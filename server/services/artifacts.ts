// Artifact storage on the local filesystem (a mounted volume in production).
// Keys are opaque; files are only ever served through the authenticated
// artifact route. Swap this module for S3/R2 without touching callers.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { and, eq, lt } from "drizzle-orm";
import { config } from "../config";
import { db } from "../db/client";
import { artifacts } from "@shared/schema";

const ROOT = path.resolve(config.ARTIFACT_DIR);

function resolveKey(key: string): string {
  if (!/^[a-z0-9/_.-]+$/i.test(key) || key.includes("..")) throw new Error("bad artifact key");
  const p = path.join(ROOT, key);
  if (!p.startsWith(ROOT + path.sep)) throw new Error("bad artifact key");
  return p;
}

export async function saveArtifact(opts: {
  workspaceId: number;
  executionId: number;
  attempt: number;
  stepIndex: number | null;
  kind: "screenshot" | "trace" | "video" | "log";
  contentType: string;
  ext: string;
  data: Buffer;
}) {
  const name = `${opts.kind}-a${opts.attempt}${opts.stepIndex !== null ? `-s${opts.stepIndex}` : ""}-${Date.now()}.${opts.ext}`;
  const key = `w${opts.workspaceId}/r${opts.executionId}/${name}`;
  const file = resolveKey(key);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, opts.data, { mode: 0o600 });
  const [row] = await db
    .insert(artifacts)
    .values({
      workspaceId: opts.workspaceId,
      executionId: opts.executionId,
      attempt: opts.attempt,
      stepIndex: opts.stepIndex,
      kind: opts.kind,
      storageKey: key,
      contentType: opts.contentType,
      sizeBytes: opts.data.length,
      sha256: createHash("sha256").update(opts.data).digest("hex"),
      retentionUntil: new Date(Date.now() + config.ARTIFACT_RETENTION_DAYS * 86400_000),
    })
    .returning();
  return row;
}

export async function openArtifact(key: string) {
  const file = resolveKey(key);
  const s = await stat(file);
  return { stream: createReadStream(file), size: s.size };
}

/** Deletes artifacts past their retention date. Returns how many were removed. */
export async function pruneArtifacts(): Promise<number> {
  const expired = await db.select().from(artifacts).where(lt(artifacts.retentionUntil, new Date())).limit(500);
  for (const a of expired) {
    await rm(resolveKey(a.storageKey), { force: true });
    await db.delete(artifacts).where(and(eq(artifacts.id, a.id)));
  }
  // Remove empty run folders left behind.
  try {
    for (const w of await readdir(ROOT)) for (const r of await readdir(path.join(ROOT, w))) {
      const dir = path.join(ROOT, w, r);
      if ((await readdir(dir)).length === 0) await rm(dir, { recursive: true, force: true });
    }
  } catch {
    // nothing stored yet
  }
  return expired.length;
}
