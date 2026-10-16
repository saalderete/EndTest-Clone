// npm run db:migrate
import "../config";
import { pool } from "../db/client";
import { migrate } from "../db/migrate";

const applied = await migrate(pool, { log: (m) => console.log(m) });
console.log(applied.length ? `Applied ${applied.length} migration(s).` : "Database is up to date.");
await pool.end();
