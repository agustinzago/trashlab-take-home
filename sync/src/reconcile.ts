import type { SyncDeps } from "./app.ts";
import { getQboInvoice } from "./invoice-sync.ts";

type Amounts = { invoiceId: string; totalCents: number; balanceCents: number } | { invoiceId: string; missing: true };
export type ReconcileReport = {
  checked: number;
  mismatches: { docNumber: string; internal: Amounts; qbo: Amounts }[];
};

const cents = (dollars: number) => Math.round(dollars * 100);
const withoutId = ({ invoiceId: _, ...amounts }: Amounts) => amounts;

/**
 * Read-only ledger check (ADR 0002): for every linked Invoice, compares the total
 * and balance QBO has posted with the Internal System's. It writes nothing and
 * never touches JournalEntries or Accounts.
 */
export async function reconcile(deps: SyncDeps): Promise<ReconcileReport> {
  const { rows: links } = await deps.pool.query(
    // Linked pairs only: a pending create has one Side, and a closed (voided) Link has nothing left owed.
    `SELECT doc_number, internal_id, qbo_id FROM links
     WHERE record_type = 'invoice' AND internal_id IS NOT NULL AND qbo_id IS NOT NULL AND state <> 'closed' ORDER BY doc_number`,
  );
  const mismatches: ReconcileReport["mismatches"] = [];
  for (const link of links) {
    const inv = await deps.internal.getInvoice(link.internal_id);
    const q = await getQboInvoice(deps, link.qbo_id);
    const internal: Amounts = inv
      ? { invoiceId: link.internal_id, totalCents: inv.totalCents, balanceCents: inv.totalCents - inv.paidCents }
      : { invoiceId: link.internal_id, missing: true };
    const qbo: Amounts = q
      ? { invoiceId: link.qbo_id, totalCents: cents(q.TotalAmt), balanceCents: cents(q.Balance) }
      : { invoiceId: link.qbo_id, missing: true };
    if (JSON.stringify(withoutId(internal)) !== JSON.stringify(withoutId(qbo))) {
      mismatches.push({ docNumber: link.doc_number, internal, qbo });
    }
  }
  return { checked: links.length, mismatches };
}
