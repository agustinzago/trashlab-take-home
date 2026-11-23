import type pg from "pg";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.ts";
import { testPool } from "../../shared/test-db.ts";

export const internalSchema = new URL("../src/schema.sql", import.meta.url);

export function internalTestPool(): Promise<pg.Pool> {
  return testPool("internal_test", internalSchema, ["customers", "invoices", "payments", "idempotency_keys", "outbox"]);
}

export async function setup(): Promise<{ app: FastifyInstance; pool: pg.Pool }> {
  const pool = await internalTestPool();
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
