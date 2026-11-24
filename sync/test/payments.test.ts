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
const attentionSummaries = async () =>
  (await h.pool.query("SELECT summary FROM sync_attempts WHERE outcome = 'attention' ORDER BY id")).rows.map((r) => r.summary);
const internalPayments = (invoiceId: number) => h.api("GET", `/payments?invoiceId=${invoiceId}`);
const qboLines = (amount: number) => [
  { DetailType: "SalesItemLineDetail", Amount: amount, Description: "consulting work", SalesItemLineDetail: { ItemRef: { value: consultingItem } } },
];

/** An issued $100 Invoice, synced to QBO. */
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
  return { inv, q: qboInvoice(docNumber) };
}

const pay = (invoiceId: number, amountCents: number, extra: object = {}) =>
  h.api("POST", "/payments", { invoiceId, amountCents, txnDate: "2026-11-10", method: "check", ...extra });

describe("Payments", () => {
  it("creates an internal Payment in QBO, applied to the Invoice, with its ref and deposit account", async () => {
    const { inv, q } = await linked("INV-1");
    const bank = h.qbo.addAccount("Checking");
    await h.pool.query("INSERT INTO account_mappings (kind, internal_key, qbo_ref) VALUES ('payment_method', 'check', $1)", [bank]);

    const p = await pay(inv.id, 4000, { ref: "CHK-1001" });
    await pay(inv.id, 1000, { method: "cash" });
    await h.settle();

    expect(h.qbo.payments).toHaveLength(2);
    expect(h.qbo.payments[0]).toMatchObject({
      TotalAmt: 40,
      PaymentRefNum: "CHK-1001",
      TxnDate: "2026-11-10",
      DepositToAccountRef: { value: bank },
      Line: [{ Amount: 40, LinkedTxn: [{ TxnId: q.Id, TxnType: "Invoice" }] }],
    });
    expect(h.qbo.payments[1].DepositToAccountRef).toEqual({ value: h.qbo.undepositedFundsId });
    expect(qboInvoice("INV-1").Balance).toBe(50);
    expect(await h.api("GET", `/invoices/${inv.id}`)).toMatchObject({ balanceCents: 5000, paymentStatus: "partially_paid" });
    expect((await h.pool.query("SELECT doc_number, state FROM links WHERE record_type = 'payment' AND internal_id = $1", [String(p.id)])).rows).toEqual([
      { doc_number: "CHK-1001", state: "linked" },
    ]);
  });

  it("creates a QBO Payment internally with ref QBO-<id>, and Payment Status matches", async () => {
    const { inv, q } = await linked("INV-2");

    const qp = h.qbo.accountantPay({ customerId: q.CustomerRef.value, applied: { [q.Id]: 100 } });
    await h.settle();

    expect(await internalPayments(inv.id)).toMatchObject([{ ref: `QBO-${qp.Id}`, amountCents: 10000, txnDate: "2026-11-10", status: "active" }]);
    expect(await h.api("GET", `/invoices/${inv.id}`)).toMatchObject({ paymentStatus: "paid", balanceCents: 0 });
    expect(qboInvoice("INV-2").Balance).toBe(0);
  });

  it("turns duplicated Payment hints into one Payment", async () => {
    const { inv, q } = await linked("INV-3");
    const qp = h.qbo.accountantPay({ customerId: q.CustomerRef.value, applied: { [q.Id]: 30 } });
    const event = { name: "Payment", id: qp.Id, operation: "Create" as const, lastUpdated: qp.MetaData.LastUpdatedTime };

    await h.sendQboWebhook([event, event]);
    await h.sendQboWebhook([{ ...event, operation: "Update", lastUpdated: "2031-01-01T00:00:00Z" }]);
    await h.settle();

    expect(await internalPayments(inv.id)).toHaveLength(1);
  });

  it("yields exactly one QBO Payment after a timeout once the create committed", async () => {
    const { inv } = await linked("INV-4");
    h.qbo.requestIdDedupe = false;
    h.qbo.injectFault("timeoutAfterCommit", { path: /\/payment$/ });

    await pay(inv.id, 2500);
    await h.settle();

    expect(h.qbo.payments).toHaveLength(1);
    expect((await h.pool.query("SELECT state FROM links WHERE record_type = 'payment'")).rows).toEqual([{ state: "linked" }]);
  });

  it("propagates a Payment void both ways", async () => {
    const { inv, q } = await linked("INV-5");
    const p = await pay(inv.id, 2000);
    const qp = h.qbo.accountantPay({ customerId: q.CustomerRef.value, applied: { [q.Id]: 30 } });
    await h.settle();

    await h.api("POST", `/payments/${p.id}/void`, undefined, { "if-match": "1" });
    h.qbo.accountantVoidPayment(qp.Id);
    await h.settle();

    expect(h.qbo.payments.every((x) => x.TotalAmt === 0)).toBe(true);
    expect((await internalPayments(inv.id)).map((x: any) => x.status)).toEqual(["voided", "voided"]);
    expect(await h.api("GET", `/invoices/${inv.id}`)).toMatchObject({ paymentStatus: "unpaid" });
    expect(qboInvoice("INV-5").Balance).toBe(100);
  });

  it("skips a QBO Payment voided before it was ever synced (its lines are gone)", async () => {
    const { inv, q } = await linked("INV-5B");
    const qp = h.qbo.accountantPay({ customerId: q.CustomerRef.value, applied: { [q.Id]: 30 } });
    h.qbo.accountantVoidPayment(qp.Id);
    h.qbo.events.length = 0;

    await h.sendQboWebhook([{ name: "Payment", id: qp.Id, operation: "Update", lastUpdated: "2031-01-01T00:00:00Z" }]);
    await h.settle();

    expect(await internalPayments(inv.id)).toEqual([]);
    expect(await lastAttempt()).toMatchObject({ outcome: "skipped" });
  });

  it("flags a Payment amount or date edit instead of syncing it", async () => {
    const { inv, q } = await linked("INV-6");
    const qp = h.qbo.accountantPay({ customerId: q.CustomerRef.value, applied: { [q.Id]: 30 } });
    await h.settle();

    h.qbo.accountantEditPayment(qp.Id, { TotalAmt: 35, Line: [{ Amount: 35, LinkedTxn: [{ TxnId: q.Id, TxnType: "Invoice" }] }] });
    await h.settle();

    expect(await internalPayments(inv.id)).toMatchObject([{ amountCents: 3000 }]);
    expect(await attentionSummaries()).toContainEqual(expect.stringMatching(/amount/i));
  });

  it("flags a Payment date edit, and a Payment moved to another Invoice", async () => {
    const { inv, q } = await linked("INV-6B");
    const other = await linked("INV-6C");
    const qp = h.qbo.accountantPay({ customerId: q.CustomerRef.value, applied: { [q.Id]: 30 } });
    await h.settle();

    h.qbo.accountantEditPayment(qp.Id, { TxnDate: "2026-11-20" });
    await h.settle();
    expect(await internalPayments(inv.id)).toMatchObject([{ txnDate: "2026-11-10" }]);
    expect(await attentionSummaries()).toContainEqual(expect.stringMatching(/date/i));

    h.qbo.accountantEditPayment(qp.Id, { TxnDate: "2026-11-10", Line: [{ Amount: 30, LinkedTxn: [{ TxnId: other.q.Id, TxnType: "Invoice" }] }] });
    await h.settle();
    expect(await internalPayments(other.inv.id)).toEqual([]);
    expect(await attentionSummaries()).toContainEqual(expect.stringMatching(/another Invoice/));
  });

  it("flags voiding an Invoice in QBO while internal Payments are applied", async () => {
    const { inv, q } = await linked("INV-11");
    await pay(inv.id, 2000);
    await h.settle();

    h.qbo.accountantVoid(q.Id);
    await h.settle();

    expect(await h.api("GET", `/invoices/${inv.id}`)).toMatchObject({ status: "issued", paidCents: 2000 });
    expect(await lastAttempt()).toMatchObject({ outcome: "attention", summary: expect.stringMatching(/Payments/) });
  });

  it("flags a QBO Payment applied to several Invoices instead of splitting it", async () => {
    const a = await linked("INV-7");
    const customerId = a.q.CustomerRef.value;
    const b = await h.api("POST", "/invoices", {
      docNumber: "INV-7B",
      customerId: a.inv.customerId,
      txnDate: "2026-11-01",
      lines: [line(5000)],
      status: "issued",
    });
    await h.settle();

    h.qbo.accountantPay({ customerId, applied: { [a.q.Id]: 10, [qboInvoice("INV-7B").Id]: 10 } });
    await h.settle();

    expect(await internalPayments(a.inv.id)).toEqual([]);
    expect(await internalPayments(b.id)).toEqual([]);
    expect(await attentionSummaries()).toContainEqual(expect.stringMatching(/several Invoices/));
  });

  it("syncs a Payment whose hint arrives before its Invoice is linked", async () => {
    const customerId = h.qbo.addCustomer("Early Bird");
    const qi = h.qbo.accountantCreate({ DocNumber: "QB-1", TxnDate: "2026-11-03", CustomerRef: { value: customerId }, Line: qboLines(100) });
    const qp = h.qbo.accountantPay({ customerId, applied: { [qi.Id]: 40 } });
    h.qbo.events.length = 0; // deliver the Payment's hint first, the Invoice's later

    await h.sendQboWebhook([{ name: "Payment", id: qp.Id, operation: "Create", lastUpdated: qp.MetaData.LastUpdatedTime }]);
    await h.settle();

    const inv = (await h.api("GET", "/invoices?docNumber=QB-1"))[0];
    expect(inv).toMatchObject({ paidCents: 4000, paymentStatus: "partially_paid" });
  });

  it("flags an internal edit that lowers the total below what is paid, but accepts the same edit from QBO", async () => {
    const { inv, q } = await linked("INV-8");
    await pay(inv.id, 6000);
    await h.settle();

    await h.api("PATCH", `/invoices/${inv.id}`, { lines: [line(5000)] }, { "if-match": "1" });
    await h.settle();
    expect(qboInvoice("INV-8").TotalAmt).toBe(100);
    expect(await attentionSummaries()).toContainEqual(expect.stringMatching(/below .*paid/));

    const other = await linked("INV-9");
    await pay(other.inv.id, 6000);
    await h.settle();
    h.qbo.accountantEdit(other.q.Id, { Line: qboLines(50) });
    await h.settle();
    expect(await h.api("GET", `/invoices/${other.inv.id}`)).toMatchObject({ totalCents: 5000, balanceCents: -1000 });
    expect(qboInvoice("INV-9").Balance).toBe(-10);
    void q;
  });

  it("flags voiding an Invoice that has Payments applied on the other Side", async () => {
    const { inv } = await linked("INV-10");
    await pay(inv.id, 2000);
    await h.settle();

    await h.api("POST", `/invoices/${inv.id}/void`, undefined, { "if-match": "1" });
    await h.settle();

    expect(qboInvoice("INV-10").TotalAmt).toBe(100); // not voided
    expect(await lastAttempt()).toMatchObject({ outcome: "attention", summary: expect.stringMatching(/Payments/) });
  });
});
