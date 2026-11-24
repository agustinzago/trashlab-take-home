import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { tx } from "../../shared/db.ts";
import type { Run } from "./worker.ts";

/** A problem only a person can fix (missing mapping, identity clash); recorded as Needs Attention. */
export class NeedsAttention extends Error {}

export type RecordType = "invoice" | "payment";

/**
 * The durable record joining one Invoice or Payment across the Sides. `doc_number`
 * is the record's identity on both Sides: an Invoice's DocNumber, or a Payment's ref.
 */
export type Link<Base = unknown> = {
  id: number;
  record_type: RecordType;
  internal_id: string | null;
  qbo_id: string | null;
  doc_number: string;
  state: string;
  base: Base;
  pending_request_id: string | null;
  parent_link_id: number | null;
};

/**
 * Holds a session advisory lock on an Invoice's DocNumber for the duration of `fn`,
 * serializing all work on that Invoice and its Payments across workers.
 */
export async function withInvoiceLock<T>(pool: pg.Pool, docNumber: string, fn: () => Promise<T>): Promise<T> {
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

export async function findLink<B>(pool: pg.Pool, recordType: RecordType, side: string, id: string): Promise<Link<B> | undefined> {
  const column = side === "internal" ? "internal_id" : "qbo_id";
  const { rows } = await pool.query(`SELECT * FROM links WHERE record_type = $1 AND ${column} = $2`, [recordType, id]);
  return rows[0];
}

/** A Link still missing one Side's id under one of these DocNumbers/refs: a create in flight (or stuck). */
export async function findIncompleteLink<B>(pool: pg.Pool, recordType: RecordType, docNumbers: string[]): Promise<Link<B> | undefined> {
  const { rows } = await pool.query(
    "SELECT * FROM links WHERE record_type = $1 AND (internal_id IS NULL OR qbo_id IS NULL) AND doc_number = ANY($2) ORDER BY id LIMIT 1",
    [recordType, docNumbers],
  );
  return rows[0];
}

export const isIncomplete = (link: Link) => link.internal_id === null || link.qbo_id === null;

/** A QBO requestid derived from what is being written, so a retry of the same write reuses it. */
export const requestIdFor = (...parts: unknown[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 36);

// The create protocol: commit a pending Link (holding the QBO requestid), call the
// other Side, then mark the Link linked. A timeout says nothing about whether the
// write landed, so a retry (or the echo of the write) finds the pending Link by
// DocNumber/ref and looks on the target first, adopting the record if it is there.

export async function insertPendingLink<B>(
  pool: pg.Pool,
  recordType: RecordType,
  internalId: string | null,
  qboId: string | null,
  docNumber: string,
  base: B,
  parentLinkId: number | null = null,
): Promise<Link<B>> {
  const { rows } = await pool.query(
    `INSERT INTO links (record_type, internal_id, qbo_id, doc_number, state, base, pending_request_id, parent_link_id)
     VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7) RETURNING *`,
    [recordType, internalId, qboId, docNumber, JSON.stringify(base), qboId === null ? randomUUID() : null, parentLinkId],
  );
  return rows[0];
}

export async function completeLink<B>(
  pool: pg.Pool,
  run: Run,
  link: Link<B>,
  ids: { internalId?: string; qboId?: string },
  base: B,
  summary: string,
) {
  await tx(pool, async (c) => {
    await c.query(
      `UPDATE links SET internal_id = COALESCE($2, internal_id), qbo_id = COALESCE($3, qbo_id), state = 'linked',
         base = $4, pending_request_id = NULL, updated_at = now() WHERE id = $1`,
      [link.id, ids.internalId ?? null, ids.qboId ?? null, JSON.stringify(base)],
    );
    const label = link.record_type === "invoice" ? "DocNumber" : "ref";
    await run.record(c, "synced", `${summary} (${label} ${link.doc_number})`, link.id);
  });
}

// QBO has no void flag: a voided Invoice or Payment is zeroed with a "Voided" note (confirmed in the sandbox spike).
export const isQboVoided = (q: any) => q.TotalAmt === 0 && String(q.PrivateNote ?? "").startsWith("Voided");
