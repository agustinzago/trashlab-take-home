import type pg from "pg";
import { tx } from "../../shared/db.ts";
import type { SyncDeps } from "./app.ts";
import type { InternalInvoice } from "./internal.ts";

type Hint = { side: "internal" | "qbo"; recordType: string; recordId: string; dedupeKey: string };
type Job = { id: string; side: string; record_type: string; record_id: string; attempts: number };
type Write = { side: "internal" | "qbo"; action: "create"; entity: string; id: string };
type Outcome = "synced" | "skipped" | "attention" | "failed";

const LEASE = "5 minutes";
const MAX_ATTEMPTS = 10;
// Record types that are synced so far; other hints are kept but start no job.
const SYNCED_TYPES = new Set(["invoice"]);

/** Stores a Change Hint (dropping redeliveries) and coalesces it into one pending job per record. */
export async function recordHint(pool: pg.Pool, h: Hint): Promise<void> {
  await tx(pool, async (c) => {
    const hint = await c.query(
      `INSERT INTO change_hints (side, record_type, record_id, dedupe_key) VALUES ($1, $2, $3, $4)
       ON CONFLICT (dedupe_key) DO NOTHING`,
      [h.side, h.recordType, h.recordId, h.dedupeKey],
    );
    if (hint.rowCount === 0 || !SYNCED_TYPES.has(h.recordType)) return;
    await c.query(
      `INSERT INTO sync_jobs (side, record_type, record_id) VALUES ($1, $2, $3)
       ON CONFLICT (side, record_type, record_id) WHERE status = 'pending' DO NOTHING`,
      [h.side, h.recordType, h.recordId],
    );
  });
}

export async function setAccountMapping(
  pool: pg.Pool,
  kind: "revenue_category" | "payment_method",
  internalKey: string,
  qboRef: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO account_mappings (kind, internal_key, qbo_ref) VALUES ($1, $2, $3)
     ON CONFLICT (kind, internal_key) DO UPDATE SET qbo_ref = EXCLUDED.qbo_ref`,
    [kind, internalKey, qboRef],
  );
}

/** Claims the next due job (or one whose lease expired) with SKIP LOCKED. */
async function claimJob(pool: pg.Pool): Promise<Job | null> {
  // A job whose runs keep dying without finishing (e.g. crashing the process) stops being reclaimed.
  await pool.query(
    `UPDATE sync_jobs SET status = 'failed', updated_at = now()
     WHERE status = 'running' AND lease_until < now() AND attempts >= ${MAX_ATTEMPTS}`,
  );
  const { rows } = await pool.query(
    `UPDATE sync_jobs SET status = 'running', attempts = attempts + 1, lease_until = now() + interval '${LEASE}', updated_at = now()
     WHERE id = (
       SELECT id FROM sync_jobs
       WHERE (status = 'pending' AND next_run_at <= now()) OR (status = 'running' AND lease_until < now())
       ORDER BY next_run_at, id LIMIT 1 FOR UPDATE SKIP LOCKED)
     RETURNING *`,
  );
  return rows[0] ?? null;
}

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

/** Thrown when this worker's lease on a job was taken over; its results are discarded. */
class LeaseLost extends Error {}

/** Everything one run learns and does, written as its single Sync Attempt. */
class Run {
  job: Job;
  snapshots: Record<string, unknown> = {};
  writes: Write[] = [];
  constructor(job: Job) {
    this.job = job;
  }
  /**
   * Writes the Sync Attempt and settles the job in one transaction. The job's
   * attempt count is the fencing token: if another worker reclaimed the job
   * after our lease expired, nothing is written (LeaseLost).
   */
  async record(db: pg.Pool | pg.PoolClient, outcome: Outcome, summary: string, linkId: number | null = null, error?: string): Promise<void> {
    if (!("release" in db)) return tx(db, (c) => this.record(c, outcome, summary, linkId, error));
    await this.settle(db, outcome === "failed" ? null : { status: "done" });
    await db.query(
      `INSERT INTO sync_attempts (link_id, job_id, trigger, outcome, summary, snapshots, writes, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        linkId,
        this.job.id,
        JSON.stringify({ side: this.job.side, recordType: this.job.record_type, recordId: this.job.record_id, attempt: this.job.attempts }),
        outcome,
        summary,
        JSON.stringify(this.snapshots),
        JSON.stringify(this.writes),
        error ?? null,
      ],
    );
  }

  /** Updates this job only while we still hold it; `null` leaves the status for the caller. */
  async settle(db: pg.PoolClient, change: { status: string; backoffMs?: number } | null) {
    const { rowCount } = await db.query(
      `UPDATE sync_jobs SET status = COALESCE($3::text, status), lease_until = CASE WHEN $3::text IS NULL THEN lease_until END,
         next_run_at = now() + COALESCE($4::float8, 0) * interval '1 ms', updated_at = now()
       WHERE id = $1 AND attempts = $2 AND status = 'running'`,
      [this.job.id, this.job.attempts, change?.status ?? null, change?.backoffMs ?? null],
    );
    if (rowCount === 0) throw new LeaseLost(`job ${this.job.id} was reclaimed by another worker`);
  }
}

/** The Base shape: an Invoice's synced fields, identical whichever Side they came from. */
function normalizeInternal(inv: InternalInvoice, customerName: string) {
  return {
    docNumber: inv.docNumber,
    customer: customerName,
    txnDate: inv.txnDate,
    dueDate: inv.dueDate,
    memo: inv.memo,
    lines: inv.lines.map((l) => ({ description: l.description, amountCents: l.amountCents, revenueCategory: l.revenueCategory })),
  };
}

async function syncInternalInvoice(deps: SyncDeps, run: Run): Promise<void> {
  const { pool, internal, qbo } = deps;
  const id = run.job.record_id;
  const first = await internal.getInvoice(id);
  if (!first) return run.record(pool, "skipped", "Invoice no longer exists internally (a deleted draft)");

  // ponytail: locks the DocNumber seen before locking; an Identity Field change mid-run is flagged by the merge (#5).
  await withInvoiceLock(pool, first.docNumber, async () => {
    const inv = await internal.getInvoice(id); // refetch under the lock
    if (!inv) return run.record(pool, "skipped", "Invoice no longer exists internally (a deleted draft)");
    run.snapshots.internal = inv;
    if (inv.status === "draft") return run.record(pool, "skipped", "Draft Invoices are never synced");

    const link = (await pool.query("SELECT * FROM links WHERE record_type = 'invoice' AND internal_id = $1", [id])).rows[0];
    if (link) return run.record(pool, "skipped", "Already linked; syncing updates is not supported yet", link.id);
    if (inv.status === "voided") return run.record(pool, "skipped", "Voided before it was ever synced; nothing to create");

    const existing = await qbo.query("Invoice", ["DocNumber", inv.docNumber]);
    run.snapshots.qbo = existing[0] ?? null;
    if (existing.length) {
      return run.record(pool, "attention", `QBO already has an unlinked Invoice with DocNumber ${inv.docNumber}`);
    }

    const categories = [...new Set(inv.lines.map((l) => l.revenueCategory))];
    const { rows: mappings } = await pool.query(
      "SELECT internal_key, qbo_ref FROM account_mappings WHERE kind = 'revenue_category' AND internal_key = ANY($1)",
      [categories],
    );
    const itemFor = new Map<string, string>(mappings.map((m) => [m.internal_key, m.qbo_ref]));
    const unmapped = categories.filter((c) => !itemFor.has(c));
    if (unmapped.length) {
      return run.record(pool, "attention", `No Account Mapping for revenue categories: ${unmapped.join(", ")}`);
    }

    const customer = await internal.getCustomer(inv.customerId);
    if (!customer) throw new Error(`internal customer ${inv.customerId} not found`);
    let qboCustomer = (await qbo.query("Customer", ["DisplayName", customer.displayName]))[0];
    if (!qboCustomer) {
      qboCustomer = await qbo.create("Customer", { DisplayName: customer.displayName });
      run.writes.push({ side: "qbo", action: "create", entity: "Customer", id: qboCustomer.Id });
    }

    const created = await qbo.create("Invoice", {
      DocNumber: inv.docNumber,
      TxnDate: inv.txnDate,
      ...(inv.dueDate ? { DueDate: inv.dueDate } : {}),
      ...(inv.memo ? { CustomerMemo: { value: inv.memo } } : {}),
      CustomerRef: { value: qboCustomer.Id },
      Line: inv.lines.map((l) => ({
        DetailType: "SalesItemLineDetail",
        Amount: l.amountCents / 100,
        Description: l.description,
        SalesItemLineDetail: { ItemRef: { value: itemFor.get(l.revenueCategory) } },
      })),
    });
    run.writes.push({ side: "qbo", action: "create", entity: "Invoice", id: created.Id });
    run.snapshots.qbo = created;

    await tx(pool, async (c) => {
      const { rows } = await c.query(
        `INSERT INTO links (record_type, internal_id, qbo_id, doc_number, state, base)
         VALUES ('invoice', $1, $2, $3, 'linked', $4) RETURNING id`,
        [id, created.Id, inv.docNumber, JSON.stringify(normalizeInternal(inv, customer.displayName))],
      );
      const customerNote = run.writes.length > 1 ? ` and Customer ${qboCustomer.Id}` : "";
      await run.record(c, "synced", `Created QBO Invoice ${created.Id} (DocNumber ${inv.docNumber})${customerNote}`, rows[0].id);
    });
  });
}

/** Runs one job and writes exactly one Sync Attempt for it; failures retry with backoff. */
async function processJob(deps: SyncDeps, job: Job): Promise<void> {
  const run = new Run(job);
  try {
    await syncInternalInvoice(deps, run);
  } catch (err) {
    if (err instanceof LeaseLost) return;
    const message = err instanceof Error ? err.message : String(err);
    // ponytail: every error retries the same way; per-class policy (transient/stale/auth/permanent) arrives with #7.
    const giveUp = job.attempts >= MAX_ATTEMPTS;
    const backoffMs = Math.min(1000 * 2 ** job.attempts, 15 * 60_000) * (0.5 + Math.random());
    await tx(deps.pool, async (c) => {
      await run.record(c, "failed", `Failed after ${run.writes.length} write(s)`, null, message);
      await c.query("SAVEPOINT retry");
      try {
        await run.settle(c, { status: giveUp ? "failed" : "pending", backoffMs });
      } catch (e: any) {
        // A newer hint already queued a pending job for this record; that job does the retry.
        if (e.code !== "23505") throw e;
        await c.query("ROLLBACK TO SAVEPOINT retry");
        await run.settle(c, { status: "done" });
      }
    }).catch((e) => {
      if (!(e instanceof LeaseLost)) throw e;
    });
  }
}

/** Processes due jobs until none are left. */
export async function drain(deps: SyncDeps): Promise<number> {
  let processed = 0;
  for (let job = await claimJob(deps.pool); job; job = await claimJob(deps.pool)) {
    await processJob(deps, job);
    processed++;
  }
  return processed;
}

/** Drains continuously until the returned stop function is called. */
export function startWorker(deps: SyncDeps, idleMs = 500): () => Promise<void> {
  let running = true;
  const loop = (async () => {
    while (running) {
      const processed = await drain(deps).catch((err) => {
        console.error("sync worker failed", err);
        return 0;
      });
      if (processed === 0) await new Promise((r) => setTimeout(r, idleMs));
    }
  })();
  return async () => {
    running = false;
    await loop;
  };
}
