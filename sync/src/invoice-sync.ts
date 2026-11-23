import type pg from "pg";
import { tx } from "../../shared/db.ts";
import type { SyncDeps } from "./app.ts";
import type { InternalInvoice } from "./internal.ts";
import { merge, type InvoiceFields, type Line } from "./merge.ts";
import type { Run } from "./worker.ts";

/** A problem only a person can fix (missing mapping, identity clash); recorded as Needs Attention. */
class NeedsAttention extends Error {}

type Link = { id: number; internal_id: string | null; qbo_id: string | null; doc_number: string; state: string; base: InvoiceFields };

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
  const created = await deps.qbo.create("Customer", { DisplayName: name });
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

// --- The three kinds of run --------------------------------------------------------

/** An internal Invoice with no Link: create it in QBO. */
async function createInQbo(deps: SyncDeps, run: Run, inv: InternalInvoice): Promise<void> {
  if (inv.status === "draft") return run.record(deps.pool, "skipped", "Draft Invoices are never synced");
  if (inv.status === "voided") return run.record(deps.pool, "skipped", "Voided before it was ever synced; nothing to create");
  const existing = await deps.qbo.query("Invoice", ["DocNumber", inv.docNumber]);
  if (existing.length) {
    run.snapshots.qbo = existing[0];
    throw new NeedsAttention(`QBO already has an unlinked Invoice with DocNumber ${inv.docNumber}`);
  }
  const customer = await deps.internal.getCustomer(inv.customerId);
  if (!customer) throw new Error(`internal customer ${inv.customerId} not found`);
  const fields = normalizeInternal(inv, customer.displayName);
  const created = await deps.qbo.create("Invoice", await toQboFields(deps, run, fields));
  run.writes.push({ side: "qbo", action: "create", entity: "Invoice", id: created.Id });
  run.snapshots.qbo = created;
  await saveNewLink(deps.pool, run, String(inv.id), created.Id, fields, `Created QBO Invoice ${created.Id}`);
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
  const { customer, ...rest } = fields;
  const created = await deps.internal.createInvoice(
    { ...rest, customerId: await internalCustomerId(deps, run, customer), status: "issued" },
    `qbo-invoice:${q.Id}`,
  );
  run.writes.push({ side: "internal", action: "create", entity: "Invoice", id: String(created.id) });
  run.snapshots.internal = created;
  await saveNewLink(deps.pool, run, String(created.id), q.Id, fields, `Created internal Invoice ${created.id}`);
}

async function saveNewLink(pool: pg.Pool, run: Run, internalId: string, qboId: string, base: InvoiceFields, summary: string) {
  await tx(pool, async (c) => {
    const { rows } = await c.query(
      `INSERT INTO links (record_type, internal_id, qbo_id, doc_number, state, base)
       VALUES ('invoice', $1, $2, $3, 'linked', $4) RETURNING id`,
      [internalId, qboId, base.docNumber, JSON.stringify(base)],
    );
    await run.record(c, "synced", `${summary} (DocNumber ${base.docNumber})`, rows[0].id);
  });
}

/** A linked pair: refetch both Sides, merge against the Base, write the plan, advance the Base. */
async function syncPair(deps: SyncDeps, run: Run, link: Link): Promise<void> {
  const { pool, internal, qbo } = deps;
  if (link.state === "paused") {
    // The hint is kept (change_hints); nothing is written until a person resolves the Conflict.
    return run.record(pool, "paused", "Paused by an open Conflict; nothing written", link.id);
  }
  const inv = await internal.getInvoice(link.internal_id!);
  const q = await getQboInvoice(deps, link.qbo_id!);
  run.snapshots = { base: link.base, internal: inv, qbo: q };
  if (!inv || !q || inv.status === "voided" || isQboVoided(q)) {
    // ponytail: voids and deletes are handled by the Void and Delete ticket (#8).
    return run.record(pool, "skipped", "A Side is voided or deleted; voids are not synced yet", link.id);
  }

  const customer = await internal.getCustomer(inv.customerId);
  if (!customer) throw new Error(`internal customer ${inv.customerId} not found`);
  const result = merge({
    base: link.base,
    internal: normalizeInternal(inv, customer.displayName),
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
    const updated = await qbo.update("Invoice", { Id: q.Id, SyncToken: q.SyncToken, sparse: true, ...(await toQboFields(deps, run, toQbo)) });
    run.writes.push({ side: "qbo", action: "update", entity: "Invoice", id: q.Id, fields: Object.keys(toQbo) });
    run.snapshots.qboAfter = updated;
  }
  if (Object.keys(toInternal).length) {
    const updated = await internal.updateInvoice(inv.id, inv.version, await toInternalFields(deps, run, toInternal));
    run.writes.push({ side: "internal", action: "update", entity: "Invoice", id: String(inv.id), fields: Object.keys(toInternal) });
    run.snapshots.internalAfter = updated;
  }

  // The Base advances only once every write in this run has landed.
  const changed = [...Object.keys(toQbo).map((f) => `${f} -> QBO`), ...Object.keys(toInternal).map((f) => `${f} -> internal`)];
  const summary = changed.length ? `Copied ${changed.join(", ")}` : "No changes";
  await tx(pool, async (c) => {
    await c.query("UPDATE links SET base = $2, state = 'linked', updated_at = now() WHERE id = $1", [link.id, JSON.stringify(merged)]);
    await run.record(c, "synced", [summary, ...notes].join("; "), link.id);
  });
}

/**
 * Brings one Invoice into agreement. The job names a record on one Side; a
 * linked pair goes through the merge, an unlinked record is created on the other Side.
 */
export async function syncInvoice(deps: SyncDeps, run: Run): Promise<void> {
  const { pool } = deps;
  const { side, record_id: id } = run.job;
  try {
    const known = await findLink(pool, side, id);
    let docNumber = known?.doc_number;
    let record: any;
    if (!docNumber) {
      record = side === "internal" ? await deps.internal.getInvoice(id) : await getQboInvoice(deps, id);
      if (!record) return run.record(pool, "skipped", `Invoice ${id} no longer exists on the ${side} Side`);
      docNumber = side === "internal" ? record.docNumber : record.DocNumber;
      if (!docNumber) throw new NeedsAttention("The QBO Invoice has no DocNumber; turn on Custom transaction numbers");
    }
    await withInvoiceLock(pool, docNumber!, async () => {
      // Re-read under the lock: the other Side's job may have just linked this record.
      const link = await findLink(pool, side, id);
      if (link) return syncPair(deps, run, link);
      record = side === "internal" ? await deps.internal.getInvoice(id) : await getQboInvoice(deps, id);
      if (!record) return run.record(pool, "skipped", `Invoice ${id} no longer exists on the ${side} Side`);
      run.snapshots[side] = record;
      return side === "internal" ? createInQbo(deps, run, record) : createInternally(deps, run, record);
    });
  } catch (err) {
    if (!(err instanceof NeedsAttention)) throw err;
    await run.record(pool, "attention", err.message);
  }
}
