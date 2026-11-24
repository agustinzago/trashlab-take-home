import type { SyncDeps } from "./app.ts";
import { recordHint } from "./worker.ts";

export type BackfillReport = { hinted: number; pairs: number; skippedOneSided: { internal: number; qbo: number } };

/**
 * Turns every pre-existing Invoice on both Sides into a Change Hint; the normal
 * path then links identical same-DocNumber pairs and raises Link Candidates for
 * differing ones. One-sided Invoices are hinted (and so copied across) only with
 * `createMissing`. Safe to run again: linked pairs come back as no-op runs.
 */
export async function backfill(deps: SyncDeps, { createMissing }: { createMissing: boolean }): Promise<BackfillReport> {
  // ponytail: one unpaged QBO query (QBO returns at most 1000 rows); page with STARTPOSITION for larger books.
  const internal = (await deps.internal.listInvoices()).filter((i) => i.status !== "draft");
  const qbo = await deps.qbo.query("Invoice");
  const internalDocs = new Set(internal.map((i) => i.docNumber));
  const qboDocs = new Set(qbo.map((q) => q.DocNumber));
  const run = `backfill:${new Date().toISOString()}`;
  const report: BackfillReport = { hinted: 0, pairs: 0, skippedOneSided: { internal: 0, qbo: 0 } };

  for (const inv of internal) {
    const paired = qboDocs.has(inv.docNumber);
    if (paired) report.pairs++;
    if (!paired && !createMissing) {
      report.skippedOneSided.internal++;
      continue;
    }
    await recordHint(deps.pool, { side: "internal", recordType: "invoice", recordId: String(inv.id), dedupeKey: `${run}:internal:${inv.id}` });
    report.hinted++;
  }
  for (const q of qbo) {
    if (!internalDocs.has(q.DocNumber) && !createMissing) {
      report.skippedOneSided.qbo++;
      continue;
    }
    await recordHint(deps.pool, { side: "qbo", recordType: "invoice", recordId: q.Id, dedupeKey: `${run}:qbo:${q.Id}` });
    report.hinted++;
  }
  return report;
}
