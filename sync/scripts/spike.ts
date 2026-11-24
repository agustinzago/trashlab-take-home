/**
 * Spike (#2): confirms, against the real QBO sandbox, the behaviours the design
 * and the fake QBO assume. Connect the sandbox first (/admin/qbo/connect), then:
 *
 *   docker compose run --rm sync node sync/scripts/spike.ts
 *
 * It creates (and voids or deletes) a few SPIKE-* records in the sandbox company and
 * prints what it observed for each question. Paste the output into docs/DESIGN.md
 * ("Sandbox findings") and fix the fake wherever reality differs. The SPIKE-* records
 * are left in the sandbox (voided where the check voids them) for inspection.
 */
import { randomUUID } from "node:crypto";
import { depsFromEnv } from "../src/config.ts";
import { saveTokens, tokenRequest } from "../src/qbo-auth.ts";

const deps = await depsFromEnv({ server: false });
if (!deps.oauth) {
  console.error("The spike checks the real QBO sandbox: set QBO_CLIENT_ID and QBO_CLIENT_SECRET (it is pointless against the mock).");
  process.exit(2);
}
const { qbo } = deps;
const findings: Record<string, unknown> = {};
const tag = `SPIKE-${Date.now().toString(36).toUpperCase()}`;

async function check(name: string, fn: () => Promise<unknown>) {
  try {
    findings[name] = await fn();
  } catch (err: any) {
    findings[name] = { error: err.message, status: err.status, code: err.code };
  }
  console.log(`\n## ${name}\n${JSON.stringify(findings[name], null, 2)}`);
}

await check("Custom transaction numbers preference", async () => (await qbo.preferences())?.SalesFormsPrefs?.CustomTxnNumbers);

const [item] = await qbo.query("Item", ["Type", "Service"]);
if (!item) throw new Error("The sandbox company needs at least one Service Item for the spike");
const customer =
  (await qbo.query("Customer", ["DisplayName", "Spike Customer"]))[0] ?? (await qbo.create("Customer", { DisplayName: "Spike Customer" }));
const invoiceBody = (docNumber: string) => ({
  DocNumber: docNumber,
  TxnDate: new Date().toISOString().slice(0, 10),
  CustomerRef: { value: customer.Id },
  Line: [{ DetailType: "SalesItemLineDetail", Amount: 100, Description: "spike", SalesItemLineDetail: { ItemRef: { value: item.Id } } }],
});

await check("DocNumber settable on create", async () => {
  const inv = await qbo.create("Invoice", invoiceBody(`${tag}-A`));
  return { sent: `${tag}-A`, stored: inv.DocNumber, DueDate: inv.DueDate, lineTypes: inv.Line.map((l: any) => l.DetailType) };
});

await check("requestid replay: same requestid returns the original", async () => {
  const requestId = randomUUID();
  const first = await qbo.create("Invoice", invoiceBody(`${tag}-B`), requestId);
  const again = await qbo.create("Invoice", invoiceBody(`${tag}-B`), requestId).catch((e: any) => ({ error: e.message, code: e.code }));
  const later = await new Promise((r) => setTimeout(r, 65_000)).then(() =>
    qbo.create("Invoice", invoiceBody(`${tag}-B`), requestId).catch((e: any) => ({ error: e.message, code: e.code })),
  );
  const verdict = (r: any) => (r.Id === first.Id ? "replayed the original" : r.Id ? `created another (${r.Id})` : `error ${r.code}: ${r.error}`);
  return { firstId: first.Id, immediateRetry: verdict(again), after65s: verdict(later) };
});

await check("Duplicate DocNumber without requestid", async () =>
  qbo.create("Invoice", invoiceBody(`${tag}-A`)).then((i: any) => ({ createdDuplicate: i.Id }), (e: any) => ({ rejected: e.code, message: e.message })),
);

let paymentId = "";
let invoiceForPayment: any;
await check("Payment: PaymentRefNum and the Invoice's LinkedTxn", async () => {
  invoiceForPayment = await qbo.create("Invoice", invoiceBody(`${tag}-P`));
  const payment = await qbo.create("Payment", {
    CustomerRef: { value: customer.Id },
    TotalAmt: 40,
    PaymentRefNum: `${tag}-REF`,
    Line: [{ Amount: 40, LinkedTxn: [{ TxnId: invoiceForPayment.Id, TxnType: "Invoice" }] }],
  });
  paymentId = payment.Id;
  const inv = await qbo.get("Invoice", invoiceForPayment.Id);
  return { PaymentRefNum: payment.PaymentRefNum, DepositToAccountRef: payment.DepositToAccountRef, invoiceLinkedTxn: inv.LinkedTxn, invoiceBalance: inv.Balance };
});

await check("Void shape: Payment", async () => {
  const p = await qbo.get("Payment", paymentId);
  const voided = await qbo.void("Payment", { Id: p.Id, SyncToken: p.SyncToken });
  const inv = await qbo.get("Invoice", invoiceForPayment.Id);
  return { TotalAmt: voided.TotalAmt, PrivateNote: voided.PrivateNote, Line: voided.Line, invoiceLinkedTxnAfter: inv.LinkedTxn, invoiceBalanceAfter: inv.Balance };
});

await check("Void shape: Invoice", async () => {
  const inv = await qbo.create("Invoice", invoiceBody(`${tag}-V`)); // its own Invoice, so a failed Payment check can't block it
  const voided = await qbo.void("Invoice", { Id: inv.Id, SyncToken: inv.SyncToken });
  return { TotalAmt: voided.TotalAmt, Balance: voided.Balance, PrivateNote: voided.PrivateNote, lineAmounts: voided.Line.map((l: any) => l.Amount) };
});

await check("5010: update with a stale SyncToken", async () => {
  const inv = (await qbo.query("Invoice", ["DocNumber", `${tag}-A`]))[0];
  await qbo.update("Invoice", { Id: inv.Id, SyncToken: inv.SyncToken, sparse: true, PrivateNote: "first" });
  return qbo
    .update("Invoice", { Id: inv.Id, SyncToken: inv.SyncToken, sparse: true, PrivateNote: "stale" })
    .then(() => "accepted (unexpected)", (e: any) => ({ status: e.status, code: e.code, message: e.message }));
});

await check("CDC response for a hard-deleted Invoice", async () => {
  const since = new Date(Date.now() - 60_000).toISOString();
  const doomed = await qbo.create("Invoice", invoiceBody(`${tag}-D`));
  await qbo.delete("Invoice", { Id: doomed.Id, SyncToken: doomed.SyncToken });
  const { entities } = await qbo.cdc(["Invoice"], since);
  return (entities.Invoice ?? []).filter((r: any) => r.Id === doomed.Id);
});

await check("Refresh token: is the previous one still honoured after a refresh?", async () => {
  // The crash-safety argument for token rotation rests on this. Every pair received is saved,
  // so the service stays connected whatever the answer.
  const { rows } = await deps.pool.query("SELECT realm_id, refresh_token FROM qbo_connection WHERE id = 1");
  const old = rows[0].refresh_token;
  const rotated = await tokenRequest(deps.oauth!, { grant_type: "refresh_token", refresh_token: old });
  await saveTokens(deps.pool, rows[0].realm_id, rotated);
  const reuse = await tokenRequest(deps.oauth!, { grant_type: "refresh_token", refresh_token: old }).then(
    async (t) => {
      await saveTokens(deps.pool, rows[0].realm_id, t);
      return { honoured: true, rotatedAgain: t.refresh_token !== rotated.refresh_token };
    },
    (e: any) => ({ honoured: false, error: e.message }),
  );
  return { rotated: rotated.refresh_token !== old, previousTokenAfterRotation: reuse };
});

console.log(`\n# Summary\n${JSON.stringify(findings, null, 2)}`);
await deps.pool.end();
