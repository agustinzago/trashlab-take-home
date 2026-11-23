import { createHmac } from "node:crypto";
import type pg from "pg";

export type DeliveryConfig = {
  url: string;
  secret: string;
  /** Duplicate, delay and reorder deliveries, to prove the receiver copes. */
  chaos: boolean;
  chaosMaxDelayMs?: number;
  retryBaseMs?: number;
  random?: () => number;
};

const BATCH = 50;
const MAX_BACKOFF_MS = 60_000;
const LEASE_SECONDS = 300;

/** Records that `type`/`id` changed. Call inside the transaction that made the change. */
export async function emit(c: pg.PoolClient, type: "customer" | "invoice" | "payment", id: number): Promise<void> {
  await c.query("INSERT INTO outbox (record_type, record_id) VALUES ($1, $2)", [type, id]);
}

async function send(cfg: DeliveryConfig, row: any): Promise<boolean> {
  const body = JSON.stringify({ deliveryId: String(row.id), type: row.record_type, id: row.record_id });
  const signature = "sha256=" + createHmac("sha256", cfg.secret).update(body).digest("hex");
  try {
    const res = await fetch(cfg.url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-signature": signature },
      body,
      signal: AbortSignal.timeout(5_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * One delivery round: sends every due notification at least once. A failed
 * delivery is retried with exponential backoff until acknowledged with a 2xx.
 * Returns how many rows were due.
 */
export async function deliverDue(pool: pg.Pool, cfg: DeliveryConfig): Promise<number> {
  const random = cfg.random ?? Math.random;
  const retryBaseMs = cfg.retryBaseMs ?? 1_000;
  // Claim due rows with a lease and commit at once, so no transaction stays open
  // across HTTP calls. SKIP LOCKED keeps replicas from claiming the same rows.
  // ponytail: a lease outliving a slow batch lets another replica resend; fine for at-least-once.
  const { rows } = await pool.query(
    `UPDATE outbox SET next_attempt_at = now() + interval '${LEASE_SECONDS} seconds'
     WHERE id IN (SELECT id FROM outbox WHERE delivered_at IS NULL AND next_attempt_at <= now()
                  ORDER BY id LIMIT ${BATCH} FOR UPDATE SKIP LOCKED)
     RETURNING *`,
  );
  rows.sort((a, b) => Number(a.id) - Number(b.id));
  if (cfg.chaos) rows.sort(() => random() - 0.5);
  for (const row of rows) {
    if (cfg.chaos && random() < 0.3) {
      const delayMs = Math.round(random() * (cfg.chaosMaxDelayMs ?? 5_000));
      await pool.query("UPDATE outbox SET next_attempt_at = now() + $2 * interval '1 ms' WHERE id = $1", [row.id, delayMs]);
      continue;
    }
    const ok = await send(cfg, row);
    if (ok && cfg.chaos && random() < 0.3) await send(cfg, row);
    if (ok) {
      await pool.query("UPDATE outbox SET delivered_at = now(), attempts = attempts + 1 WHERE id = $1", [row.id]);
    } else {
      const backoffMs = Math.min(retryBaseMs * 2 ** row.attempts, MAX_BACKOFF_MS);
      await pool.query(
        "UPDATE outbox SET attempts = attempts + 1, next_attempt_at = now() + $2 * interval '1 ms' WHERE id = $1",
        [row.id, backoffMs],
      );
    }
  }
  return rows.length;
}

/** Delivers continuously until the returned stop function is called. */
export function startDelivery(pool: pg.Pool, cfg: DeliveryConfig, idleMs = 500): () => Promise<void> {
  let running = true;
  const loop = (async () => {
    while (running) {
      const due = await deliverDue(pool, cfg).catch((err) => {
        console.error("outbox delivery failed", err);
        return 0;
      });
      if (due === 0) await new Promise((r) => setTimeout(r, idleMs));
    }
  })();
  return async () => {
    running = false;
    await loop;
  };
}
