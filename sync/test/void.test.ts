import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { line, setupSync, type SyncHarness } from "./harness.ts";

let h: SyncHarness;
let consultingItem: string;

beforeEach(async () => {
  h = await setupSync();
  consultingItem = h.qbo.addItem("Consulting");
  await h.mapRevenue("consulting", consultingItem);
});
afterEach(() => h.close());

const qboInvoice = (docNumber: string) => h.qbo.invoices.find((i) => i.DocNumber === docNumber);
const lastAttempt = async () => (await h.pool.query("SELECT * FROM sync_attempts ORDER BY id DESC LIMIT 1")).rows[0];
const linkState = async () => (await h.pool.query("SELECT state FROM links")).rows[0].state;
const qboLines = (amount: number) => [
  { DetailType: "SalesItemLineDetail", Amount: amount, Description: "consulting work", SalesItemLineDetail: { ItemRef: { value: consultingItem } } },
];

async function linked(docNumber: string) {
  const customer = await h.api("POST", "/customers", { displayName: `Customer of ${docNumber}` });
  const inv = await h.api("POST", "/invoices", {
    docNumber,
    customerId: customer.id,
    txnDate: "2026-11-01",
    lines: [line(10000)],
    status: "issued",
  });
  await h.settle();
  return inv;
}

describe("Void and Delete", () => {
  it("voids in QBO when the Invoice is voided internally, and closes the Link", async () => {
    const inv = await linked("INV-1");

    await h.api("POST", `/invoices/${inv.id}/void`, undefined, { "if-match": "1" });
    await h.settle();

    expect(qboInvoice("INV-1")).toMatchObject({ TotalAmt: 0, PrivateNote: expect.stringMatching(/^Voided/) });
    expect(await linkState()).toBe("closed");
  });

  it("voids internally when the Invoice is voided in QBO", async () => {
    const inv = await linked("INV-2");

    h.qbo.accountantVoid(qboInvoice("INV-2").Id);
    await h.settle();

    expect(await h.api("GET", `/invoices/${inv.id}`)).toMatchObject({ status: "voided", totalCents: 0 });
    expect(await linkState()).toBe("closed");
  });

  it("voids internally when the Invoice is hard-deleted in QBO", async () => {
    const inv = await linked("INV-3");

    h.qbo.accountantDelete(qboInvoice("INV-3").Id);
    await h.settle();

    expect(await h.api("GET", `/invoices/${inv.id}`)).toMatchObject({ status: "voided" });
    expect(await linkState()).toBe("closed");
  });

  it("lets an internal Void beat a concurrent QBO line edit, recording the discarded edit", async () => {
    const inv = await linked("INV-4");

    h.qbo.accountantEdit(qboInvoice("INV-4").Id, { Line: qboLines(55) });
    await h.api("POST", `/invoices/${inv.id}/void`, undefined, { "if-match": "1" });
    await h.settle();

    expect(qboInvoice("INV-4")).toMatchObject({ TotalAmt: 0 });
    expect(await h.api("GET", `/invoices/${inv.id}`)).toMatchObject({ status: "voided" });
    const attempts = (await h.pool.query("SELECT notes FROM sync_attempts WHERE notes::text LIKE '%discarded%'")).rows;
    expect(attempts[0].notes.join(" ")).toMatch(/discarded QBO edit.*lines/);
  });

  it("lets a QBO Void beat a concurrent internal line edit, recording the discarded edit", async () => {
    const inv = await linked("INV-5");

    await h.api("PATCH", `/invoices/${inv.id}`, { lines: [line(777)] }, { "if-match": "1" });
    h.qbo.accountantVoid(qboInvoice("INV-5").Id);
    await h.settle();

    expect(await h.api("GET", `/invoices/${inv.id}`)).toMatchObject({ status: "voided" });
    expect(qboInvoice("INV-5")).toMatchObject({ TotalAmt: 0 });
    const attempts = (await h.pool.query("SELECT notes FROM sync_attempts WHERE notes::text LIKE '%discarded%'")).rows;
    expect(attempts[0].notes.join(" ")).toMatch(/discarded internal edit.*lines/);
  });

  it("performs no writes for repeated hints after a Void", async () => {
    const inv = await linked("INV-6");
    await h.api("POST", `/invoices/${inv.id}/void`, undefined, { "if-match": "1" });
    await h.settle();
    h.qbo.writes.length = 0;

    await h.sendQboWebhook([{ name: "Invoice", id: qboInvoice("INV-6").Id, operation: "Update", lastUpdated: "2031-01-01T00:00:00Z" }]);
    await h.drain();

    expect(h.qbo.writes).toEqual([]);
    expect(await lastAttempt()).toMatchObject({ outcome: "skipped", summary: expect.stringContaining("closed") });
  });

  it("lets a Void win over an open Conflict", async () => {
    const inv = await linked("INV-8");
    await h.api("PATCH", `/invoices/${inv.id}`, { lines: [line(12000)] }, { "if-match": "1" });
    h.qbo.accountantEdit(qboInvoice("INV-8").Id, { Line: qboLines(80) });
    await h.settle();
    expect(await linkState()).toBe("paused");

    h.qbo.accountantVoid(qboInvoice("INV-8").Id);
    await h.settle();

    expect(await h.api("GET", `/invoices/${inv.id}`)).toMatchObject({ status: "voided" });
    expect(await linkState()).toBe("closed");
    expect((await h.syncApp.inject({ method: "GET", url: "/admin/api/conflicts" })).json()).toEqual([]);
  });

  it("does not void internally on a QBO not-found that no Delete notification confirms", async () => {
    const inv = await linked("INV-9");
    const id = qboInvoice("INV-9").Id;
    h.qbo.accountantDelete(id);
    h.qbo.events.length = 0; // the Delete notification is lost

    await h.sendQboWebhook([{ name: "Invoice", id, operation: "Update", lastUpdated: "2031-01-01T00:00:00Z" }]);
    await h.drain();

    expect(await h.api("GET", `/invoices/${inv.id}`)).toMatchObject({ status: "issued" });
    expect(await lastAttempt()).toMatchObject({ outcome: "attention", summary: expect.stringContaining("not found") });
    expect(await linkState()).toBe("attention");
  });

  it("flags a QBO Invoice zeroed without a Void note instead of merging the zeroed lines", async () => {
    const inv = await linked("INV-10");

    h.qbo.accountantVoid(qboInvoice("INV-10").Id);
    const q = qboInvoice("INV-10");
    q.PrivateNote = "edited after voiding";
    h.qbo.events.length = 0;
    await h.sendQboWebhook([{ name: "Invoice", id: q.Id, operation: "Update", lastUpdated: "2031-01-01T00:00:00Z" }]);
    await h.drain();

    expect(await h.api("GET", `/invoices/${inv.id}`)).toMatchObject({ status: "issued", totalCents: 10000 });
    expect(await lastAttempt()).toMatchObject({ outcome: "attention" });
  });

  it("only lets a draft be deleted internally", async () => {
    const inv = await linked("INV-7");
    const res = await h.api("DELETE", `/invoices/${inv.id}`, undefined, { "if-match": "1" }).catch((e) => e.message);
    expect(res).toContain("422");
  });
});
