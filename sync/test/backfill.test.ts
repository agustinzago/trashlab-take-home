import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backfill } from "../src/backfill.ts";
import { line, setupSync, type SyncHarness } from "./harness.ts";

let h: SyncHarness;
let item: string;

beforeEach(async () => {
  h = await setupSync();
  item = h.qbo.addItem("Consulting");
  await h.mapRevenue("consulting", item);
});
afterEach(() => h.close());

const qboInvoice = (docNumber: string) => h.qbo.invoices.find((i) => i.DocNumber === docNumber);
const internalInvoice = async (docNumber: string) => (await h.api("GET", `/invoices?docNumber=${docNumber}`))[0];
const candidates = async () => (await h.syncApp.inject({ method: "GET", url: "/admin/api/candidates" })).json();
const qboAmounts = (docNumber: string) =>
  qboInvoice(docNumber).Line.filter((l: any) => l.DetailType === "SalesItemLineDetail").map((l: any) => l.Amount);

/** Invoices that existed on both Sides before the sync: no notifications reach it. */
async function preExisting(docNumber: string, internalCents: number | null, qboAmount: number | null) {
  const name = "Acme Ltd";
  const customer = (await h.api("GET", `/customers?displayName=${encodeURIComponent(name)}`))[0] ?? (await h.api("POST", "/customers", { displayName: name }));
  const qboCustomer = h.qbo.customers.find((c) => c.DisplayName === name)?.Id ?? h.qbo.addCustomer(name);
  if (internalCents !== null) {
    await h.api("POST", "/invoices", {
      docNumber,
      customerId: customer.id,
      txnDate: "2026-10-01",
      dueDate: "2026-10-31",
      memo: "Legacy",
      lines: [line(internalCents)],
      status: "issued",
    });
  }
  if (qboAmount !== null) {
    h.qbo.accountantCreate({
      DocNumber: docNumber,
      TxnDate: "2026-10-01",
      DueDate: "2026-10-31",
      CustomerMemo: { value: "Legacy" },
      CustomerRef: { value: qboCustomer },
      Line: [{ DetailType: "SalesItemLineDetail", Amount: qboAmount, Description: "consulting work", SalesItemLineDetail: { ItemRef: { value: item } } }],
    });
  }
  await h.forgetInternalNotifications();
  h.qbo.events.length = 0;
}

describe("Backfill", () => {
  it("links identical pre-existing pairs without writing anything", async () => {
    await preExisting("INV-1", 10000, 100);
    h.qbo.writes.length = 0;

    await backfill(h.deps, { createMissing: false });
    await h.settle();

    expect(h.qbo.writes).toEqual([]);
    expect(await internalInvoice("INV-1")).toMatchObject({ version: 1 });
    expect((await h.pool.query("SELECT state FROM links WHERE doc_number = 'INV-1'")).rows).toEqual([{ state: "linked" }]);
  });

  it("raises a Link Candidate for a differing pair and writes nothing until it is confirmed", async () => {
    await preExisting("INV-2", 10000, 80);
    h.qbo.writes.length = 0;

    await backfill(h.deps, { createMissing: false });
    await h.settle();

    expect(h.qbo.writes).toEqual([]);
    expect(await internalInvoice("INV-2")).toMatchObject({ version: 1, totalCents: 10000 });
    expect((await h.pool.query("SELECT count(*)::int AS n FROM links")).rows[0].n).toBe(0);
    expect(await candidates()).toMatchObject([
      { docNumber: "INV-2", internal: { lines: [{ amountCents: 10000 }] }, qbo: { lines: [{ amountCents: 8000 }] } },
    ]);
    expect((await h.syncApp.inject({ method: "GET", url: "/admin" })).body).toContain("Link Candidates");
  });

  it.each([
    { winner: "internal", amount: 100 },
    { winner: "qbo", amount: 80 },
  ])("confirming a Link Candidate for $winner makes both Sides equal to the winner", async ({ winner, amount }) => {
    await preExisting("INV-3", 10000, 80);
    await backfill(h.deps, { createMissing: false });
    await h.settle();
    const [candidate] = await candidates();

    const res = await h.syncApp.inject({ method: "POST", url: `/admin/api/candidates/${candidate.id}/confirm`, payload: { winner } });
    expect(res.statusCode).toBe(200);
    await h.settle();

    expect(qboAmounts("INV-3")).toEqual([amount]);
    expect(await internalInvoice("INV-3")).toMatchObject({ totalCents: amount * 100 });
    expect(await candidates()).toEqual([]);
    expect((await h.pool.query("SELECT state FROM links")).rows).toEqual([{ state: "linked" }]);
  });

  it("copies one-sided Invoices across only with --create-missing", async () => {
    await preExisting("INV-4", 5000, null);
    await preExisting("QB-5", null, 25);

    await backfill(h.deps, { createMissing: false });
    await h.settle();
    expect(qboInvoice("INV-4")).toBeUndefined();
    expect(await internalInvoice("QB-5")).toBeUndefined();

    await backfill(h.deps, { createMissing: true });
    await h.settle();
    expect(qboAmounts("INV-4")).toEqual([50]);
    expect(await internalInvoice("QB-5")).toMatchObject({ totalCents: 2500 });
  });

  it("closes a Link Candidate once the pair becomes identical and links", async () => {
    await preExisting("INV-9", 10000, 80);
    await backfill(h.deps, { createMissing: false });
    await h.settle();
    expect(await candidates()).toHaveLength(1);

    const q = qboInvoice("INV-9");
    h.qbo.accountantEdit(q.Id, { Line: [{ ...q.Line[0], Amount: 100 }] });
    await h.settle();

    expect(await candidates()).toEqual([]);
    expect((await h.pool.query("SELECT state FROM links")).rows).toEqual([{ state: "linked" }]);
    const attention = (await h.syncApp.inject({ method: "GET", url: "/admin/api/attention" })).json();
    expect(attention).toEqual([]);
  });

  it("flags a pre-existing pair where only one Side is voided instead of offering a Link Candidate", async () => {
    await preExisting("INV-10", 10000, 100);
    h.qbo.accountantVoid(qboInvoice("INV-10").Id);
    h.qbo.events.length = 0;

    await backfill(h.deps, { createMissing: false });
    await h.settle();

    expect(await candidates()).toEqual([]);
    const attention = (await h.syncApp.inject({ method: "GET", url: "/admin/api/attention" })).json();
    expect(attention).toMatchObject([{ summary: expect.stringMatching(/voided/) }]);
  });

  it("does not show a Link Candidate under Needs Attention as well", async () => {
    await preExisting("INV-11", 10000, 80);
    await backfill(h.deps, { createMissing: false });
    await h.settle();

    expect(await candidates()).toHaveLength(1);
    expect((await h.syncApp.inject({ method: "GET", url: "/admin/api/attention" })).json()).toEqual([]);
  });

  it("changes nothing when run a second time", async () => {
    await preExisting("INV-6", 10000, 100);
    await preExisting("INV-7", 10000, 70);
    await preExisting("INV-8", 3000, null);
    await backfill(h.deps, { createMissing: true });
    await h.settle();
    const invoicesBefore = await h.api("GET", "/invoices");
    const linksBefore = (await h.pool.query("SELECT id, state, base FROM links ORDER BY id")).rows;
    const candidatesBefore = await candidates();
    h.qbo.writes.length = 0;

    await backfill(h.deps, { createMissing: true });
    await h.settle();

    expect(h.qbo.writes).toEqual([]);
    expect(await h.api("GET", "/invoices")).toEqual(invoicesBefore);
    expect((await h.pool.query("SELECT id, state, base FROM links ORDER BY id")).rows).toEqual(linksBefore);
    expect(await candidates()).toEqual(candidatesBefore);
  });
});
