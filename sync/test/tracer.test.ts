import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { line, setupSync, webhookSecret, type SyncHarness } from "./harness.ts";

let h: SyncHarness;
let consultingItem: string;
let hostingItem: string;

beforeEach(async () => {
  h = await setupSync();
  consultingItem = h.qbo.addItem("Consulting");
  hostingItem = h.qbo.addItem("Hosting");
  await h.mapRevenue("consulting", consultingItem);
  await h.mapRevenue("hosting", hostingItem);
});
afterEach(() => h.close());

async function issueInvoice(docNumber: string, customerName = "Acme Ltd", extra: object = {}) {
  const customers = await h.api("GET", `/customers?displayName=${encodeURIComponent(customerName)}`);
  const customer = customers[0] ?? (await h.api("POST", "/customers", { displayName: customerName }));
  return h.api("POST", "/invoices", {
    docNumber,
    customerId: customer.id,
    txnDate: "2026-11-01",
    dueDate: "2026-12-01",
    memo: "Thanks for your business",
    lines: [line(10000), line(2550, "hosting")],
    status: "issued",
    ...extra,
  });
}

const attempts = async () => (await h.pool.query("SELECT * FROM sync_attempts ORDER BY id")).rows;
const sign = (body: string) => "sha256=" + createHmac("sha256", webhookSecret).update(body).digest("hex");
const links = async () => (await h.pool.query("SELECT * FROM links ORDER BY id")).rows;

describe("An internal Invoice appears in QBO", () => {
  it("creates one matching QBO Invoice and a Link joining them", async () => {
    const inv = await issueInvoice("INV-100");

    await h.deliver();
    await h.drain();

    expect(h.qbo.invoices).toHaveLength(1);
    const qboInvoice = h.qbo.invoices[0];
    expect(qboInvoice).toMatchObject({
      DocNumber: "INV-100",
      TxnDate: "2026-11-01",
      DueDate: "2026-12-01",
      CustomerMemo: { value: "Thanks for your business" },
      CustomerRef: { name: "Acme Ltd" },
      TotalAmt: 125.5,
    });
    const salesLines = qboInvoice.Line.filter((l: any) => l.DetailType === "SalesItemLineDetail");
    expect(salesLines.map((l: any) => [l.Description, l.Amount, l.SalesItemLineDetail.ItemRef.value])).toEqual([
      ["consulting work", 100, consultingItem],
      ["hosting work", 25.5, hostingItem],
    ]);
    expect(await links()).toMatchObject([
      { record_type: "invoice", internal_id: String(inv.id), qbo_id: qboInvoice.Id, doc_number: "INV-100", state: "linked" },
    ]);
  });

  it("never syncs a draft", async () => {
    await issueInvoice("INV-101", "Acme Ltd", { status: "draft" });

    await h.deliver();
    await h.drain();

    expect(h.qbo.invoices).toHaveLength(0);
    expect(await links()).toHaveLength(0);
    expect(await attempts()).toMatchObject([{ outcome: "skipped", summary: expect.stringMatching(/draft/i) }]);
  });

  it("syncs a draft once it is issued", async () => {
    const inv = await issueInvoice("INV-102", "Acme Ltd", { status: "draft" });
    await h.deliver();
    await h.drain();

    await h.api("POST", `/invoices/${inv.id}/issue`, undefined, { "if-match": "1" });
    await h.deliver();
    await h.drain();

    expect(h.qbo.invoices.map((i) => i.DocNumber)).toEqual(["INV-102"]);
  });

  it("creates a missing customer in QBO on first use and reuses it afterwards", async () => {
    await issueInvoice("INV-103", "Globex");
    await issueInvoice("INV-104", "Globex");

    await h.deliver();
    await h.drain();

    expect(h.qbo.customers.map((c) => c.DisplayName)).toEqual(["Globex"]);
    expect(new Set(h.qbo.invoices.map((i) => i.CustomerRef.value))).toEqual(new Set([h.qbo.customers[0].Id]));
  });

  it("reuses a customer that already exists in QBO", async () => {
    const existing = h.qbo.addCustomer("O'Brien & Sons");
    await issueInvoice("INV-105", "O'Brien & Sons");

    await h.deliver();
    await h.drain();

    expect(h.qbo.customers).toHaveLength(1);
    expect(h.qbo.invoices[0].CustomerRef.value).toBe(existing);
  });

  it("rejects a webhook with a bad signature and records nothing", async () => {
    const body = JSON.stringify({ deliveryId: "999", type: "invoice", id: 1 });
    const res = await h.syncApp.inject({
      method: "POST",
      url: "/webhooks/internal",
      headers: { "content-type": "application/json", "x-signature": "sha256=" + "0".repeat(64) },
      payload: body,
    });

    expect(res.statusCode).toBe(401);
    expect((await h.pool.query("SELECT count(*)::int AS n FROM change_hints")).rows[0].n).toBe(0);
  });

  it("turns the same webhook delivered twice into one job and one QBO Invoice", async () => {
    const inv = await issueInvoice("INV-106");
    const body = JSON.stringify({ deliveryId: "42", type: "invoice", id: inv.id });
    const send = () =>
      h.syncApp.inject({
        method: "POST",
        url: "/webhooks/internal",
        headers: { "content-type": "application/json", "x-signature": sign(body) },
        payload: body,
      });

    expect((await send()).statusCode).toBe(204);
    await h.drain();
    expect((await send()).statusCode).toBe(204); // redelivered after the first run finished
    await h.drain();

    expect((await h.pool.query("SELECT count(*)::int AS n FROM change_hints")).rows[0].n).toBe(1);
    expect((await h.pool.query("SELECT count(*)::int AS n FROM sync_jobs")).rows[0].n).toBe(1);
    expect(h.qbo.invoices).toHaveLength(1);
  });

  it("coalesces a burst of different hints for one Invoice into one pending job", async () => {
    const inv = await issueInvoice("INV-107");
    await h.api("PATCH", `/invoices/${inv.id}`, { memo: "a" }, { "if-match": "1" });
    await h.api("PATCH", `/invoices/${inv.id}`, { memo: "b" }, { "if-match": "2" });

    await h.deliver();

    expect((await h.pool.query("SELECT count(*)::int AS n FROM change_hints")).rows[0].n).toBe(4); // customer + 3 invoice
    expect((await h.pool.query("SELECT count(*)::int AS n FROM sync_jobs")).rows[0].n).toBe(1);
  });

  it("writes one Sync Attempt per run explaining what it wrote", async () => {
    const inv = await issueInvoice("INV-108", "Initech");

    await h.deliver();
    await h.drain();

    const [attempt] = await attempts();
    expect(await attempts()).toHaveLength(1);
    const [link] = await links();
    expect(attempt).toMatchObject({
      link_id: link.id,
      outcome: "synced",
      trigger: { side: "internal", recordType: "invoice", recordId: String(inv.id) },
      writes: [
        { side: "qbo", action: "create", entity: "Customer", id: h.qbo.customers[0].Id },
        { side: "qbo", action: "create", entity: "Invoice", id: h.qbo.invoices[0].Id },
      ],
    });
    expect(attempt.summary).toContain(h.qbo.invoices[0].Id);
    expect(attempt.snapshots.internal).toMatchObject({ docNumber: "INV-108", version: 1 });
  });

  it("records a failed attempt with the writes that landed before the failure", async () => {
    await h.mapRevenue("hosting", "999"); // an Item QBO does not have
    await issueInvoice("INV-110", "Umbrella");

    await h.deliver();
    await h.drain();

    expect(h.qbo.invoices).toHaveLength(0);
    expect(await attempts()).toMatchObject([
      {
        outcome: "failed",
        error: expect.stringContaining("ItemRef"),
        writes: [{ side: "qbo", action: "create", entity: "Customer", id: h.qbo.customers[0].Id }],
      },
    ]);
    // QBO rejected the reference: a permanent error, so the job fails at once rather than retrying.
    const { rows } = await h.pool.query("SELECT status, attempts FROM sync_jobs");
    expect(rows).toEqual([{ status: "failed", attempts: 1 }]);
  });

  it("marks an Invoice whose revenue category has no Account Mapping as Needs Attention", async () => {
    const customer = await h.api("POST", "/customers", { displayName: "Hooli" });
    await h.api("POST", "/invoices", {
      docNumber: "INV-109",
      customerId: customer.id,
      txnDate: "2026-11-01",
      lines: [line(100, "training")],
      status: "issued",
    });

    await h.deliver();
    await h.drain();

    expect(h.qbo.invoices).toHaveLength(0);
    expect(await attempts()).toMatchObject([{ outcome: "attention", summary: expect.stringContaining("training") }]);
  });
});
