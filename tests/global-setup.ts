// Re-creates the test database and applies every migration before the run.
import pg from "pg";

export default async function setup() {
  const url = new URL(process.env.TEST_DATABASE_URL ?? "postgres://postgres@localhost:5432/testharvest_test");
  const dbName = url.pathname.slice(1);
  if (!/test/.test(dbName)) throw new Error(`Refusing to reset "${dbName}": test database names must contain "test".`);
  const admin = new URL(url);
  admin.pathname = "/postgres";
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  await client.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  await client.query(`CREATE DATABASE "${dbName}"`);
  await client.end();

  const pool = new pg.Pool({ connectionString: url.toString() });
  const { migrate } = await import("../server/db/migrate");
  await migrate(pool, { log: () => {} });
  await pool.end();
}
