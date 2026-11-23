import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { createCustomer, createInvoice, line, setup } from "./harness.ts";

let app: FastifyInstance;
let pool: pg.Pool;
let customerId: number;

beforeEach(async () => {
  ({ app, pool } = await setup());
  customerId = (await createCustomer(app)).id;
});
afterEach(async () => {
  await app.close();
  await pool.end();
});

describe("Invoices", () => {
  it("creates a draft Invoice and reads it back with derived totals", async () => {
    const created = await createInvoice(app, {
      docNumber: "INV-1",
      customerId,
      txnDate: "2026-11-01",
      dueDate: "2026-12-01",
      memo: "November work",
      lines: [line(10000), line(2550, "hosting")],
    });

    const res = await app.inject({ method: "GET", url: `/invoices/${created.id}` });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      docNumber: "INV-1",
      customerId,
      txnDate: "2026-11-01",
      dueDate: "2026-12-01",
      memo: "November work",
      status: "draft",
      version: 1,
      totalCents: 12550,
      paidCents: 0,
      balanceCents: 12550,
      paymentStatus: "unpaid",
    });
    expect(res.json().lines).toEqual([line(10000), line(2550, "hosting")]);
    expect(typeof res.json().updatedAt).toBe("string");
  });

  it("updates an Invoice when If-Match carries the current version", async () => {
    const inv = await createInvoice(app, { docNumber: "INV-2", customerId, txnDate: "2026-11-01", lines: [line(100)] });

    const res = await app.inject({
      method: "PATCH",
      url: `/invoices/${inv.id}`,
      headers: { "if-match": "1" },
      payload: { memo: "fixed", lines: [line(300)] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ memo: "fixed", version: 2, totalCents: 300 });
    expect(Date.parse(res.json().updatedAt)).toBeGreaterThanOrEqual(Date.parse(inv.updatedAt));
  });

  it("rejects an update with a stale If-Match with 409 and changes nothing", async () => {
    const inv = await createInvoice(app, { docNumber: "INV-3", customerId, txnDate: "2026-11-01", lines: [line(100)] });
    await app.inject({ method: "PATCH", url: `/invoices/${inv.id}`, headers: { "if-match": "1" }, payload: { memo: "a" } });

    const res = await app.inject({
      method: "PATCH",
      url: `/invoices/${inv.id}`,
      headers: { "if-match": "1" },
      payload: { memo: "b" },
    });

    expect(res.statusCode).toBe(409);
    const after = await app.inject({ method: "GET", url: `/invoices/${inv.id}` });
    expect(after.json()).toMatchObject({ memo: "a", version: 2 });
  });

  it("issues a draft, then voids it keeping its lines but zeroing what is owed", async () => {
    const inv = await createInvoice(app, { docNumber: "INV-5", customerId, txnDate: "2026-11-01", lines: [line(500)] });

    const issued = await app.inject({ method: "POST", url: `/invoices/${inv.id}/issue`, headers: { "if-match": "1" } });
    expect(issued.statusCode).toBe(200);
    expect(issued.json()).toMatchObject({ status: "issued", version: 2 });

    const voided = await app.inject({ method: "POST", url: `/invoices/${inv.id}/void`, headers: { "if-match": "2" } });
    expect(voided.statusCode).toBe(200);
    expect(voided.json()).toMatchObject({ status: "voided", version: 3, totalCents: 0, balanceCents: 0 });
    expect(voided.json().lines).toEqual([line(500)]);

    const edit = await app.inject({
      method: "PATCH",
      url: `/invoices/${inv.id}`,
      headers: { "if-match": "3" },
      payload: { memo: "too late" },
    });
    expect(edit.statusCode).toBe(422);
  });

  it("issues only drafts", async () => {
    const inv = await createInvoice(app, {
      docNumber: "INV-6",
      customerId,
      txnDate: "2026-11-01",
      lines: [line(500)],
      status: "issued",
    });
    const res = await app.inject({ method: "POST", url: `/invoices/${inv.id}/issue`, headers: { "if-match": "1" } });
    expect(res.statusCode).toBe(422);
  });

  it("deletes a draft", async () => {
    const inv = await createInvoice(app, { docNumber: "INV-7", customerId, txnDate: "2026-11-01", lines: [line(500)] });

    const res = await app.inject({ method: "DELETE", url: `/invoices/${inv.id}`, headers: { "if-match": "1" } });

    expect(res.statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: `/invoices/${inv.id}` })).statusCode).toBe(404);
  });

  it("rejects deleting an issued Invoice", async () => {
    const inv = await createInvoice(app, {
      docNumber: "INV-8",
      customerId,
      txnDate: "2026-11-01",
      lines: [line(500)],
      status: "issued",
    });

    const res = await app.inject({ method: "DELETE", url: `/invoices/${inv.id}`, headers: { "if-match": "1" } });

    expect(res.statusCode).toBe(422);
    expect((await app.inject({ method: "GET", url: `/invoices/${inv.id}` })).json()).toMatchObject({ status: "issued" });
  });

  it("replays the original response for a repeated Idempotency-Key without a second record", async () => {
    const body = { docNumber: "INV-9", customerId, txnDate: "2026-11-01", lines: [line(500)] };
    const send = () =>
      app.inject({ method: "POST", url: "/invoices", headers: { "idempotency-key": "k-1" }, payload: body });

    const [first, second] = await Promise.all([send(), send()]);

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.json()).toEqual(first.json());
    const found = await app.inject({ method: "GET", url: "/invoices?docNumber=INV-9" });
    expect(found.json()).toHaveLength(1);
  });

  it("rejects a second Invoice with the same DocNumber", async () => {
    await createInvoice(app, { docNumber: "INV-10", customerId, txnDate: "2026-11-01", lines: [line(1)] });
    const res = await app.inject({
      method: "POST",
      url: "/invoices",
      payload: { docNumber: "INV-10", customerId, txnDate: "2026-11-01", lines: [line(1)] },
    });
    expect(res.statusCode).toBe(422);
  });

  it("requires If-Match on updates", async () => {
    const inv = await createInvoice(app, { docNumber: "INV-4", customerId, txnDate: "2026-11-01", lines: [line(100)] });
    const res = await app.inject({ method: "PATCH", url: `/invoices/${inv.id}`, payload: { memo: "x" } });
    expect(res.statusCode).toBe(428);
  });
});
