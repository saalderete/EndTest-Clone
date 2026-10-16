// Applies migrations/*.sql in name order, each in its own transaction,
// recorded in schema_migrations. Safe to run on every deploy and from several
// instances at once (an advisory lock serializes them).
//
//   npm run db:migrate
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type pg from "pg";

// This file runs from source (server/db) and bundled into dist/*.js, so find the
// repository's migrations folder by walking up instead of assuming a depth.
function findDir(start: string): string {
  for (let dir = start; ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, "migrations", "0000_init.sql"))) return path.join(dir, "migrations");
    if (path.dirname(dir) === dir) throw new Error(`migrations folder not found above ${start}`);
  }
}
const DIR = findDir(import.meta.dirname);
const LOCK_ID = 7_315_002;

export type MigrationContext = { log: (msg: string) => void };

export async function migrate(pool: pg.Pool, ctx: MigrationContext): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_ID]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);

    const { rows: done } = await client.query("SELECT name FROM schema_migrations");
    const have = new Set(done.map((r) => r.name as string));
    const files = (await readdir(DIR)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();

    for (const file of files) {
      if (have.has(file)) continue;
      ctx.log(`Applying ${file}`);
      await client.query("BEGIN");
      try {
        await client.query(await readFile(path.join(DIR, file), "utf8"));
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
        applied.push(file);
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_ID]).catch(() => {});
    client.release();
  }
  return applied;
}
