// Web process: API + UI. With RUN_WORKER=true it also runs the scheduler and
// test runner in the same process (convenient for development and small installs).
import { createServer } from "node:http";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { config } from "./config";
import { pool } from "./db/client";
import { migrate } from "./db/migrate";
import { createApp } from "./http/app";
import { log, errorFields } from "./lib/log";
import { serveStatic } from "./static";

async function ensureSchema() {
  if (config.NODE_ENV !== "production") {
    await migrate(pool, { log: (m) => log.info(m) });
    return;
  }
  // Production never migrates implicitly: a deploy must run `npm run db:migrate` (after a backup).
  const files = (await readdir(path.resolve(import.meta.dirname, "../migrations"))).filter((f) => /^\d{4}_/.test(f));
  const { rows } = await pool.query("SELECT name FROM schema_migrations").catch(() => ({ rows: [] as { name: string }[] }));
  const missing = files.filter((f) => !rows.some((r) => r.name === f));
  if (missing.length) throw new Error(`Database is behind: run "npm run db:migrate" (pending: ${missing.join(", ")}).`);
}

async function main() {
  await ensureSchema();
  const app = createApp();
  const server = createServer(app);
  if (config.NODE_ENV === "development") {
    // A non-literal specifier keeps the bundler from pulling Vite into dist/index.js.
    const devModule = "./vite";
    const { setupVite } = (await import(devModule)) as typeof import("./vite");
    await setupVite(app, server);
  }
  else if (config.NODE_ENV === "production") serveStatic(app);

  let stopWorker: (() => Promise<void>) | null = null;
  if (config.RUN_WORKER) {
    const { startWorker } = await import("./runner/worker");
    stopWorker = await startWorker();
  }

  server.listen(config.PORT, config.HOST, () => log.info("listening", { url: config.APP_URL, port: config.PORT, worker: config.RUN_WORKER }));

  const shutdown = async (signal: string) => {
    log.info("shutting down", { signal });
    server.close();
    await stopWorker?.();
    await pool.end().catch(() => {});
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  log.error("startup failed", errorFields(err));
  console.error((err as Error).message);
  process.exit(1);
});
