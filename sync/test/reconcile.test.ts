import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reconcile } from "../src/reconcile.ts";
import { line, setupSync, type SyncHarness } from "./harness.ts";

let h: SyncHarness;
let consultingItem: string;

beforeEach(async () => {
  h = await setupSync();
  consultingItem = h.qbo.addItem("Consulting");
  await h.mapRevenue("consulting", consultingItem);
});
afterEach(() => h.close());

async function linked(docNumber: string, amountCents = 10000) {
  const customer = await h.api("POST", "/customers", { displayName: `Customer of ${docNumber}` });
  const inv = await h.api("POST", "/invoices", {
    docNumber,
    customerId: customer.id,
    txnDate: "2026-11-01",
    lines: [line(amountCents)],
    status: "issued",
  });
  await h.settle();
  return inv;
}

describe("Ledger reconciliation", () => {
  it("reports no mismatches for a fully synced dataset, and writes nothing", async () => {
    const a = await linked("INV-1");
    await linked("INV-2", 5000);
    await h.api("POST", "/payments", { invoiceId: a.id, amountCents: 2500, txnDate: "2026-11-05", method: "check" });
    await h.settle();
    h.qbo.writes.length = 0;
    const before = await h.api("GET", "/invoices");

    const report = await reconcile(h.deps);

    expect(report).toEqual({ checked: 2, mismatches: [] });
    expect(h.qbo.writes).toEqual([]);
    expect(await h.api("GET", "/invoices")).toEqual(before);
  });

  it("lists every linked Invoice whose total or balance differs, with both values", async () => {
    const a = await linked("INV-3");
    const b = await linked("INV-4");
    await linked("INV-5");
    // Changes that have not synced yet: a QBO line edit and an internal Payment.
    const q = h.qbo.invoices.find((i) => i.DocNumber === "INV-3");
    h.qbo.accountantEdit(q.Id, {
      Line: [{ DetailType: "SalesItemLineDetail", Amount: 90, Description: "x", SalesItemLineDetail: { ItemRef: { value: consultingItem } } }],
    });
    await h.api("POST", "/payments", { invoiceId: b.id, amountCents: 1000, txnDate: "2026-11-05", method: "check" });

    const report = await reconcile(h.deps);

    expect(report.checked).toBe(3);
    expect(report.mismatches).toEqual([
      {
        docNumber: "INV-3",
        internal: { invoiceId: String(a.id), totalCents: 10000, balanceCents: 10000 },
        qbo: { invoiceId: q.Id, totalCents: 9000, balanceCents: 9000 },
      },
      {
        docNumber: "INV-4",
        internal: { invoiceId: String(b.id), totalCents: 10000, balanceCents: 9000 },
        qbo: { invoiceId: expect.any(String), totalCents: 10000, balanceCents: 10000 },
      },
    ]);
  });
});
