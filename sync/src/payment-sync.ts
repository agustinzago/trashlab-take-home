import { randomUUID } from "node:crypto";
import type pg from "pg";
import { tx } from "../../shared/db.ts";
import type { SyncDeps } from "./app.ts";
import type { InternalPayment } from "./internal.ts";
import { getQboInvoice, qboDeleteReported } from "./invoice-sync.ts";
import {
  NeedsAttention,
  completeLink,
  findLink,
  insertPendingLink,
  isIncomplete,
  isQboVoided,
  requestIdFor,
  withInvoiceLock,
  type Link,
} from "./links.ts";
import { QboError } from "./qbo.ts";
import { enqueue, type Run } from "./worker.ts";

/**
 * Payments are create and void only. Their Base is the money they carry; an edit
 * to it on either Side is flagged, because editing money in place across systems
 * is how ledgers drift (void and re-enter instead).
 */
type PaymentFields = { amountCents: number; txnDate: string };
type PaymentLink = Link<PaymentFields>;

/** Thrown while a Payment's Invoice has no Link yet: held and retried, after queueing the Invoice. */
class WaitingForInvoice extends Error {
  waiting = true;
}

const fromInternal = (p: InternalPayment): PaymentFields => ({ amountCents: p.amountCents, txnDate: p.txnDate });
const fromQbo = (qp: any): PaymentFields => ({ amountCents: Math.round(qp.TotalAmt * 100), txnDate: qp.TxnDate });
const sameMoney = (a: PaymentFields, b: PaymentFields) => a.amountCents === b.amountCents && a.txnDate === b.txnDate;
const appliedTo = (qp: any): string[] =>
  qp.Line.flatMap((l: any) => (l.LinkedTxn ?? []).filter((t: any) => t.TxnType === "Invoice").map((t: any) => t.TxnId));

async function getQboPayment(deps: SyncDeps, id: string): Promise<any | null> {
  return deps.qbo.get("Payment", id).catch((err) => {
    if (err.code === "610") return null;
    throw err;
  });
}

/** The Payments QBO shows applied to an Invoice (through its LinkedTxn), for looking before creating. */
async function qboPaymentsOn(deps: SyncDeps, qboInvoiceId: string): Promise<any[]> {
  const inv = await getQboInvoice(deps, qboInvoiceId);
  const ids = (inv?.LinkedTxn ?? []).filter((t: any) => t.TxnType === "Payment").map((t: any) => t.TxnId);
  return (await Promise.all(ids.map((id: string) => getQboPayment(deps, id)))).filter(Boolean);
}

/** Account Mapping: a payment method deposits to its mapped account, else Undeposited Funds. */
async function depositAccount(deps: SyncDeps, method: string): Promise<string> {
  const { rows } = await deps.pool.query(
    "SELECT qbo_ref FROM account_mappings WHERE kind = 'payment_method' AND internal_key = $1",
    [method],
  );
  if (rows[0]) return rows[0].qbo_ref;
  // By sub-type, not name: the account can be renamed or localized.
  const [undeposited] = await deps.qbo.query("Account", ["AccountSubType", "UndepositedFunds"]);
  if (!undeposited) throw new NeedsAttention(`No Account Mapping for payment method ${method} and no Undeposited Funds account in QBO`);
  return undeposited.Id;
}

async function methodFor(pool: pg.Pool, accountId: string | undefined): Promise<string> {
  const { rows } = await pool.query("SELECT internal_key FROM account_mappings WHERE kind = 'payment_method' AND qbo_ref = $1", [
    accountId ?? "",
  ]);
  return rows.length === 1 ? rows[0].internal_key : "qbo";
}

// --- Creating on the other Side ---------------------------------------------------

async function pushToQbo(deps: SyncDeps, run: Run, link: PaymentLink, p: InternalPayment, qboInvoiceId: string) {
  const inv = await getQboInvoice(deps, qboInvoiceId);
  if (!inv) throw new NeedsAttention(`QBO Invoice ${qboInvoiceId} for Payment ${p.ref} is gone`);
  const created = await deps.qbo
    .create(
      "Payment",
      {
        CustomerRef: { value: inv.CustomerRef.value },
        TotalAmt: p.amountCents / 100,
        TxnDate: p.txnDate,
        PaymentRefNum: p.ref, // how the Payment is found again: its Link's ref
        DepositToAccountRef: { value: await depositAccount(deps, p.method) },
        Line: [{ Amount: p.amountCents / 100, LinkedTxn: [{ TxnId: qboInvoiceId, TxnType: "Invoice" }] }],
      },
      link.pending_request_id!,
    )
    .catch(async (err) => {
      // QBO refused (4xx): a fresh requestid keeps a replayed refusal from blocking the retry.
      if (err instanceof QboError && err.status < 500) {
        await deps.pool.query("UPDATE links SET pending_request_id = $2 WHERE id = $1", [link.id, randomUUID()]);
      }
      throw err;
    });
  run.writes.push({ side: "qbo", action: "create", entity: "Payment", id: created.Id });
  run.snapshots.qbo = created;
  await completeLink(deps.pool, run, link, { qboId: created.Id }, fromInternal(p), `Created QBO Payment ${created.Id}`);
}

async function pushToInternal(deps: SyncDeps, run: Run, link: PaymentLink, qp: any, internalInvoiceId: string) {
  const created = await deps.internal.createPayment(
    {
      invoiceId: Number(internalInvoiceId),
      amountCents: Math.round(qp.TotalAmt * 100),
      txnDate: qp.TxnDate,
      method: await methodFor(deps.pool, qp.DepositToAccountRef?.value),
      ref: link.doc_number,
    },
    `qbo-payment:${qp.Id}`,
  );
  run.writes.push({ side: "internal", action: "create", entity: "Payment", id: String(created.id) });
  run.snapshots.internal = created;
  await completeLink(deps.pool, run, link, { internalId: String(created.id) }, fromQbo(qp), `Created internal Payment ${created.id}`);
}

async function createInQbo(deps: SyncDeps, run: Run, p: InternalPayment, invoice: Link) {
  if (p.status === "voided") return run.record(deps.pool, "skipped", "Payment voided before it was ever synced; nothing to create");
  const existing = (await qboPaymentsOn(deps, invoice.qbo_id!)).find((qp) => qp.PaymentRefNum === p.ref);
  if (existing) throw new NeedsAttention(`QBO already has an unlinked Payment ${existing.Id} with ref ${p.ref}`);
  const link = await insertPendingLink(deps.pool, "payment", String(p.id), null, p.ref, fromInternal(p), invoice.id);
  run.linkId = link.id;
  await pushToQbo(deps, run, link, p, invoice.qbo_id!);
}

async function createInternally(deps: SyncDeps, run: Run, qp: any, invoice: Link) {
  if (isQboVoided(qp)) return run.record(deps.pool, "skipped", "Payment voided in QBO before it was ever synced; nothing to create");
  const ref = `QBO-${qp.Id}`;
  if ((await deps.internal.findPayments(ref)).length) throw new NeedsAttention(`The Internal System already has an unlinked Payment ${ref}`);
  const link = await insertPendingLink(deps.pool, "payment", null, qp.Id, ref, fromQbo(qp), invoice.id);
  run.linkId = link.id;
  await pushToInternal(deps, run, link, qp, invoice.internal_id!);
}

/** A Payment Link missing one Side: look on the target (QBO through the Invoice's LinkedTxn), adopt or create. */
async function resumeCreate(deps: SyncDeps, run: Run, link: PaymentLink, invoice: Link) {
  run.linkId = link.id;
  const toQbo = link.qbo_id === null;
  const found = toQbo
    ? (await qboPaymentsOn(deps, invoice.qbo_id!)).find((qp) => qp.PaymentRefNum === link.doc_number)
    : (await deps.internal.findPayments(link.doc_number))[0];
  if (found) {
    if (!sameMoney(toQbo ? fromQbo(found) : fromInternal(found), link.base)) {
      await deps.pool.query("UPDATE links SET state = 'attention', updated_at = now() WHERE id = $1", [link.id]);
      throw new NeedsAttention(`Found a different Payment with ref ${link.doc_number} than the one this sync sent; not adopting it`);
    }
    const ids = toQbo ? { qboId: found.Id } : { internalId: String(found.id) };
    return completeLink(deps.pool, run, link, ids, link.base, `Adopted ${toQbo ? "QBO" : "internal"} Payment from an earlier attempt`);
  }
  const source = toQbo ? await deps.internal.getPayment(link.internal_id!) : await getQboPayment(deps, link.qbo_id!);
  if (!source || (toQbo ? source.status === "voided" : isQboVoided(source))) {
    await deps.pool.query("DELETE FROM links WHERE id = $1", [link.id]);
    return run.record(deps.pool, "skipped", `Payment ${link.doc_number} was voided or no longer exists; nothing created on the other Side`);
  }
  return toQbo ? pushToQbo(deps, run, link, source, invoice.qbo_id!) : pushToInternal(deps, run, link, source, invoice.internal_id!);
}

// --- A linked pair: only a Void propagates ------------------------------------------

async function syncPair(deps: SyncDeps, run: Run, link: PaymentLink, invoice: Link) {
  const { pool } = deps;
  run.linkId = link.id;
  if (link.state === "closed") return run.record(pool, "skipped", "Payment Link closed (voided); nothing to do", link.id);
  const p = await deps.internal.getPayment(link.internal_id!);
  const qp = await getQboPayment(deps, link.qbo_id!);
  run.snapshots = { base: link.base, internal: p, qbo: qp };
  if (!p) throw new NeedsAttention(`Internal Payment ${link.internal_id} is gone; a synced Payment can only be voided`);
  if (!qp && !(await qboDeleteReported(pool, link.qbo_id!, "Payment"))) {
    throw new NeedsAttention(`QBO says Payment ${link.qbo_id} is not found, but no Delete was reported for it`);
  }
  const internalVoided = p.status === "voided";
  const qboVoided = !qp || isQboVoided(qp);

  if (internalVoided || qboVoided) {
    if (!internalVoided) {
      await deps.internal.voidPayment(p.id, p.version);
      run.writes.push({ side: "internal", action: "void", entity: "Payment", id: String(p.id) });
    }
    if (!qboVoided) {
      await deps.qbo.void("Payment", { Id: qp.Id, SyncToken: qp.SyncToken }, requestIdFor("void-payment", qp.Id, qp.SyncToken));
      run.writes.push({ side: "qbo", action: "void", entity: "Payment", id: qp.Id });
    }
    await tx(pool, async (c) => {
      await c.query("UPDATE links SET state = 'closed', updated_at = now() WHERE id = $1", [link.id]);
      const origin = internalVoided && qboVoided ? "on both Sides" : internalVoided ? "internally" : "in QBO";
      await run.record(c, "synced", `Payment voided ${origin}; ${run.writes.length ? "voided the other Side" : "nothing to write"}; Link closed`, link.id);
    });
    return;
  }

  const applied = appliedTo(qp);
  if (applied.length !== 1) throw new NeedsAttention(appliedMessage(qp.Id, applied.length));
  if (applied[0] !== invoice.qbo_id) {
    await pool.query("UPDATE links SET state = 'attention', updated_at = now() WHERE id = $1", [link.id]);
    throw new NeedsAttention(`QBO Payment ${qp.Id} was moved to another Invoice; void it and re-enter it there`);
  }
  const edited = [
    !sameMoney(fromInternal(p), link.base) && "internally",
    !sameMoney(fromQbo(qp), link.base) && "in QBO",
  ].filter(Boolean);
  if (edited.length) {
    await pool.query("UPDATE links SET state = 'attention', updated_at = now() WHERE id = $1", [link.id]);
    throw new NeedsAttention(`Payment ${link.doc_number} amount or date was edited ${edited.join(" and ")}; void it and re-enter instead`);
  }
  await tx(pool, async (c) => {
    await c.query("UPDATE links SET state = 'linked', updated_at = now() WHERE id = $1", [link.id]);
    await run.record(c, "synced", "No changes", link.id);
  });
}

const appliedMessage = (id: string, count: number) =>
  count === 0 ? `QBO Payment ${id} is not applied to any Invoice` : `QBO Payment ${id} is applied to several Invoices; not splitting it`;

async function linkById(pool: pg.Pool, id: number): Promise<Link> {
  return (await pool.query("SELECT * FROM links WHERE id = $1", [id])).rows[0];
}

/** A pending Payment Link under this Invoice with one of these refs (scoped, so a typed check number can't match another Invoice's Payment). */
async function findPendingOn(pool: pg.Pool, invoiceLinkId: number, refs: string[]): Promise<PaymentLink | undefined> {
  const { rows } = await pool.query(
    `SELECT * FROM links WHERE record_type = 'payment' AND parent_link_id = $1
       AND (internal_id IS NULL OR qbo_id IS NULL) AND doc_number = ANY($2) ORDER BY id LIMIT 1`,
    [invoiceLinkId, refs],
  );
  return rows[0];
}

/**
 * The linked Invoice an unlinked Payment is applied to. If that Invoice has no
 * Link yet, queues its sync and waits (WaitingForInvoice). Null if the Payment is gone.
 */
async function invoiceOf(deps: SyncDeps, side: string, id: string): Promise<Link | null> {
  let invoiceId: string;
  if (side === "internal") {
    const p = await deps.internal.getPayment(id);
    if (!p) return null;
    invoiceId = String(p.invoiceId);
  } else {
    const qp = await getQboPayment(deps, id);
    // Gone, or voided before it was ever synced (a voided Payment has no lines left to say where it applied).
    if (!qp || isQboVoided(qp)) return null;
    const applied = appliedTo(qp);
    if (applied.length !== 1) throw new NeedsAttention(appliedMessage(qp.Id, applied.length));
    invoiceId = applied[0];
  }
  const invoice = await findLink(deps.pool, "invoice", side, invoiceId);
  if (invoice && !isIncomplete(invoice)) return invoice;
  await tx(deps.pool, (c) => enqueue(c, side as "internal" | "qbo", "invoice", invoiceId));
  throw new WaitingForInvoice(`Payment ${id} waits for its Invoice ${invoiceId} (${side}) to be linked`);
}

/**
 * Brings one Payment into agreement. It runs under its Invoice's lock, and waits
 * (held and retried) until that Invoice is linked, queueing the Invoice's sync.
 */
export async function syncPayment(deps: SyncDeps, run: Run): Promise<void> {
  const { pool } = deps;
  const { side, record_id: id } = run.job;
  try {
    const known = await findLink<PaymentFields>(pool, "payment", side, id);
    // A linked Payment's Invoice comes from its Link: the record may be gone, or QBO may have cleared its LinkedTxn on void.
    const invoice = known?.parent_link_id ? await linkById(pool, known.parent_link_id) : await invoiceOf(deps, side, id);
    if (!invoice) return run.record(pool, "skipped", `Payment ${id} no longer exists or was voided before it was synced; nothing to do`);

    await withInvoiceLock(pool, invoice.doc_number, async () => {
      const p = side === "internal" ? await deps.internal.getPayment(id) : null;
      const qp = side === "qbo" ? await getQboPayment(deps, id) : null;
      const refs = p ? [p.ref] : qp ? [qp.PaymentRefNum, `QBO-${qp.Id}`].filter(Boolean) : [];
      const link = (await findLink<PaymentFields>(pool, "payment", side, id)) ?? (await findPendingOn(pool, invoice.id, refs));
      if (link && isIncomplete(link)) return resumeCreate(deps, run, link, invoice);
      if (link) return syncPair(deps, run, link, invoice);
      if (p) return createInQbo(deps, run, p, invoice);
      if (qp) return createInternally(deps, run, qp, invoice);
      return run.record(pool, "skipped", `Payment ${id} no longer exists on the ${side} Side`);
    });
  } catch (err) {
    if (!(err instanceof NeedsAttention)) throw err;
    await run.record(pool, "attention", err.message, run.linkId);
  }
}
