import pg from "pg";
import { migrate } from "./db.ts";

// Tests get databases of their own on the dev Postgres, so a running service never
// consumes their rows. Start it with `docker compose up -d internal-db`.
const server = process.env.TEST_DATABASE_SERVER ?? "postgres://internal:internal@localhost:5433";
const created = new Set<string>();

/** A pool on a freshly migrated `name` database with `tables` emptied. */
export async function testPool(name: string, schema: URL, tables: string[]): Promise<pg.Pool> {
  if (!created.has(name)) {
    const admin = new pg.Client({ connectionString: `${server}/internal` });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`).catch((err) => {
      if (err.code !== "42P04") throw err; // already exists
    });
    await admin.end();
    created.add(name);
  }
  const pool = new pg.Pool({ connectionString: `${server}/${name}` });
  await migrate(pool, schema);
  await pool.query(`TRUNCATE ${tables.join(", ")} RESTART IDENTITY CASCADE`);
  return pool;
}
