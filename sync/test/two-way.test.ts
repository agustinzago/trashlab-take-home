import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { line, setupSync, type SyncHarness } from "./harness.ts";

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

const qboLine = (amount: number, itemId: string, description: string) => ({
  DetailType: "SalesItemLineDetail",
  Amount: amount,
  Description: description,
  SalesItemLineDetail: { ItemRef: { value: itemId } },
});
const salesLines = (inv: any) =>
  inv.Line.filter((l: any) => l.DetailType === "SalesItemLineDetail").map((l: any) => [l.Description, l.Amount]);
const attempts = async () => (await h.pool.query("SELECT * FROM sync_attempts ORDER BY id")).rows;
const qboInvoice = (docNumber: string) => h.qbo.invoices.find((i) => i.DocNumber === docNumber);
const internalInvoice = async (docNumber: string) => (await h.api("GET", `/invoices?docNumber=${docNumber}`))[0];

/** An Invoice issued internally and synced to QBO. */
async function linkedInvoice(docNumber: string) {
  const customer = await h.api("POST", "/customers", { displayName: `Customer of ${docNumber}` });
  const inv = await h.api("POST", "/invoices", {
    docNumber,
    customerId: customer.id,
    txnDate: "2026-11-01",
    dueDate: "2026-12-01",
    memo: "Thanks",
    lines: [line(10000)],
    status: "issued",
  });
  await h.settle();
  return inv;
}

describe("Two-way sync", () => {
  it("brings an Invoice created in QBO into the Internal System with a Link", async () => {
    const customerId = h.qbo.addCustomer("Initech");
    const created = h.qbo.accountantCreate({
      DocNumber: "QB-1",
      TxnDate: "2026-11-03",
      DueDate: "2026-12-03",
      CustomerMemo: { value: "From the accountant" },
      CustomerRef: { value: customerId },
      Line: [qboLine(250, consultingItem, "Advice"), qboLine(12.34, hostingItem, "Servers")],
    });

    await h.settle();

    const inv = await internalInvoice("QB-1");
    expect(inv).toMatchObject({
      status: "issued",
      txnDate: "2026-11-03",
      dueDate: "2026-12-03",
      memo: "From the accountant",
      totalCents: 26234,
      lines: [
        { description: "Advice", amountCents: 25000, revenueCategory: "consulting" },
        { description: "Servers", amountCents: 1234, revenueCategory: "hosting" },
      ],
    });
    expect((await h.api("GET", `/customers/${inv.customerId}`)).displayName).toBe("Initech");
    const { rows } = await h.pool.query("SELECT internal_id, qbo_id, state FROM links");
    expect(rows).toEqual([{ internal_id: String(inv.id), qbo_id: created.Id, state: "linked" }]);
    expect(h.qbo.invoices).toHaveLength(1); // the echo did not create a second one
  });

  it("copies an internal edit to QBO", async () => {
    const inv = await linkedInvoice("INV-1");

    await h.api("PATCH", `/invoices/${inv.id}`, { memo: "Updated", lines: [line(15000), line(500, "hosting")] }, { "if-match": "1" });
    await h.settle();

    const q = qboInvoice("INV-1");
    expect(q.CustomerMemo).toEqual({ value: "Updated" });
    expect(salesLines(q)).toEqual([
      ["consulting work", 150],
      ["hosting work", 5],
    ]);
    expect(q.TotalAmt).toBe(155);
  });

  it("copies a QBO edit to the Internal System", async () => {
    const inv = await linkedInvoice("INV-2");

    h.qbo.accountantEdit(qboInvoice("INV-2").Id, { DueDate: "2027-01-15", TxnDate: "2026-11-02" });
    await h.settle();

    expect(await h.api("GET", `/invoices/${inv.id}`)).toMatchObject({ dueDate: "2027-01-15", txnDate: "2026-11-02", version: 2 });
  });

  it("keeps both a QBO memo edit and a concurrent internal line edit", async () => {
    const inv = await linkedInvoice("INV-3");

    h.qbo.accountantEdit(qboInvoice("INV-3").Id, { CustomerMemo: { value: "Net 30" } });
    await h.api("PATCH", `/invoices/${inv.id}`, { lines: [line(9000)] }, { "if-match": "1" });
    await h.settle();

    expect(await h.api("GET", `/invoices/${inv.id}`)).toMatchObject({ memo: "Net 30", totalCents: 9000 });
    const q = qboInvoice("INV-3");
    expect(q.CustomerMemo).toEqual({ value: "Net 30" });
    expect(salesLines(q)).toEqual([["consulting work", 90]]);
  });

  it("writes nothing on a rerun with no real change", async () => {
    const inv = await linkedInvoice("INV-4");
    const before = await h.api("GET", `/invoices/${inv.id}`);
    h.qbo.writes.length = 0;

    const res = await h.sendQboWebhook([
      { name: "Invoice", id: qboInvoice("INV-4").Id, operation: "Update", lastUpdated: "2030-01-01T00:00:00Z" },
    ]);
    expect(res.statusCode).toBe(200);
    await h.drain();

    expect(h.qbo.writes).toEqual([]);
    expect(await h.api("GET", `/invoices/${inv.id}`)).toEqual(before);
    expect((await attempts()).at(-1)).toMatchObject({ outcome: "synced", writes: [] });
  });

  it("flags a DocNumber change as Needs Attention and does not sync it", async () => {
    const inv = await linkedInvoice("INV-5");

    await h.api("PATCH", `/invoices/${inv.id}`, { docNumber: "INV-5-RENAMED", memo: "also changed" }, { "if-match": "1" });
    await h.settle();

    expect(qboInvoice("INV-5")).toMatchObject({ CustomerMemo: { value: "Thanks" } });
    expect(qboInvoice("INV-5-RENAMED")).toBeUndefined();
    expect((await attempts()).at(-1)).toMatchObject({ outcome: "attention", summary: expect.stringContaining("DocNumber") });
    expect((await h.pool.query("SELECT state FROM links")).rows).toEqual([{ state: "attention" }]);
  });

  it("flags a QBO Invoice with a line type it cannot sync instead of dropping the line", async () => {
    const customerId = h.qbo.addCustomer("Initech");
    h.qbo.accountantCreate({
      DocNumber: "QB-2",
      TxnDate: "2026-11-03",
      CustomerRef: { value: customerId },
      Line: [qboLine(100, consultingItem, "Advice"), { DetailType: "DiscountLineDetail", Amount: 10, DiscountLineDetail: {} }],
    });

    await h.settle();

    expect(await internalInvoice("QB-2")).toBeUndefined();
    expect((await attempts()).at(-1)).toMatchObject({ outcome: "attention", summary: expect.stringContaining("DiscountLineDetail") });
  });

  it("rejects a QBO webhook with a bad signature", async () => {
    const res = await h.syncApp.inject({
      method: "POST",
      url: "/webhooks/qbo",
      headers: { "content-type": "application/json", "intuit-signature": "bm9wZQ==" },
      payload: JSON.stringify({ eventNotifications: [] }),
    });
    expect(res.statusCode).toBe(401);
  });
});
