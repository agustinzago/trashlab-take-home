import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { createCustomer, createInvoice, line, setup } from "./harness.ts";

let app: FastifyInstance;
let pool: pg.Pool;
let invoiceId: number;

beforeEach(async () => {
  ({ app, pool } = await setup());
  const customer = await createCustomer(app);
  invoiceId = (
    await createInvoice(app, {
      docNumber: "INV-1",
      customerId: customer.id,
      txnDate: "2026-11-01",
      lines: [line(1000)],
      status: "issued",
    })
  ).id;
});
afterEach(async () => {
  await app.close();
  await pool.end();
});

const pay = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  app.inject({
    method: "POST",
    url: "/payments",
    headers,
    payload: { invoiceId, txnDate: "2026-11-05", method: "check", ...body },
  });
const invoice = async () => (await app.inject({ method: "GET", url: `/invoices/${invoiceId}` })).json();

describe("Payments", () => {
  it("derives Payment Status from the Payments applied", async () => {
    const first = await pay({ amountCents: 400, ref: "PAY-A" });
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ ref: "PAY-A", invoiceId, amountCents: 400, status: "active", version: 1 });
    expect(await invoice()).toMatchObject({ paidCents: 400, balanceCents: 600, paymentStatus: "partially_paid" });

    await pay({ amountCents: 600 });
    expect(await invoice()).toMatchObject({ paidCents: 1000, balanceCents: 0, paymentStatus: "paid" });
  });

  it("gives a Payment a ref when none is supplied, and finds Payments by ref and by Invoice", async () => {
    const created = (await pay({ amountCents: 100 })).json();
    expect(created.ref).toMatch(/\S/);

    const byRef = await app.inject({ method: "GET", url: `/payments?ref=${created.ref}` });
    const byInvoice = await app.inject({ method: "GET", url: `/payments?invoiceId=${invoiceId}` });
    expect(byRef.json()).toEqual([created]);
    expect(byInvoice.json()).toEqual([created]);
  });

  it("voids a Payment, which stops counting towards the Invoice", async () => {
    const p = (await pay({ amountCents: 1000 })).json();

    const res = await app.inject({ method: "POST", url: `/payments/${p.id}/void`, headers: { "if-match": "1" } });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "voided", version: 2, amountCents: 1000 });
    expect(await invoice()).toMatchObject({ paidCents: 0, paymentStatus: "unpaid" });
  });

  it("rejects voiding a Payment with a stale If-Match", async () => {
    const p = (await pay({ amountCents: 1000 })).json();
    const res = await app.inject({ method: "POST", url: `/payments/${p.id}/void`, headers: { "if-match": "7" } });
    expect(res.statusCode).toBe(409);
    expect(await invoice()).toMatchObject({ paidCents: 1000 });
  });

  it("only applies Payments to issued Invoices", async () => {
    await app.inject({ method: "POST", url: `/invoices/${invoiceId}/void`, headers: { "if-match": "1" } });
    const res = await pay({ amountCents: 100 });
    expect(res.statusCode).toBe(422);
  });

  it("creates one Payment for a repeated Idempotency-Key", async () => {
    const [a, b] = await Promise.all([
      pay({ amountCents: 100 }, { "idempotency-key": "p-1" }),
      pay({ amountCents: 100 }, { "idempotency-key": "p-1" }),
    ]);
    expect(b.json()).toEqual(a.json());
    expect(await invoice()).toMatchObject({ paidCents: 100 });
  });
});

describe("Customers", () => {
  it("creates one Customer for a repeated Idempotency-Key and finds it by display name", async () => {
    const send = () =>
      app.inject({
        method: "POST",
        url: "/customers",
        headers: { "idempotency-key": "c-1" },
        payload: { displayName: "Globex" },
      });
    const [a, b] = await Promise.all([send(), send()]);
    expect(a.statusCode).toBe(201);
    expect(b.json()).toEqual(a.json());

    const found = await app.inject({ method: "GET", url: "/customers?displayName=Globex" });
    expect(found.json()).toEqual([a.json()]);
    expect((await app.inject({ method: "GET", url: `/customers/${a.json().id}` })).json()).toEqual(a.json());
  });
});
