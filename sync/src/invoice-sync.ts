import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type pg from "pg";
import { tx } from "../../shared/db.ts";
import type { SyncDeps } from "./app.ts";
import type { InternalInvoice } from "./internal.ts";
import { merge, type InvoiceFields, type Line } from "./merge.ts";
import type { Run } from "./worker.ts";
import { QboError } from "./qbo.ts";

/** A problem only a person can fix (missing mapping, identity clash); recorded as Needs Attention. */
class NeedsAttention extends Error {}

type Link = {
  id: number;
  internal_id: string | null;
  qbo_id: string | null;
  doc_number: string;
  state: string;
  base: InvoiceFields;
  pending_request_id: string | null;
};

/** Holds a session advisory lock on the DocNumber for the duration of `fn`, serializing work on one Invoice. */
async function withInvoiceLock<T>(pool: pg.Pool, docNumber: string, fn: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    // Bounded wait, well inside the job lease; a timeout fails this attempt and it retries.
    await client.query("SET lock_timeout = '60s'");
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [`invoice:${docNumber}`]);
    return await fn();
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext($1))", [`invoice:${docNumber}`]).catch(() => {});
    await client.query("RESET lock_timeout").catch(() => {});
    client.release();
  }
}

async function findLink(pool: pg.Pool, side: string, id: string): Promise<Link | undefined> {
  const column = side === "internal" ? "internal_id" : "qbo_id";
  const { rows } = await pool.query(`SELECT * FROM links WHERE record_type = 'invoice' AND ${column} = $1`, [id]);
  return rows[0];
}

/** A Link still missing one Side's id: a create in flight (or stuck) for this DocNumber. */
async function findPendingLink(pool: pg.Pool, docNumber: string): Promise<Link | undefined> {
  const { rows } = await pool.query(
    "SELECT * FROM links WHERE record_type = 'invoice' AND (internal_id IS NULL OR qbo_id IS NULL) AND doc_number = $1",
    [docNumber],
  );
  return rows[0];
}

const isIncomplete = (link: Link) => link.internal_id === null || link.qbo_id === null;

/** Whether a record found on the target is the one our earlier create sent: identity and Financial Fields match. */
const isOurs = (found: InvoiceFields, sent: InvoiceFields) =>
  (["docNumber", "customer", "txnDate", "lines"] as const).every((f) => isDeepStrictEqual(found[f], sent[f]));

/** A QBO requestid derived from what is being written, so a retry of the same write reuses it. */
const requestIdFor = (...parts: unknown[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 36);

// --- Account Mapping: revenue category <-> QBO Item ---------------------------------

async function itemsFor(pool: pg.Pool, lines: Line[]): Promise<Map<string, string>> {
  const categories = [...new Set(lines.map((l) => l.revenueCategory))];
  const { rows } = await pool.query(
    "SELECT internal_key, qbo_ref FROM account_mappings WHERE kind = 'revenue_category' AND internal_key = ANY($1)",
    [categories],
  );
  const map = new Map<string, string>(rows.map((r) => [r.internal_key, r.qbo_ref]));
  const unmapped = categories.filter((c) => !map.has(c));
  if (unmapped.length) throw new NeedsAttention(`No Account Mapping for revenue categories: ${unmapped.join(", ")}`);
  return map;
}

async function categoriesFor(pool: pg.Pool, itemIds: string[]): Promise<Map<string, string>> {
  const { rows } = await pool.query(
    "SELECT internal_key, qbo_ref FROM account_mappings WHERE kind = 'revenue_category' AND qbo_ref = ANY($1)",
    [itemIds],
  );
  const map = new Map<string, string>();
  for (const r of rows) {
    // Two categories on one Item would not round-trip: the line would flip category on its way back.
    if (map.has(r.qbo_ref)) throw new NeedsAttention(`QBO Item ${r.qbo_ref} is mapped to several revenue categories`);
    map.set(r.qbo_ref, r.internal_key);
  }
  const unmapped = [...new Set(itemIds.filter((i) => !map.has(i)))];
  if (unmapped.length) throw new NeedsAttention(`No Account Mapping for QBO Items: ${unmapped.join(", ")}`);
  return map;
}

// --- Normalization to the common Invoice shape -------------------------------------

const blankToNull = (v: string | null | undefined) => (v ? v : null);

function normalizeInternal(inv: InternalInvoice, customerName: string): InvoiceFields {
  return {
    docNumber: inv.docNumber,
    customer: customerName,
    txnDate: inv.txnDate,
    dueDate: inv.dueDate,
    memo: blankToNull(inv.memo),
    lines: inv.lines.map((l) => ({ description: l.description, amountCents: l.amountCents, revenueCategory: l.revenueCategory })),
  };
}

const SYNCED_LINE_TYPES = new Set(["SalesItemLineDetail", "SubTotalLineDetail"]);

async function normalizeQbo(pool: pg.Pool, q: any): Promise<InvoiceFields> {
  // Dropping a line we cannot model (discount, group...) would let the next push delete it from the books.
  const unsupported = [...new Set((q.Line ?? []).map((l: any) => l.DetailType).filter((t: string) => !SYNCED_LINE_TYPES.has(t)))];
  if (unsupported.length) throw new NeedsAttention(`QBO Invoice ${q.Id} has lines the sync cannot model: ${unsupported.join(", ")}`);
  const sales = (q.Line ?? []).filter((l: any) => l.DetailType === "SalesItemLineDetail");
  const category = await categoriesFor(pool, sales.map((l: any) => l.SalesItemLineDetail.ItemRef.value));
  return {
    docNumber: q.DocNumber,
    customer: q.CustomerRef.name,
    txnDate: q.TxnDate,
    dueDate: q.DueDate ?? null,
    memo: blankToNull(q.CustomerMemo?.value),
    lines: sales.map((l: any) => ({
      description: l.Description ?? "",
      amountCents: Math.round(l.Amount * 100),
      revenueCategory: category.get(l.SalesItemLineDetail.ItemRef.value)!,
    })),
  };
}

/** Null only when QBO says the Invoice does not exist; any other failure is retried. */
async function getQboInvoice(deps: SyncDeps, id: string): Promise<any | null> {
  return deps.qbo.get("Invoice", id).catch((err) => {
    if (err.code === "610") return null;
    throw err;
  });
}

// QBO has no void flag: a voided record is zeroed with a "Voided" note (to confirm in the sandbox spike, #2).
const isQboVoided = (q: any) => q.TotalAmt === 0 && String(q.PrivateNote ?? "").startsWith("Voided");

// --- Writing fields to each Side ---------------------------------------------------

async function qboCustomerId(deps: SyncDeps, run: Run, name: string): Promise<string> {
  const found = (await deps.qbo.query("Customer", ["DisplayName", name]))[0];
  if (found) return found.Id;
  const created = await deps.qbo.create("Customer", { DisplayName: name }, requestIdFor("customer", name));
  run.writes.push({ side: "qbo", action: "create", entity: "Customer", id: created.Id });
  return created.Id;
}

async function internalCustomerId(deps: SyncDeps, run: Run, name: string): Promise<number> {
  const found = (await deps.internal.findCustomers(name))[0];
  if (found) return found.id;
  const created = await deps.internal.createCustomer(name, `customer:${name}`);
  run.writes.push({ side: "internal", action: "create", entity: "Customer", id: String(created.id) });
  return created.id;
}

async function toQboFields(deps: SyncDeps, run: Run, f: Partial<InvoiceFields>): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  if (f.docNumber !== undefined) out.DocNumber = f.docNumber;
  if (f.customer !== undefined) out.CustomerRef = { value: await qboCustomerId(deps, run, f.customer) };
  if (f.txnDate !== undefined) out.TxnDate = f.txnDate;
  // ponytail: real QBO may refuse a null DueDate (it derives one from terms); confirm in the sandbox spike.
  if (f.dueDate !== undefined) out.DueDate = f.dueDate;
  if (f.memo !== undefined) out.CustomerMemo = { value: f.memo ?? "" };
  if (f.lines !== undefined) {
    const item = await itemsFor(deps.pool, f.lines);
    out.Line = f.lines.map((l) => ({
      DetailType: "SalesItemLineDetail",
      Amount: l.amountCents / 100,
      Description: l.description,
      SalesItemLineDetail: { ItemRef: { value: item.get(l.revenueCategory) } },
    }));
  }
  return out;
}

async function toInternalFields(deps: SyncDeps, run: Run, f: Partial<InvoiceFields>): Promise<Record<string, unknown>> {
  const { customer, ...rest } = f;
  return customer === undefined ? rest : { ...rest, customerId: await internalCustomerId(deps, run, customer) };
}

// --- Creating on the other Side: the pending-Link protocol --------------------------
//
// A create first commits a pending Link (holding the QBO requestid), then calls the
// other Side, then marks the Link linked. A timeout says nothing about whether the
// write landed, so a retry (or the echo of the write) finds the pending Link by
// DocNumber and looks on the target first, adopting the record if it is there.

async function insertPendingLink(pool: pg.Pool, internalId: string | null, qboId: string | null, fields: InvoiceFields): Promise<Link> {
  const { rows } = await pool.query(
    `INSERT INTO links (record_type, internal_id, qbo_id, doc_number, state, base, pending_request_id)
     VALUES ('invoice', $1, $2, $3, 'pending', $4, $5) RETURNING *`,
    [internalId, qboId, fields.docNumber, JSON.stringify(fields), qboId === null ? randomUUID() : null],
  );
  return rows[0];
}

async function completeLink(pool: pg.Pool, run: Run, link: Link, ids: { internalId?: string; qboId?: string }, base: InvoiceFields, summary: string) {
  await tx(pool, async (c) => {
    await c.query(
      `UPDATE links SET internal_id = COALESCE($2, internal_id), qbo_id = COALESCE($3, qbo_id), state = 'linked',
         base = $4, pending_request_id = NULL, updated_at = now() WHERE id = $1`,
      [link.id, ids.internalId ?? null, ids.qboId ?? null, JSON.stringify(base)],
    );
    await run.record(c, "synced", `${summary} (DocNumber ${base.docNumber})`, link.id);
  });
}

async function pushToQbo(deps: SyncDeps, run: Run, link: Link, fields: InvoiceFields): Promise<void> {
  const created = await deps.qbo
    .create("Invoice", await toQboFields(deps, run, fields), link.pending_request_id!)
    .catch(async (err) => {
      // A 4xx (including 429) means QBO refused this write, so a fresh requestid keeps a
      // replay of that refusal from blocking the retry. A lost reply or a 5xx may have
      // committed, so those keep the same one.
      if (err instanceof QboError && err.status < 500) {
        await deps.pool.query("UPDATE links SET pending_request_id = $2 WHERE id = $1", [link.id, randomUUID()]);
      }
      throw err;
    });
  run.writes.push({ side: "qbo", action: "create", entity: "Invoice", id: created.Id });
  run.snapshots.qbo = created;
  await completeLink(deps.pool, run, link, { qboId: created.Id }, fields, `Created QBO Invoice ${created.Id}`);
}

async function pushToInternal(deps: SyncDeps, run: Run, link: Link, fields: InvoiceFields): Promise<void> {
  const { customer, ...rest } = fields;
  const created = await deps.internal.createInvoice(
    { ...rest, customerId: await internalCustomerId(deps, run, customer), status: "issued" },
    `qbo-invoice:${link.qbo_id}`, // the Internal System's own idempotency covers a lost reply
  );
  run.writes.push({ side: "internal", action: "create", entity: "Invoice", id: String(created.id) });
  run.snapshots.internal = created;
  await completeLink(deps.pool, run, link, { internalId: String(created.id) }, fields, `Created internal Invoice ${created.id}`);
}

/** An internal Invoice with no Link: create it in QBO. */
async function createInQbo(deps: SyncDeps, run: Run, inv: InternalInvoice): Promise<void> {
  if (inv.status === "draft") return run.record(deps.pool, "skipped", "Draft Invoices are never synced");
  if (inv.status === "voided") return run.record(deps.pool, "skipped", "Voided before it was ever synced; nothing to create");
  const existing = await deps.qbo.query("Invoice", ["DocNumber", inv.docNumber]);
  if (existing.length) {
    run.snapshots.qbo = existing[0];
    throw new NeedsAttention(`QBO already has an unlinked Invoice with DocNumber ${inv.docNumber}`);
  }
  const fields = normalizeInternal(inv, await internalCustomerName(deps, inv));
  await itemsFor(deps.pool, fields.lines); // a missing Account Mapping is flagged before anything is written
  const link = await insertPendingLink(deps.pool, String(inv.id), null, fields);
  run.linkId = link.id;
  await pushToQbo(deps, run, link, fields);
}

/** A QBO Invoice with no Link: create it internally, already issued. */
async function createInternally(deps: SyncDeps, run: Run, q: any): Promise<void> {
  if (isQboVoided(q)) return run.record(deps.pool, "skipped", "Voided in QBO before it was ever synced; nothing to create");
  const fields = await normalizeQbo(deps.pool, q);
  const existing = await deps.internal.findInvoices(q.DocNumber);
  if (existing.length) {
    run.snapshots.internal = existing[0];
    throw new NeedsAttention(`The Internal System already has an unlinked Invoice with DocNumber ${q.DocNumber}`);
  }
  const link = await insertPendingLink(deps.pool, null, q.Id, fields);
  run.linkId = link.id;
  await pushToInternal(deps, run, link, fields);
}

/**
 * A Link still missing one Side: an earlier create may or may not have landed.
 * Look on the target; adopt what is found only if it is what we sent, else flag it.
 */
async function resumeCreate(deps: SyncDeps, run: Run, link: Link): Promise<void> {
  run.linkId = link.id;
  const toQbo = link.qbo_id === null;
  const found = toQbo
    ? (await deps.qbo.query("Invoice", ["DocNumber", link.doc_number]))[0]
    : (await deps.internal.findInvoices(link.doc_number))[0];
  if (found) {
    run.snapshots[toQbo ? "qbo" : "internal"] = found;
    const fields = toQbo ? await normalizeQbo(deps.pool, found) : normalizeInternal(found, await internalCustomerName(deps, found));
    if (!isOurs(fields, link.base)) {
      await deps.pool.query("UPDATE links SET state = 'attention', updated_at = now() WHERE id = $1", [link.id]);
      throw new NeedsAttention(
        `${toQbo ? "QBO" : "The Internal System"} has a different Invoice ${link.doc_number} than the one this sync sent; not adopting it`,
      );
    }
    const id = toQbo ? { qboId: found.Id } : { internalId: String(found.id) };
    return completeLink(deps.pool, run, link, id, link.base, `Adopted ${toQbo ? "QBO" : "internal"} Invoice ${toQbo ? found.Id : found.id} from an earlier attempt`);
  }
  const source = toQbo ? await deps.internal.getInvoice(link.internal_id!) : await getQboInvoice(deps, link.qbo_id!);
  const sourceVoided = source && (toQbo ? source.status === "voided" : isQboVoided(source));
  if (!source || sourceVoided) {
    // Nothing was created and the source is gone: drop the Link so it cannot capture a later record.
    await deps.pool.query("DELETE FROM links WHERE id = $1", [link.id]);
    return run.record(deps.pool, "skipped", `Invoice ${link.doc_number} was ${source ? "voided" : "removed"} before it was created on the other Side; nothing created`);
  }
  run.snapshots[toQbo ? "internal" : "qbo"] = source;
  return toQbo
    ? pushToQbo(deps, run, link, normalizeInternal(source, await internalCustomerName(deps, source)))
    : pushToInternal(deps, run, link, await normalizeQbo(deps.pool, source));
}

async function internalCustomerName(deps: SyncDeps, inv: InternalInvoice): Promise<string> {
  const customer = await deps.internal.getCustomer(inv.customerId);
  if (!customer) throw new NeedsAttention(`Internal Invoice ${inv.docNumber} refers to missing customer ${inv.customerId}`);
  return customer.displayName;
}

// --- A linked pair ------------------------------------------------------------------

/** Refetch both Sides, merge against the Base, write the plan, advance the Base. */
async function syncPair(deps: SyncDeps, run: Run, link: Link): Promise<void> {
  const { pool, internal, qbo } = deps;
  run.linkId = link.id;
  if (link.state === "closed") return run.record(pool, "skipped", "Link closed (voided); nothing to do", link.id);
  const inv = await internal.getInvoice(link.internal_id!);
  const q = await getQboInvoice(deps, link.qbo_id!);
  run.snapshots = { base: link.base, internal: inv, qbo: q };
  if (!inv) throw new NeedsAttention(`Internal Invoice ${link.internal_id} is gone, but a synced Invoice can only be voided`);
  if (!q && !(await qboDeleteReported(pool, link.qbo_id!))) {
    throw new NeedsAttention(`QBO says Invoice ${link.qbo_id} is not found, but no Delete was reported for it; check the QBO connection`);
  }
  // A Void wins over everything, an open Conflict included.
  if (inv.status === "voided" || !q || isQboVoided(q)) return syncVoid(deps, run, link, inv, q);
  if (link.state === "paused") {
    // The hint is kept (change_hints); nothing is written until a person resolves the Conflict.
    return run.record(pool, "paused", "Paused by an open Conflict; nothing written", link.id);
  }
  if (looksVoidedWithoutNote(q, link.base)) {
    throw new NeedsAttention(`QBO Invoice ${q.Id} is zeroed but not marked "Voided"; not merging its zeroed lines`);
  }

  const result = merge({
    base: link.base,
    internal: normalizeInternal(inv, await internalCustomerName(deps, inv)),
    qbo: await normalizeQbo(pool, q),
    internalUpdatedAt: inv.updatedAt,
    qboUpdatedAt: q.MetaData.LastUpdatedTime,
  });
  run.snapshots.merge = result;

  if (result.kind === "attention") {
    await tx(pool, async (c) => {
      await c.query("UPDATE links SET state = 'attention', updated_at = now() WHERE id = $1", [link.id]);
      await run.record(c, "attention", result.reason, link.id);
    });
    return;
  }
  if (result.kind === "conflict") {
    // A Conflict pauses the whole Invoice, clean fields included, until a person picks a Side.
    const fields = result.conflicts.map((c) => c.field).join(", ");
    await tx(pool, async (c) => {
      await c.query(
        `INSERT INTO conflicts (link_id, fields) VALUES ($1, $2)
         ON CONFLICT (link_id) WHERE status = 'open' DO UPDATE SET fields = EXCLUDED.fields, raised_at = now()`,
        [link.id, JSON.stringify(result.conflicts)],
      );
      await c.query("UPDATE links SET state = 'paused', updated_at = now() WHERE id = $1", [link.id]);
      await run.record(c, "conflict", `Conflict: ${fields} changed differently on both Sides; Invoice paused`, link.id);
    });
    return;
  }

  const { toQbo, toInternal, merged, notes } = result;
  if (Object.keys(toQbo).length) {
    // The SyncToken we read makes QBO refuse (5010) if someone edited since; the job then refetches and re-merges.
    const body = { Id: q.Id, SyncToken: q.SyncToken, sparse: true, ...(await toQboFields(deps, run, toQbo)) };
    const updated = await qbo.update("Invoice", body, requestIdFor("invoice", body));
    run.writes.push({ side: "qbo", action: "update", entity: "Invoice", id: q.Id, fields: Object.keys(toQbo) });
    run.snapshots.qboAfter = updated;
    // Both Sides now hold these fields: record that agreement, so if the internal half
    // fails our own QBO write is not mistaken for a QBO edit on the retry.
    const agreed = Object.fromEntries(Object.keys(toQbo).map((f) => [f, merged[f as keyof InvoiceFields]]));
    await pool.query("UPDATE links SET base = base || $2::jsonb, updated_at = now() WHERE id = $1", [link.id, JSON.stringify(agreed)]);
  }
  if (Object.keys(toInternal).length) {
    // If-Match: a concurrent internal edit makes this a 409, and the job refetches and re-merges.
    const updated = await internal.updateInvoice(inv.id, inv.version, await toInternalFields(deps, run, toInternal));
    run.writes.push({ side: "internal", action: "update", entity: "Invoice", id: String(inv.id), fields: Object.keys(toInternal) });
    run.snapshots.internalAfter = updated;
  }

  const changed = [...Object.keys(toQbo).map((f) => `${f} -> QBO`), ...Object.keys(toInternal).map((f) => `${f} -> internal`)];
  const summary = changed.length ? `Copied ${changed.join(", ")}` : "No changes";
  await tx(pool, async (c) => {
    await c.query("UPDATE links SET base = $2, state = 'linked', updated_at = now() WHERE id = $1", [link.id, JSON.stringify(merged)]);
    await run.record(c, "synced", [summary, ...notes].join("; "), link.id);
  });
}

/**
 * A Void on either Side wins over any edit on the other: the other Side is voided
 * too (financial history is never deleted), the discarded edit is noted, and the
 * Link is closed so later hints are no-ops.
 */
async function syncVoid(deps: SyncDeps, run: Run, link: Link, inv: InternalInvoice, q: any | null) {
  const { pool } = deps;
  const internalVoided = inv.status === "voided";
  const qboVoided = !q || isQboVoided(q); // a QBO hard delete arrives internally as a Void
  if (!internalVoided) {
    const discarded = await discardedEdits(link.base, () => internalCustomerName(deps, inv).then((name) => normalizeInternal(inv, name)));
    await deps.internal.voidInvoice(inv.id, inv.version);
    run.writes.push({ side: "internal", action: "void", entity: "Invoice", id: String(inv.id) });
    if (discarded) run.notes.push(`Void wins: discarded internal edit to ${discarded}`);
  }
  if (!qboVoided) {
    const discarded = await discardedEdits(link.base, () => normalizeQbo(pool, q));
    await deps.qbo.void("Invoice", { Id: q.Id, SyncToken: q.SyncToken }, requestIdFor("void", q.Id, q.SyncToken));
    run.writes.push({ side: "qbo", action: "void", entity: "Invoice", id: q.Id });
    if (discarded) run.notes.push(`Void wins: discarded QBO edit to ${discarded}`);
  }
  const origin = !q ? "Deleted in QBO" : internalVoided && qboVoided ? "Voided on both Sides" : internalVoided ? "Voided internally" : "Voided in QBO";
  await tx(pool, async (c) => {
    // A Void settles any open Conflict: there is nothing left to choose between.
    await c.query("UPDATE conflicts SET status = 'resolved', resolved_at = now() WHERE link_id = $1 AND status = 'open'", [link.id]);
    await c.query("UPDATE links SET state = 'closed', updated_at = now() WHERE id = $1", [link.id]);
    const wrote = run.writes.length ? "voided the other Side" : "nothing to write";
    await run.record(c, "synced", `${origin}; ${wrote}; Link closed${run.notes.length ? ` (${run.notes.join("; ")})` : ""}`, link.id);
  });
}

/** The fields one Side changed since the Base, which a Void is about to discard; never blocks the Void. */
async function discardedEdits(base: InvoiceFields, current: () => Promise<InvoiceFields>): Promise<string> {
  try {
    return changedSinceBase(base, await current()).join(", ");
  } catch (err) {
    return `(could not compare: ${err instanceof Error ? err.message : err})`;
  }
}

/** Only a Delete notification (webhook or CDC) turns a QBO "not found" into a Void, never a bare 610. */
async function qboDeleteReported(pool: pg.Pool, qboId: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    "SELECT 1 FROM change_hints WHERE side = 'qbo' AND record_type = 'invoice' AND record_id = $1 AND dedupe_key LIKE 'qbo:Invoice:%:Delete:%'",
    [qboId],
  );
  return (rowCount ?? 0) > 0;
}

/** Every line zeroed while the Base had money on it, yet no "Voided" note: a void whose note was edited? */
const looksVoidedWithoutNote = (q: any, base: InvoiceFields) =>
  q.TotalAmt === 0 &&
  base.lines.some((l) => l.amountCents !== 0) &&
  (q.Line ?? []).filter((l: any) => l.DetailType === "SalesItemLineDetail").every((l: any) => l.Amount === 0);

const changedSinceBase = (base: InvoiceFields, now: InvoiceFields) =>
  (Object.keys(base) as (keyof InvoiceFields)[]).filter((f) => !isDeepStrictEqual(base[f], now[f]));

/**
 * Brings one Invoice into agreement. The job names a record on one Side; a
 * linked pair goes through the merge, an unlinked record is created on the other Side.
 */
export async function syncInvoice(deps: SyncDeps, run: Run): Promise<void> {
  const { pool } = deps;
  const { side, record_id: id } = run.job;
  try {
    let docNumber = (await findLink(pool, side, id))?.doc_number;
    if (!docNumber) {
      const record = side === "internal" ? await deps.internal.getInvoice(id) : await getQboInvoice(deps, id);
      if (!record) return run.record(pool, "skipped", `Invoice ${id} no longer exists on the ${side} Side`);
      docNumber = side === "internal" ? record.docNumber : record.DocNumber;
      if (!docNumber) throw new NeedsAttention("The QBO Invoice has no DocNumber; turn on Custom transaction numbers");
    }
    await withInvoiceLock(pool, docNumber!, async () => {
      // Re-read under the lock: the other Side's job may have just linked this record,
      // or this record may be the result of a create still pending on its Link.
      const link = (await findLink(pool, side, id)) ?? (await findPendingLink(pool, docNumber!));
      if (link && isIncomplete(link)) return resumeCreate(deps, run, link);
      if (link) return syncPair(deps, run, link);
      const record = side === "internal" ? await deps.internal.getInvoice(id) : await getQboInvoice(deps, id);
      if (!record) return run.record(pool, "skipped", `Invoice ${id} no longer exists on the ${side} Side`);
      run.snapshots[side] = record;
      return side === "internal" ? createInQbo(deps, run, record) : createInternally(deps, run, record);
    });
  } catch (err) {
    if (!(err instanceof NeedsAttention)) throw err;
    await tx(pool, async (c) => {
      // Flag a linked pair so it shows on the admin page; the next clean run sets it back to linked.
      if (run.linkId) await c.query("UPDATE links SET state = 'attention', updated_at = now() WHERE id = $1 AND state = 'linked'", [run.linkId]);
      await run.record(c, "attention", err.message, run.linkId);
    });
  }
}
