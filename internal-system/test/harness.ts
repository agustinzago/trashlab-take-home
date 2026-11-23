import pg from "pg";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.ts";
import { migrate } from "../src/db.ts";

// A database of its own, so a running Internal System never consumes the tests' outbox.
const server = process.env.TEST_DATABASE_SERVER ?? "postgres://internal:internal@localhost:5433";
let created = false;

async function ensureTestDatabase() {
  if (created) return;
  const admin = new pg.Client({ connectionString: `${server}/internal` });
  await admin.connect();
  await admin.query("CREATE DATABASE internal_test").catch((err) => {
    if (err.code !== "42P04") throw err; // already exists
  });
  await admin.end();
  created = true;
}

export async function setup(): Promise<{ app: FastifyInstance; pool: pg.Pool }> {
  await ensureTestDatabase();
  const pool = new pg.Pool({ connectionString: `${server}/internal_test` });
  await migrate(pool);
  await pool.query("TRUNCATE customers, invoices, payments, idempotency_keys, outbox RESTART IDENTITY CASCADE");
  const app = buildApp(pool);
  await app.ready();
  return { app, pool };
}

export const line = (amountCents: number, revenueCategory = "consulting") => ({
  description: `${revenueCategory} work`,
  amountCents,
  revenueCategory,
});

export async function createCustomer(app: FastifyInstance, displayName = "Acme Ltd") {
  const res = await app.inject({ method: "POST", url: "/customers", payload: { displayName } });
  return res.json();
}

export async function createInvoice(app: FastifyInstance, body: Record<string, unknown>) {
  const res = await app.inject({ method: "POST", url: "/invoices", payload: body });
  if (res.statusCode !== 201) throw new Error(`create invoice failed: ${res.body}`);
  return res.json();
}
