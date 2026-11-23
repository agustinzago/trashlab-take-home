import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pollCdc } from "../src/cdc.ts";
import { line, setupSync, type SyncHarness } from "./harness.ts";

let h: SyncHarness;

beforeEach(async () => {
  h = await setupSync();
  await h.mapRevenue("consulting", h.qbo.addItem("Consulting"));
});
afterEach(() => h.close());

const qboInvoice = (docNumber: string) => h.qbo.invoices.find((i) => i.DocNumber === docNumber);

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

describe("QBO change data capture", () => {
  it("picks up a QBO change whose webhook never arrived", async () => {
    const inv = await linked("INV-1");
    await pollCdc(h.deps);

    h.qbo.accountantEdit(qboInvoice("INV-1").Id, { CustomerMemo: { value: "missed webhook" } });
    h.qbo.events.length = 0; // the webhook is lost
    await pollCdc(h.deps);
    await h.drain();

    expect(await h.api("GET", `/invoices/${inv.id}`)).toMatchObject({ memo: "missed webhook" });
  });

  it("resumes from its stored cursor after a restart without missing changes", async () => {
    const inv = await linked("INV-2");
    await pollCdc(h.deps);
    const { rows: before } = await h.pool.query("SELECT cursor FROM cdc_cursor");
    expect(before).toHaveLength(1);

    // A change while the service is down; on restart the poll asks QBO from the stored cursor (less the overlap).
    h.qbo.accountantEdit(qboInvoice("INV-2").Id, { DueDate: "2027-03-01" });
    h.qbo.events.length = 0;
    await pollCdc(h.deps);
    await h.drain();

    expect(Date.parse(h.qbo.cdcRequests.at(-1)!)).toBe(before[0].cursor.getTime() - 60_000);
    expect(await h.api("GET", `/invoices/${inv.id}`)).toMatchObject({ dueDate: "2027-03-01" });
    const { rows: after } = await h.pool.query("SELECT cursor FROM cdc_cursor");
    expect(Date.parse(after[0].cursor)).toBeGreaterThan(Date.parse(before[0].cursor));
  });

  it("catches a change that landed just before the cursor, inside the overlap", async () => {
    const inv = await linked("INV-6");
    await pollCdc(h.deps);
    const { rows } = await h.pool.query("SELECT cursor FROM cdc_cursor");

    const q = h.qbo.accountantEdit(qboInvoice("INV-6").Id, { CustomerMemo: { value: "late arrival" } });
    q.MetaData.LastUpdatedTime = new Date(rows[0].cursor.getTime() - 30_000).toISOString(); // committed as the last poll ran
    h.qbo.events.length = 0;
    await pollCdc(h.deps);
    await h.drain();

    expect(await h.api("GET", `/invoices/${inv.id}`)).toMatchObject({ memo: "late arrival" });
  });

  it("does not hint the same unchanged record again on an overlapping poll", async () => {
    await linked("INV-3");
    await pollCdc(h.deps);
    const hints = (await h.pool.query("SELECT count(*)::int AS n FROM change_hints")).rows[0].n;

    await pollCdc(h.deps);

    expect((await h.pool.query("SELECT count(*)::int AS n FROM change_hints")).rows[0].n).toBe(hints);
  });

  it("voids the internal Invoice for a hard delete reported only by CDC", async () => {
    const inv = await linked("INV-4");
    await pollCdc(h.deps);

    h.qbo.accountantDelete(qboInvoice("INV-4").Id);
    h.qbo.events.length = 0;
    await pollCdc(h.deps);
    await h.drain();

    expect(await h.api("GET", `/invoices/${inv.id}`)).toMatchObject({ status: "voided" });
  });

  it("flags a hard delete when Payments are applied internally", async () => {
    const inv = await linked("INV-5");
    await h.api("POST", "/payments", { invoiceId: inv.id, amountCents: 1000, txnDate: "2026-11-05", method: "check" });
    await h.settle();
    await pollCdc(h.deps);

    h.qbo.accountantDelete(qboInvoice("INV-5").Id);
    h.qbo.events.length = 0;
    await pollCdc(h.deps);
    await h.drain();

    expect(await h.api("GET", `/invoices/${inv.id}`)).toMatchObject({ status: "issued" });
    const invoiceAttempts = (await h.pool.query("SELECT outcome, summary FROM sync_attempts WHERE trigger->>'recordType' = 'invoice' ORDER BY id")).rows;
    expect(invoiceAttempts.at(-1)).toMatchObject({ outcome: "attention", summary: expect.stringMatching(/Payments/) });
  });
});
