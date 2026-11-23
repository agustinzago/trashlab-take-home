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

const INVOICE_WRITE = /\/invoice$/;
const attempts = async () => (await h.pool.query("SELECT outcome, summary, writes, error FROM sync_attempts ORDER BY id")).rows;
const links = async () => (await h.pool.query("SELECT internal_id, qbo_id, state FROM links")).rows;
const jobs = async () => (await h.pool.query("SELECT status, attempts FROM sync_jobs ORDER BY id")).rows;
const qboInvoice = (docNumber: string) => h.qbo.invoices.find((i) => i.DocNumber === docNumber);
const salesAmounts = (inv: any) => inv.Line.filter((l: any) => l.DetailType === "SalesItemLineDetail").map((l: any) => l.Amount);
const invoiceWrites = () => h.qbo.writes.filter((w) => INVOICE_WRITE.test(w.path));

async function issue(docNumber: string, extra: object = {}) {
  const customer = await h.api("POST", "/customers", { displayName: `Customer of ${docNumber}` });
  return h.api("POST", "/invoices", {
    docNumber,
    customerId: customer.id,
    txnDate: "2026-11-01",
    memo: "Thanks",
    lines: [line(10000)],
    status: "issued",
    ...extra,
  });
}

describe("Safe writes", () => {
  it.each([{ dedupe: false }, { dedupe: true }])(
    "a create that times out after QBO committed it yields exactly one QBO Invoice (requestid replay $dedupe)",
    async ({ dedupe }) => {
      h.qbo.requestIdDedupe = dedupe;
      h.qbo.injectFault("timeoutAfterCommit", { path: INVOICE_WRITE });
      const inv = await issue("INV-1");

      await h.settle();

      expect(h.qbo.invoices).toHaveLength(1);
      expect(await links()).toEqual([{ internal_id: String(inv.id), qbo_id: h.qbo.invoices[0].Id, state: "linked" }]);
      expect((await attempts())[0]).toMatchObject({ outcome: "failed", error: expect.stringContaining("transient") });
    },
  );

  it("does not adopt someone else's QBO Invoice that appeared with the same DocNumber while ours was pending", async () => {
    const customerId = h.qbo.addCustomer("Customer of INV-9"); // reused, so our first write is the Invoice
    h.qbo.injectFault("timeoutBeforeCommit", { path: INVOICE_WRITE });
    // Our first create is lost; just as the retry writes, an accountant creates their own INV-9.
    h.qbo.beforeNextWrite(() =>
      h.qbo.accountantCreate({
        DocNumber: "INV-9",
        TxnDate: "2026-11-05",
        CustomerRef: { value: customerId },
        Line: [{ DetailType: "SalesItemLineDetail", Amount: 5, Description: "other", SalesItemLineDetail: { ItemRef: { value: consultingItem } } }],
      }),
    );
    const inv = await issue("INV-9");

    await h.settle();

    expect(h.qbo.invoices).toHaveLength(1);
    expect(salesAmounts(h.qbo.invoices[0])).toEqual([5]); // untouched
    expect(await h.api("GET", `/invoices/${inv.id}`)).toMatchObject({ totalCents: 10000, txnDate: "2026-11-01" });
    expect((await attempts()).at(-1)).toMatchObject({ outcome: "attention", summary: expect.stringContaining("INV-9") });
  });

  it("a create that times out before QBO committed it is retried and creates exactly one", async () => {
    h.qbo.injectFault("timeoutBeforeCommit", { path: INVOICE_WRITE });
    await issue("INV-2");

    await h.settle();

    expect(h.qbo.invoices).toHaveLength(1);
    expect((await links())[0]).toMatchObject({ state: "linked", qbo_id: h.qbo.invoices[0].Id });
  });

  it("after QBO accepts its half and the internal write fails, the retry performs only the internal write", async () => {
    const inv = await issue("INV-3");
    await h.settle();
    await h.api("PATCH", `/invoices/${inv.id}`, { lines: [line(12000)] }, { "if-match": "1" });
    h.qbo.accountantEdit(qboInvoice("INV-3").Id, { CustomerMemo: { value: "Net 30" } });
    // A user touches the Invoice between our QBO write and our internal write, so If-Match fails with 409.
    h.beforeNextInternalRequest("PATCH", /^\/invoices\//, () =>
      h.api("PATCH", `/invoices/${inv.id}`, { memo: "Thanks" }, { "if-match": "2" }),
    );
    h.qbo.writes.length = 0;
    const before = (await attempts()).length;

    await h.settle();

    expect(invoiceWrites()).toHaveLength(1); // the line update, never repeated
    expect(salesAmounts(qboInvoice("INV-3"))).toEqual([120]);
    expect(await h.api("GET", `/invoices/${inv.id}`)).toMatchObject({ memo: "Net 30", totalCents: 12000 });
    const [failed, retried] = (await attempts()).slice(before);
    expect(failed).toMatchObject({
      outcome: "failed",
      error: expect.stringContaining("stale"),
      writes: [{ side: "qbo", action: "update", entity: "Invoice", fields: ["lines"] }],
    });
    expect(retried).toMatchObject({ outcome: "synced", writes: [{ side: "internal", action: "update", fields: ["memo"] }] });
  });

  it("does not mistake its own QBO write for a QBO edit when the internal half fails", async () => {
    const inv = await issue("INV-3B");
    await h.settle();
    await h.api("PATCH", `/invoices/${inv.id}`, { lines: [line(12000)] }, { "if-match": "1" });
    h.qbo.accountantEdit(qboInvoice("INV-3B").Id, { CustomerMemo: { value: "Net 30" } });
    // After our line update reaches QBO, the user changes the lines again internally.
    h.beforeNextInternalRequest("PATCH", /^\/invoices\//, () =>
      h.api("PATCH", `/invoices/${inv.id}`, { lines: [line(13000)] }, { "if-match": "2" }),
    );

    await h.settle();

    expect((await h.pool.query("SELECT count(*)::int AS n FROM conflicts")).rows[0].n).toBe(0);
    expect(salesAmounts(qboInvoice("INV-3B"))).toEqual([130]);
    expect(await h.api("GET", `/invoices/${inv.id}`)).toMatchObject({ memo: "Net 30", totalCents: 13000 });
  });

  it("a 5010 during an update refetches, re-merges and keeps the concurrent QBO edit", async () => {
    const inv = await issue("INV-4");
    await h.settle();
    await h.api("PATCH", `/invoices/${inv.id}`, { lines: [line(9000)] }, { "if-match": "1" });
    h.qbo.beforeNextWrite(() => h.qbo.accountantEdit(qboInvoice("INV-4").Id, { CustomerMemo: { value: "accountant" } }));

    await h.settle();

    const q = qboInvoice("INV-4");
    expect(q.CustomerMemo).toEqual({ value: "accountant" });
    expect(salesAmounts(q)).toEqual([90]);
    expect(await h.api("GET", `/invoices/${inv.id}`)).toMatchObject({ memo: "accountant", totalCents: 9000 });
    expect((await attempts()).map((a) => a.outcome)).toContain("failed");
    expect((await attempts()).find((a) => a.outcome === "failed").error).toContain("stale");
  });

  it("retries 500 and 429 with backoff and then succeeds", async () => {
    h.qbo.injectFault(500, { path: INVOICE_WRITE });
    h.qbo.injectFault(429, { path: INVOICE_WRITE });
    await issue("INV-5");

    await h.settle();

    expect(h.qbo.invoices).toHaveLength(1);
    const outcomes = (await attempts()).map((a) => a.outcome);
    expect(outcomes.slice(0, 3)).toEqual(["failed", "failed", "synced"]);
  });

  it("fails the job visibly once transient retries are exhausted", async () => {
    h.qbo.injectFault(500, { path: INVOICE_WRITE, times: 100 });
    await issue("INV-6");

    await h.settle();

    expect(h.qbo.invoices).toHaveLength(0);
    expect(await jobs()).toContainEqual({ status: "failed", attempts: 10 });
    const failed = (await h.syncApp.inject({ method: "GET", url: "/admin/api/failed-jobs" })).json();
    expect(failed).toHaveLength(1);
  });

  it("fails a job at once on a permanent error", async () => {
    await h.mapRevenue("consulting", "999"); // QBO rejects the reference: retrying cannot help
    await issue("INV-7");

    await h.settle();

    expect(await jobs()).toContainEqual({ status: "failed", attempts: 1 });
  });

  it("holds work while the QBO connection is expired and resumes after reconnecting", async () => {
    h.qbo.authExpired = true;
    await issue("INV-8");

    await h.settle();
    await h.advanceClock();
    await h.drain(); // still expired: held again, not failed

    expect(h.qbo.invoices).toHaveLength(0);
    expect((await jobs()).filter((j) => j.status === "pending")).toHaveLength(1);
    expect((await attempts()).at(-1)).toMatchObject({ outcome: "failed", error: expect.stringContaining("auth") });

    h.qbo.authExpired = false;
    await h.advanceClock();
    await h.settle();

    expect(h.qbo.invoices).toHaveLength(1);
    expect((await links())[0]).toMatchObject({ state: "linked" });
  });
});
