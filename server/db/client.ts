// One connection pool per process. Works with any PostgreSQL (local, Neon,
// managed) through a normal connection string.
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@shared/schema";
import { config } from "../config";

export const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: config.RUN_WORKER ? 15 : 10,
  idleTimeoutMillis: 30_000,
});
pool.on("error", (err) => {
  // An idle client died (database restart, network); the pool replaces it.
  console.error(JSON.stringify({ level: "error", msg: "postgres pool error", error: err.message }));
});

export const db = drizzle(pool, { schema });
export type Db = typeof db;
