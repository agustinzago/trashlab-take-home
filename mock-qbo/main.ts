/**
 * The mock QBO service: the same in-memory fake the tests use, run on its own so the
 * whole stack works with `docker compose up` and no Intuit account. It serves the
 * Accounting API subset the sync uses (Invoice, Payment, Customer, Item, query, CDC)
 * and sends its changes to the sync service as signed QBO webhooks.
 *
 * State lives in memory: restarting this service empties it, so reset the whole stack
 * with `docker compose down -v` rather than restarting it alone.
 */
import { createHmac } from "node:crypto";
import { startFakeQbo } from "./fake-qbo.ts";

const port = Number(process.env.PORT ?? 4000);
const webhookUrl = process.env.WEBHOOK_URL;
const verifier = process.env.QBO_WEBHOOK_VERIFIER ?? "";

const qbo = await startFakeQbo({ host: "0.0.0.0", port });
// Items the default ACCOUNT_MAPPING points at: revenue category consulting -> 1, hosting -> 2.
const consulting = qbo.addItem("Consulting");
const hosting = qbo.addItem("Hosting");
console.log(`mock QBO listening on :${port} (company ${qbo.realmId}); Items: Consulting=${consulting}, Hosting=${hosting}`);

// Every second, deliver queued changes as one signed webhook, the way QBO does. Kept for the next try if the sync is down.
setInterval(async () => {
  if (!webhookUrl || qbo.events.length === 0) return;
  const entities = qbo.events.splice(0);
  const body = JSON.stringify({ eventNotifications: [{ realmId: qbo.realmId, dataChangeEvent: { entities } }] });
  const signature = createHmac("sha256", verifier).update(body).digest("base64");
  try {
    const res = await fetch(webhookUrl, { method: "POST", headers: { "content-type": "application/json", "intuit-signature": signature }, body });
    if (!res.ok) throw new Error(`status ${res.status}`);
  } catch {
    qbo.events.unshift(...entities);
  }
}, 1000);
