import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSyncApp } from "../src/app.ts";
import { line, setupSync, type SyncHarness } from "./harness.ts";

let h: SyncHarness;

beforeEach(async () => {
  h = await setupSync();
  await h.mapRevenue("consulting", h.qbo.addItem("Consulting"));
});
afterEach(() => h.close());

describe("Admin", () => {
  it("lists Needs Attention items: a flagged Link and an unlinked record, latest state only", async () => {
    const customer = await h.api("POST", "/customers", { displayName: "Acme" });
    const inv = await h.api("POST", "/invoices", {
      docNumber: "INV-1",
      customerId: customer.id,
      txnDate: "2026-11-01",
      lines: [line(100)],
      status: "issued",
    });
    await h.api("POST", "/invoices", {
      docNumber: "INV-2",
      customerId: customer.id,
      txnDate: "2026-11-01",
      lines: [line(100, "unmapped")],
      status: "issued",
    });
    await h.settle();
    await h.api("PATCH", `/invoices/${inv.id}`, { docNumber: "INV-1-X" }, { "if-match": "1" });
    await h.settle();

    const items = (await h.syncApp.inject({ method: "GET", url: "/admin/api/attention" })).json();
    expect(items.map((i: any) => i.summary).sort()).toEqual([
      expect.stringContaining("DocNumber changed"),
      expect.stringContaining("No Account Mapping"),
    ]);
    const page = (await h.syncApp.inject({ method: "GET", url: "/admin" })).body;
    expect(page).toContain("No Account Mapping for revenue categories: unmapped");
  });

  it("drops a Needs Attention item once the record syncs", async () => {
    const customer = await h.api("POST", "/customers", { displayName: "Acme" });
    const inv = await h.api("POST", "/invoices", {
      docNumber: "INV-3",
      customerId: customer.id,
      txnDate: "2026-11-01",
      lines: [line(100, "training")],
      status: "issued",
    });
    await h.settle();
    expect((await h.syncApp.inject({ method: "GET", url: "/admin/api/attention" })).json()).toHaveLength(1);

    await h.mapRevenue("training", h.qbo.addItem("Training"));
    await h.api("PATCH", `/invoices/${inv.id}`, { memo: "retry" }, { "if-match": "1" });
    await h.settle();

    expect(h.qbo.invoices).toHaveLength(1);
    expect((await h.syncApp.inject({ method: "GET", url: "/admin/api/attention" })).json()).toEqual([]);
  });

  it("refuses an admin POST from another site", async () => {
    const res = await h.syncApp.inject({
      method: "POST",
      url: "/admin/conflicts/1/resolve",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example", host: "localhost:3000" },
      payload: "winner=qbo",
    });
    expect(res.statusCode).toBe(403);
  });

  it("does not accept form bodies on the webhook endpoints", async () => {
    const res = await h.syncApp.inject({
      method: "POST",
      url: "/webhooks/internal",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "deliveryId=1&type=invoice&id=1",
    });
    expect(res.statusCode).toBe(415);
  });

  it("requires the admin password when one is configured", async () => {
    const app = buildSyncApp({ ...h.deps, adminPassword: "s3cret" });
    const basic = (pw: string) => "Basic " + Buffer.from(`admin:${pw}`).toString("base64");

    expect((await app.inject({ method: "GET", url: "/admin" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/admin", headers: { authorization: basic("wrong") } })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/admin", headers: { authorization: basic("s3cret") } })).statusCode).toBe(200);
    await app.close();
  });

  it("escapes record data in the page", async () => {
    const customer = await h.api("POST", "/customers", { displayName: "Acme" });
    await h.api("POST", "/invoices", {
      docNumber: "<script>x</script>",
      customerId: customer.id,
      txnDate: "2026-11-01",
      lines: [line(100, "<b>cat</b>")],
      status: "issued",
    });
    await h.settle();

    const page = (await h.syncApp.inject({ method: "GET", url: "/admin" })).body;
    expect(page).not.toContain("<b>cat</b>");
    expect(page).toContain("&lt;b&gt;cat&lt;/b&gt;");
  });
});
