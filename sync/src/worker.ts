import type pg from "pg";
import { tx } from "../../shared/db.ts";
import type { SyncDeps } from "./app.ts";
import { syncInvoice } from "./invoice-sync.ts";

type Hint = { side: "internal" | "qbo"; recordType: string; recordId: string; dedupeKey: string };
export type Job = { id: string; side: string; record_type: string; record_id: string; attempts: number; lease_token: string };
type Write = { side: "internal" | "qbo"; action: "create" | "update"; entity: string; id: string; fields?: string[] };
type Outcome = "synced" | "skipped" | "attention" | "conflict" | "paused" | "failed";

const LEASE = "5 minutes";
const MAX_ATTEMPTS = 10;

export type RetryConfig = { transientBaseMs: number; staleMs: number; authMs: number };
export const DEFAULT_RETRY: RetryConfig = { transientBaseMs: 1_000, staleMs: 500, authMs: 5 * 60_000 };

export type ErrorClass = "transient" | "stale" | "auth" | "not_found" | "permanent";

/**
 * Sorts a failed call by what retrying can achieve. Both Side clients throw
 * errors carrying the HTTP `status` (and QBO's fault `code`); anything without
 * one is a network failure or timeout, where the write may or may not have landed.
 */
export function classify(err: any): ErrorClass {
  const status: number | undefined = err?.status;
  if (err?.code === "5010" || status === 409) return "stale"; // QBO stale SyncToken / internal If-Match
  if (status === 401) return "auth"; // expired or revoked connection: hold until reconnected
  if (err?.code === "610" || status === 404) return "not_found";
  if (status === 429 || (status !== undefined && status >= 500)) return "transient";
  if (status !== undefined) return "permanent";
  // No HTTP reply: a timeout or dropped connection, where the write may or may not have landed.
  if (err?.name === "TimeoutError" || err?.name === "AbortError" || (err instanceof TypeError && /fetch failed/i.test(err.message))) {
    return "transient";
  }
  // Postgres connection loss, serialization failure, shutdown.
  if (typeof err?.code === "string" && /^(08|40|57P)/.test(err.code)) return "transient";
  return "permanent"; // a bug or unexpected data: retrying will not help
}

/** When to run a failed job again, or null to fail it now. */
function retryDelay(cls: ErrorClass, attempts: number, cfg: RetryConfig): number | null {
  switch (cls) {
    case "transient":
      return attempts >= MAX_ATTEMPTS ? null : Math.min(cfg.transientBaseMs * 2 ** (attempts - 1), 15 * 60_000) * (0.5 + Math.random());
    case "stale":
      return attempts >= MAX_ATTEMPTS ? null : cfg.staleMs;
    case "auth":
      return cfg.authMs; // held, never given up: work resumes once the connection is fixed
    default:
      return null;
  }
}
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
    await enqueue(c, h.side, h.recordType, h.recordId);
  });
}

/** Queues a sync of one record, coalescing with a job already pending for it. */
export async function enqueue(c: pg.PoolClient, side: "internal" | "qbo", recordType: string, recordId: string): Promise<void> {
  await c.query(
    `INSERT INTO sync_jobs (side, record_type, record_id) VALUES ($1, $2, $3)
     ON CONFLICT (side, record_type, record_id) WHERE status = 'pending' DO NOTHING`,
    [side, recordType, recordId],
  );
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
    `UPDATE sync_jobs SET status = 'running', attempts = attempts + 1, lease_until = now() + interval '${LEASE}',
       lease_token = gen_random_uuid(), updated_at = now()
     WHERE id = (
       SELECT id FROM sync_jobs
       WHERE (status = 'pending' AND next_run_at <= now()) OR (status = 'running' AND lease_until < now())
       ORDER BY next_run_at, id LIMIT 1 FOR UPDATE SKIP LOCKED)
     RETURNING *`,
  );
  return rows[0] ?? null;
}

/** Thrown when this worker's lease on a job was taken over; its results are discarded. */
class LeaseLost extends Error {}

/** Everything one run learns and does, written as its single Sync Attempt. */
export class Run {
  job: Job;
  snapshots: Record<string, unknown> = {};
  writes: Write[] = [];
  /** The Link this run worked on, once known, so even a failed attempt shows in its history. */
  linkId: number | null = null;
  constructor(job: Job) {
    this.job = job;
  }
  /**
   * Writes the Sync Attempt and settles the job in one transaction. The lease
   * token set at claim fences it: if another worker reclaimed the job after our
   * lease expired, nothing is written (LeaseLost).
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
  async settle(db: pg.PoolClient, change: { status: string; backoffMs?: number; resetAttempts?: boolean } | null) {
    const { rowCount } = await db.query(
      `UPDATE sync_jobs SET status = COALESCE($3::text, status), lease_until = CASE WHEN $3::text IS NULL THEN lease_until END,
         next_run_at = now() + COALESCE($4::float8, 0) * interval '1 ms',
         attempts = CASE WHEN $5 THEN 0 ELSE attempts END, updated_at = now()
       WHERE id = $1 AND lease_token = $2 AND status = 'running'`,
      [this.job.id, this.job.lease_token, change?.status ?? null, change?.backoffMs ?? null, change?.resetAttempts ?? false],
    );
    if (rowCount === 0) throw new LeaseLost(`job ${this.job.id} was reclaimed by another worker`);
  }
}

/** Runs one job and writes exactly one Sync Attempt for it; failures retry with backoff. */
async function processJob(deps: SyncDeps, job: Job): Promise<void> {
  const run = new Run(job);
  try {
    await syncInvoice(deps, run);
  } catch (err) {
    if (err instanceof LeaseLost) return;
    const cls = classify(err);
    const message = `[${cls}] ${err instanceof Error ? err.message : String(err)}`;
    const delayMs = retryDelay(cls, job.attempts, deps.retry ?? DEFAULT_RETRY);
    const next = delayMs === null ? { status: "failed" } : { status: "pending", backoffMs: delayMs, resetAttempts: cls === "auth" };
    const summary = `Failed (${cls}) after ${run.writes.length} write(s); ${delayMs === null ? "giving up" : "will retry"}`;
    await tx(deps.pool, async (c) => {
      await run.record(c, "failed", summary, run.linkId, message);
      await c.query("SAVEPOINT retry");
      try {
        await run.settle(c, next);
      } catch (e: any) {
        // A newer hint already queued a pending job for this record. It does the retry, but
        // inherits this one's delay and attempt count so backoff and the give-up limit still hold.
        if (e.code !== "23505") throw e;
        await c.query("ROLLBACK TO SAVEPOINT retry");
        await c.query(
          `UPDATE sync_jobs SET next_run_at = GREATEST(next_run_at, now() + $4::float8 * interval '1 ms'),
             attempts = GREATEST(attempts, $5), updated_at = now()
           WHERE side = $1 AND record_type = $2 AND record_id = $3 AND status = 'pending'`,
          [job.side, job.record_type, job.record_id, delayMs ?? 0, cls === "auth" ? 0 : job.attempts],
        );
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
