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

const qboLines = (amounts: number[]) =>
  amounts.map((a) => ({
    DetailType: "SalesItemLineDetail",
    Amount: a,
    Description: "consulting work",
    SalesItemLineDetail: { ItemRef: { value: consultingItem } },
  }));
const qboAmounts = (docNumber: string) =>
  h.qbo.invoices
    .find((i) => i.DocNumber === docNumber)
    .Line.filter((l: any) => l.DetailType === "SalesItemLineDetail")
    .map((l: any) => l.Amount);
const qboInvoice = (docNumber: string) => h.qbo.invoices.find((i) => i.DocNumber === docNumber);
const admin = async (method: string, url: string, payload?: object) => {
  const res = await h.syncApp.inject({ method: method as any, url, payload });
  if (res.statusCode >= 400) throw new Error(`${method} ${url} -> ${res.statusCode} ${res.body}`);
  return res;
};
const openConflicts = async () => (await admin("GET", "/admin/api/conflicts")).json();
const linkState = async () => (await h.pool.query("SELECT state FROM links")).rows[0].state;

/** A linked Invoice whose lines were then edited differently on both Sides: internal 120, QBO 80. */
async function conflicted(docNumber: string) {
  const customer = await h.api("POST", "/customers", { displayName: `Customer of ${docNumber}` });
  const inv = await h.api("POST", "/invoices", {
    docNumber,
    customerId: customer.id,
    txnDate: "2026-11-01",
    memo: "Thanks",
    lines: [line(10000)],
    status: "issued",
  });
  await h.settle();
  await h.api("PATCH", `/invoices/${inv.id}`, { lines: [line(12000)] }, { "if-match": "1" });
  h.qbo.accountantEdit(qboInvoice(docNumber).Id, { Line: qboLines([80]), CustomerMemo: { value: "clean QBO edit" } });
  h.qbo.writes.length = 0;
  await h.settle();
  return inv;
}

describe("Conflicts", () => {
  it("raises one Conflict for different line edits on both Sides and pauses the whole Invoice", async () => {
    const inv = await conflicted("INV-1");

    expect(h.qbo.writes).toEqual([]);
    expect(await h.api("GET", `/invoices/${inv.id}`)).toMatchObject({ version: 2, memo: "Thanks", totalCents: 12000 });
    expect(await linkState()).toBe("paused");
    expect(await openConflicts()).toMatchObject([
      {
        docNumber: "INV-1",
        fields: [
          {
            field: "lines",
            base: [{ amountCents: 10000 }],
            internal: [{ amountCents: 12000 }],
            qbo: [{ amountCents: 8000 }],
          },
        ],
      },
    ]);
  });

  it("records hints for a paused Invoice without writing", async () => {
    const inv = await conflicted("INV-2");
    const hintsBefore = (await h.pool.query("SELECT count(*)::int AS n FROM change_hints")).rows[0].n;

    await h.api("PATCH", `/invoices/${inv.id}`, { memo: "edited while paused" }, { "if-match": "2" });
    await h.settle();

    expect((await h.pool.query("SELECT count(*)::int AS n FROM change_hints")).rows[0].n).toBe(hintsBefore + 1);
    expect(h.qbo.writes).toEqual([]);
    expect(qboInvoice("INV-2").CustomerMemo).toEqual({ value: "clean QBO edit" });
    const last = (await h.pool.query("SELECT outcome FROM sync_attempts ORDER BY id DESC LIMIT 1")).rows[0];
    expect(last.outcome).toBe("paused");
  });

  it("shows the Conflict with the Base and both values, and the Sync Attempt history", async () => {
    await conflicted("INV-3");
    const linkId = (await h.pool.query("SELECT id FROM links")).rows[0].id;

    const page = (await admin("GET", "/admin")).body;
    expect(page).toContain("INV-3");
    expect(page).toContain("100.00"); // Base
    expect(page).toContain("120.00"); // internal
    expect(page).toContain("80.00"); // QBO
    expect(page).toMatch(/<form[^>]+method="post"/i);

    const history = (await admin("GET", `/admin/links/${linkId}`)).body;
    expect(history).toContain("Created QBO Invoice");
    expect(history).toContain("Conflict");
    expect((await admin("GET", `/admin/api/links/${linkId}/attempts`)).json().map((a: any) => a.outcome)).toContain("conflict");
  });

  it.each([
    { winner: "internal", amount: 120 },
    { winner: "qbo", amount: 80 },
  ])("resolving for $winner makes both Sides equal to the winner and unpauses", async ({ winner, amount }) => {
    const inv = await conflicted(`INV-${winner}`);
    const [conflict] = await openConflicts();

    await admin("POST", `/admin/api/conflicts/${conflict.id}/resolve`, { winner });
    await h.settle();

    expect(qboAmounts(`INV-${winner}`)).toEqual([amount]);
    expect(await h.api("GET", `/invoices/${inv.id}`)).toMatchObject({ totalCents: amount * 100 });
    // the clean QBO memo edit, held back while paused, now goes through too
    expect(await h.api("GET", `/invoices/${inv.id}`)).toMatchObject({ memo: "clean QBO edit" });
    expect(await linkState()).toBe("linked");
    expect(await openConflicts()).toEqual([]);
  });

  it("resolves from the admin page form", async () => {
    await conflicted("INV-4");
    const [conflict] = await openConflicts();

    const res = await h.syncApp.inject({
      method: "POST",
      url: `/admin/conflicts/${conflict.id}/resolve`,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "winner=qbo",
    });
    expect(res.statusCode).toBe(303);
    await h.settle();

    expect(await openConflicts()).toEqual([]);
    expect(await linkState()).toBe("linked");
  });

  it("refuses to resolve a Conflict twice", async () => {
    await conflicted("INV-6");
    const [conflict] = await openConflicts();
    await admin("POST", `/admin/api/conflicts/${conflict.id}/resolve`, { winner: "qbo" });

    const again = await h.syncApp.inject({
      method: "POST",
      url: `/admin/api/conflicts/${conflict.id}/resolve`,
      payload: { winner: "internal" },
    });
    expect(again.statusCode).toBe(409);
  });

  it("re-conflicts when the losing Side was edited after the Conflict was raised", async () => {
    const inv = await conflicted("INV-5");
    const [conflict] = await openConflicts();
    await h.api("PATCH", `/invoices/${inv.id}`, { lines: [line(15000)] }, { "if-match": "2" });

    await admin("POST", `/admin/api/conflicts/${conflict.id}/resolve`, { winner: "qbo" });
    await h.settle();

    expect(qboAmounts("INV-5")).toEqual([80]);
    expect(await h.api("GET", `/invoices/${inv.id}`)).toMatchObject({ totalCents: 15000 });
    expect(await linkState()).toBe("paused");
    expect(await openConflicts()).toMatchObject([{ fields: [{ field: "lines", internal: [{ amountCents: 15000 }], qbo: [{ amountCents: 8000 }] }] }]);
  });
});
