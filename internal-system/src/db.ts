import { readFile } from "node:fs/promises";
import pg from "pg";

// Keep DATE columns as "YYYY-MM-DD" strings instead of timezone-shifted Dates.
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

export async function migrate(pool: pg.Pool): Promise<void> {
  const sql = await readFile(new URL("./schema.sql", import.meta.url), "utf8");
  // Serialize concurrent migrations (several test files, or app replicas).
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(42)");
    await client.query(sql);
  } finally {
    await client.query("SELECT pg_advisory_unlock(42)");
    client.release();
  }
}

export async function tx<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
