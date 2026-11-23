import { describe, expect, it } from "vitest";
import { pollCdc } from "../src/cdc.ts";
import { line, setupSync } from "./harness.ts";

// Deterministic PRNG (mulberry32), so the chaos is the same on every run.
function seeded(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("Chaos run", () => {
  it.each([42, 7, 2026])("ends with both Sides equal, no duplicates and one Link per pair (seed %i)", async (seed) => {
    const h = await setupSync();
    try {
      const random = seeded(seed);
      const item = h.qbo.addItem("Consulting");
      await h.mapRevenue("consulting", item);
      const qboLines = (amount: number, description = "consulting work") => [
        { DetailType: "SalesItemLineDetail", Amount: amount, Description: description, SalesItemLineDetail: { ItemRef: { value: item } } },
      ];
      const customer = await h.api("POST", "/customers", { displayName: "Chaos Co" });
      const invoices = [];
      for (let i = 0; i < 6; i++) {
        invoices.push(
          await h.api("POST", "/invoices", {
            docNumber: `INV-${i}`,
            customerId: customer.id,
            txnDate: "2026-11-01",
            memo: "start",
            lines: [line(10000)],
            status: "issued",
          }),
        );
      }
      await h.settle();
      const q = (doc: string) => h.qbo.invoices.find((i) => i.DocNumber === doc);

      // A batch of edits on both Sides, none of them conflicting.
      await h.api("PATCH", `/invoices/${invoices[0].id}`, { lines: [line(11000)] }, { "if-match": "1" });
      h.qbo.accountantEdit(q("INV-0").Id, { CustomerMemo: { value: "from QBO" } });
      await h.api("PATCH", `/invoices/${invoices[1].id}`, { memo: "from internal" }, { "if-match": "1" });
      await h.api("POST", "/payments", { invoiceId: invoices[1].id, amountCents: 3000, txnDate: "2026-11-05", method: "check" });
      h.qbo.accountantEdit(q("INV-2").Id, { Line: qboLines(70, "rework"), DueDate: "2027-01-31" });
      h.qbo.accountantPay({ customerId: q("INV-3").CustomerRef.value, applied: { [q("INV-3").Id]: 20 } });
      await h.api("POST", `/invoices/${invoices[4].id}/void`, undefined, { "if-match": "1" });
      h.qbo.accountantVoid(q("INV-5").Id);
      await h.api("POST", "/invoices", {
        docNumber: "INV-6",
        customerId: customer.id,
        txnDate: "2026-11-02",
        lines: [line(4200)],
        status: "issued",
      });
      h.qbo.accountantCreate({ DocNumber: "QB-7", TxnDate: "2026-11-03", CustomerRef: { value: q("INV-0").CustomerRef.value }, Line: qboLines(15) });

      // Deliver messily until quiet: internal hints duplicated, delayed, reordered; QBO
      // webhooks shuffled, duplicated and some dropped for good; CDC catches the rest.
      for (let round = 0; round < 20; round++) {
        await h.deliver(random);
        await h.deliverQboChaos(random);
        if (round % 3 === 2) await pollCdc(h.deps);
        await h.drain();
      }
      // A last poll catches whatever webhooks were dropped; then let the echoes settle.
      await pollCdc(h.deps);
      await h.settle();

      // No duplicates on either Side.
      const internalInvoices = await h.api("GET", "/invoices");
      const docs = (list: string[]) => [...list].sort();
      expect(docs(h.qbo.invoices.map((i) => i.DocNumber))).toEqual(docs(internalInvoices.map((i: any) => i.docNumber)));
      expect(new Set(h.qbo.invoices.map((i) => i.DocNumber)).size).toBe(8);

      // One Link per pair, all complete.
      const { rows: links } = await h.pool.query("SELECT * FROM links WHERE record_type = 'invoice'");
      expect(links).toHaveLength(8);
      expect(links.every((l) => l.internal_id && l.qbo_id && ["linked", "closed"].includes(l.state))).toBe(true);
      expect((await h.pool.query("SELECT count(*)::int AS n FROM conflicts")).rows[0].n).toBe(0);

      // Both Sides equal, pair by pair.
      for (const link of links) {
        const inv = await h.api("GET", `/invoices/${link.internal_id}`);
        const qi = h.qbo.invoices.find((i) => i.Id === link.qbo_id);
        const qboVoided = qi.TotalAmt === 0 && String(qi.PrivateNote ?? "").startsWith("Voided");
        expect({ doc: inv.docNumber, voided: inv.status === "voided" }).toEqual({ doc: qi.DocNumber, voided: qboVoided });
        if (qboVoided) continue;
        const sales = qi.Line.filter((l: any) => l.DetailType === "SalesItemLineDetail");
        expect({
          lines: inv.lines.map((l: any) => [l.description, l.amountCents]),
          memo: inv.memo,
          dueDate: inv.dueDate,
          txnDate: inv.txnDate,
          totalCents: inv.totalCents,
          balanceCents: inv.balanceCents,
        }).toEqual({
          lines: sales.map((l: any) => [l.Description, Math.round(l.Amount * 100)]),
          memo: qi.CustomerMemo?.value || null, // a blank QBO memo is no memo
          dueDate: qi.DueDate ?? null,
          txnDate: qi.TxnDate,
          totalCents: Math.round(qi.TotalAmt * 100),
          balanceCents: Math.round(qi.Balance * 100),
        });
      }

      // One Payment on each Side per Payment made, no duplicates, one complete Link each.
      const internalPayments = await h.api("GET", "/payments");
      expect(internalPayments).toHaveLength(2);
      expect(h.qbo.payments).toHaveLength(2);
      const { rows: paymentLinks } = await h.pool.query("SELECT * FROM links WHERE record_type = 'payment'");
      expect(paymentLinks).toHaveLength(2);
      expect(paymentLinks.every((l) => l.internal_id && l.qbo_id && l.state === "linked")).toBe(true);
    } finally {
      await h.close();
    }
  });
});
