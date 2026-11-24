/**
 * Live run (#13): drives the core scenarios end to end against the real QBO sandbox,
 * through the running stack (Internal System + sync service with its worker), and
 * prints what it verified. With the stack up and QBO connected:
 *
 *   docker compose run --rm sync node sync/scripts/live-run.ts
 *
 * It writes LIVE-* records to the Internal System and the sandbox company.
 */
import { createHmac } from "node:crypto";
import { depsFromEnv, required } from "../src/config.ts";

const deps = await depsFromEnv({ server: false });
const { qbo } = deps;
const internalUrl = required("INTERNAL_URL");
const syncUrl = process.env.SYNC_URL ?? "http://sync:3000";
const adminAuth = "Basic " + Buffer.from(`admin:${required("ADMIN_PASSWORD")}`).toString("base64");
const tag = `LIVE-${Date.now().toString(36).toUpperCase()}`;
const results: { scenario: string; ok: boolean; detail: string }[] = [];

async function api(method: string, path: string, body?: object, headers: Record<string, string> = {}) {
  const res = await fetch(internalUrl + path, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
  return res.status === 204 ? undefined : res.json();
}
async function admin(method: string, path: string, body?: object) {
  const res = await fetch(syncUrl + path, {
    method,
    headers: { authorization: adminAuth, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}
/** Waits for the sync to make `probe` true (webhooks or the 60 s CDC poll), up to `seconds`. */
async function eventually<T>(probe: () => Promise<T | undefined | false>, seconds = 150): Promise<T> {
  let lastError = "";
  for (let waited = 0; waited < seconds; waited += 3) {
    const value = await probe().catch((err) => {
      lastError = err.message; // reported if the wait runs out, rather than hidden
      return undefined;
    });
    if (value) return value;
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`not reached within ${seconds}s${lastError ? ` (last error: ${lastError})` : ""}`);
}
async function scenario(name: string, fn: () => Promise<string>) {
  process.stdout.write(`- ${name} ... `);
  try {
    const detail = await fn();
    results.push({ scenario: name, ok: true, detail });
    console.log(`ok (${detail})`);
  } catch (err: any) {
    results.push({ scenario: name, ok: false, detail: err.message });
    console.log(`FAILED: ${err.message}`);
  }
}
const qboByDoc = async (doc: string) => (await qbo.query("Invoice", ["DocNumber", doc]))[0];
const internalByDoc = async (doc: string) => (await api("GET", `/invoices?docNumber=${encodeURIComponent(doc)}`))[0];
const salesTotal = (q: any) => q.Line.filter((l: any) => l.DetailType === "SalesItemLineDetail").reduce((s: number, l: any) => s + l.Amount, 0);

// The first mapped revenue category is used for every line.
const { rows: mapped } = await deps.pool.query("SELECT internal_key, qbo_ref FROM account_mappings WHERE kind = 'revenue_category' LIMIT 1");
if (!mapped[0]) throw new Error("Set ACCOUNT_MAPPING with at least one revenue_category before the live run");
const category = mapped[0].internal_key;
const itemId = mapped[0].qbo_ref;
const line = (amountCents: number) => ({ description: "live run", amountCents, revenueCategory: category });
const qboLine = (amount: number) => ({ DetailType: "SalesItemLineDetail", Amount: amount, Description: "live run", SalesItemLineDetail: { ItemRef: { value: itemId } } });
const customer =
  (await api("GET", `/customers?displayName=${encodeURIComponent("Live Run Customer")}`))[0] ??
  (await api("POST", "/customers", { displayName: "Live Run Customer" }));

const docA = `${tag}-A`;
await scenario("internal Invoice appears in QBO", async () => {
  await api("POST", "/invoices", { docNumber: docA, customerId: customer.id, txnDate: "2026-11-01", memo: "live", lines: [line(10000)], status: "issued" });
  const q = await eventually(() => qboByDoc(docA));
  return `QBO Invoice ${q.Id}, total ${q.TotalAmt}`;
});

const docB = `${tag}-B`;
await scenario("QBO Invoice appears internally", async () => {
  const qboCustomer = (await qbo.query("Customer", ["DisplayName", "Live Run Customer"]))[0];
  await qbo.create("Invoice", { DocNumber: docB, TxnDate: "2026-11-02", CustomerRef: { value: qboCustomer.Id }, Line: [qboLine(42)] });
  const inv = await eventually(() => internalByDoc(docB));
  return `internal Invoice ${inv.id}, total ${inv.totalCents / 100}`;
});

await scenario("internal edit reaches QBO", async () => {
  const inv = await internalByDoc(docA);
  await api("PATCH", `/invoices/${inv.id}`, { memo: "edited internally" }, { "if-match": String(inv.version) });
  await eventually(async () => (await qboByDoc(docA))?.CustomerMemo?.value === "edited internally");
  return "memo copied";
});

await scenario("QBO edit reaches the Internal System", async () => {
  const q = await qboByDoc(docB);
  await qbo.update("Invoice", { Id: q.Id, SyncToken: q.SyncToken, sparse: true, DueDate: "2027-02-01" });
  await eventually(async () => (await internalByDoc(docB))?.dueDate === "2027-02-01");
  return "due date copied";
});

await scenario("a Conflict pauses the Invoice and resolving it makes both Sides equal", async () => {
  // QBO first: the internal edit syncs at once, and then finds the QBO edit already there (both changed).
  const q = await qboByDoc(docA);
  await qbo.update("Invoice", { Id: q.Id, SyncToken: q.SyncToken, sparse: true, Line: [qboLine(80)] });
  const inv = await internalByDoc(docA);
  await api("PATCH", `/invoices/${inv.id}`, { lines: [line(12000)] }, { "if-match": String(inv.version) });
  const conflict = await eventually(async () => (await admin("GET", "/admin/api/conflicts")).find((c: any) => c.docNumber === docA));
  await admin("POST", `/admin/api/conflicts/${conflict.id}/resolve`, { winner: "internal" });
  await eventually(async () => salesTotal(await qboByDoc(docA)) === 120);
  return "resolved for internal; QBO now 120";
});

await scenario("a duplicated hint changes nothing", async () => {
  const inv = await internalByDoc(docA);
  const body = JSON.stringify({ deliveryId: `${tag}-dup`, type: "invoice", id: inv.id });
  const signature = "sha256=" + createHmac("sha256", required("INTERNAL_WEBHOOK_SECRET")).update(body).digest("hex");
  for (let i = 0; i < 2; i++) {
    const res = await fetch(`${syncUrl}/webhooks/internal`, { method: "POST", headers: { "content-type": "application/json", "x-signature": signature }, body });
    if (!res.ok) throw new Error(`the sync service refused the hint: ${res.status}`); // else this scenario would prove nothing
  }
  await new Promise((r) => setTimeout(r, 10_000));
  const matches = await qbo.query("Invoice", ["DocNumber", docA]);
  if (matches.length !== 1) throw new Error(`${matches.length} QBO Invoices with DocNumber ${docA}`);
  return "still one QBO Invoice";
});

await scenario("a Payment reaches QBO, applied to its Invoice", async () => {
  const inv = await internalByDoc(docB);
  await api("POST", "/payments", { invoiceId: inv.id, amountCents: 1000, txnDate: "2026-11-05", method: "check", ref: `${tag}-PAY` });
  const q = await eventually(async () => {
    const found = await qboByDoc(docB);
    return found?.Balance === 32 && found;
  });
  return `QBO balance ${q.Balance}`;
});

await scenario("an internal Void voids the QBO Invoice", async () => {
  const inv = await internalByDoc(docA);
  await api("POST", `/invoices/${inv.id}/void`, undefined, { "if-match": String(inv.version) });
  const q = await eventually(async () => {
    const found = await qboByDoc(docA);
    return found?.TotalAmt === 0 && found;
  });
  return `QBO PrivateNote "${q.PrivateNote ?? ""}"`;
});

console.log("- a timeout after a write: not inducible against the sandbox; covered by the fault-injection tests (sync/test/write-safety.test.ts)");
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} scenarios verified against the QBO sandbox.`);
await deps.pool.end();
process.exit(failed ? 1 : 0);
