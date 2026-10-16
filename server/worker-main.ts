// Worker process: scheduler + test runner, no HTTP. Run one or more of these
// next to the web process (`npm run worker`).
import { config } from "./config";
import { pool } from "./db/client";
import { errorFields, log } from "./lib/log";
import { startWorker } from "./runner/worker";

const stop = await startWorker().catch((err) => {
  log.error("worker failed to start", errorFields(err));
  process.exit(1);
});
log.info("worker process up", { concurrency: config.WORKER_CONCURRENCY });

const shutdown = async () => {
  await stop();
  await pool.end().catch(() => {});
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
