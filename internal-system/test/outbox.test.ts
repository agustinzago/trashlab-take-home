import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { deliverDue } from "../src/outbox.ts";
import { createCustomer, createInvoice, line, setup } from "./harness.ts";

const secret = "test-secret";

type Received = { type: string; id: number; deliveryId: string; signatureValid: boolean };

let app: FastifyInstance;
let pool: pg.Pool;
let server: Server;
let url: string;
let received: Received[];
let statuses: number[]; // responses to give, in order; 200 once exhausted

beforeEach(async () => {
  ({ app, pool } = await setup());
  received = [];
  statuses = [];
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const expected = "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");
      received.push({ ...JSON.parse(raw), signatureValid: req.headers["x-signature"] === expected });
      res.writeHead(statuses.shift() ?? 200).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
});
afterEach(async () => {
  await app.close();
  await pool.end();
  await new Promise((r) => server.close(r));
});

const config = () => ({ url, secret, chaos: false, retryBaseMs: 0 });

describe("Change notifications", () => {
  it("delivers a signed, thin notification for every change and none for a rejected one", async () => {
    const customer = await createCustomer(app);
    const inv = await createInvoice(app, { docNumber: "INV-1", customerId: customer.id, txnDate: "2026-11-01", lines: [line(100)] });
    await app.inject({ method: "PATCH", url: `/invoices/${inv.id}`, headers: { "if-match": "1" }, payload: { memo: "m" } });
    await app.inject({ method: "PATCH", url: `/invoices/${inv.id}`, headers: { "if-match": "1" }, payload: { memo: "stale" } });
    await app.inject({ method: "POST", url: `/invoices/${inv.id}/issue`, headers: { "if-match": "2" } });
    const payment = (
      await app.inject({ method: "POST", url: "/payments", payload: { invoiceId: inv.id, amountCents: 50, txnDate: "2026-11-02", method: "ach" } })
    ).json();
    await app.inject({ method: "POST", url: `/payments/${payment.id}/void`, headers: { "if-match": "1" } });

    await deliverDue(pool, config());

    expect(received.map(({ type, id }) => ({ type, id }))).toEqual([
      { type: "customer", id: customer.id },
      { type: "invoice", id: inv.id },
      { type: "invoice", id: inv.id },
      { type: "invoice", id: inv.id },
      { type: "payment", id: payment.id },
      { type: "payment", id: payment.id },
    ]);
    expect(received.every((r) => r.signatureValid)).toBe(true);
    expect(Object.keys(received[0]).sort()).toEqual(["deliveryId", "id", "signatureValid", "type"]);
  });

  it("notifies a draft Delete", async () => {
    const customer = await createCustomer(app);
    const inv = await createInvoice(app, { docNumber: "INV-1", customerId: customer.id, txnDate: "2026-11-01", lines: [line(100)] });
    await app.inject({ method: "DELETE", url: `/invoices/${inv.id}`, headers: { "if-match": "1" } });

    await deliverDue(pool, config());

    expect(received.filter((r) => r.type === "invoice")).toHaveLength(2);
  });

  it("retries a delivery until it is acknowledged, and not after", async () => {
    await createCustomer(app);
    statuses = [500, 503];

    await deliverDue(pool, config());
    await deliverDue(pool, config());
    await deliverDue(pool, config());
    await deliverDue(pool, config());

    expect(received).toHaveLength(3);
    expect(new Set(received.map((r) => r.deliveryId)).size).toBe(1);
  });

  it("with CHAOS on, duplicates, delays and reorders deliveries but still delivers each one", async () => {
    const customers = [];
    for (let i = 0; i < 20; i++) customers.push(await createCustomer(app, `Customer ${i}`));
    const random = seeded(7);
    const chaos = { ...config(), chaos: true, chaosMaxDelayMs: 0, random };

    await deliverDue(pool, chaos);
    const firstRound = new Set(received.map((r) => r.id)).size;
    for (let i = 0; i < 20 && new Set(received.map((r) => r.id)).size < 20; i++) await deliverDue(pool, chaos);

    const firstArrivals = [...new Set(received.map((r) => r.id))];
    expect(firstArrivals.sort((a, b) => a - b)).toEqual(customers.map((c) => c.id));
    expect(firstRound).toBeLessThan(20); // some were held back (delayed)
    expect(received.length).toBeGreaterThan(20); // some were duplicated
    expect([...new Set(received.map((r) => r.id))]).not.toEqual(customers.map((c) => c.id)); // reordered
  });
});

// Deterministic PRNG (mulberry32) so the chaos test is repeatable.
function seeded(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
