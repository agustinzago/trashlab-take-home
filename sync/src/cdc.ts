import type { SyncDeps } from "./app.ts";
import { SYNCED_QBO_ENTITIES, qboHintKey, recordHint } from "./worker.ts";

const OVERLAP_MS = 60_000;
const FIRST_POLL_LOOKBACK_MS = 60 * 60_000; // older changes are adopted by the backfill command
const MAX_LOOKBACK_MS = 29 * 24 * 60 * 60_000; // QBO's CDC reaches back 30 days at most
const MAX_ROWS = 1000; // QBO caps each entity's CDC response

/**
 * One change-data-capture poll: every Invoice and Payment QBO reports changed
 * since the stored cursor (minus a minute of overlap, for clock skew and changes
 * landing during the last poll) becomes a Change Hint. Deletes come through too.
 * Hints use the webhook's dedupe key, so a change seen both ways is stored once.
 * The cursor moves only after every hint is recorded.
 */
export async function pollCdc(deps: SyncDeps): Promise<number> {
  const { rows } = await deps.pool.query("SELECT cursor FROM cdc_cursor WHERE id = 1");
  let since = rows[0] ? rows[0].cursor.getTime() - OVERLAP_MS : Date.now() - FIRST_POLL_LOOKBACK_MS;
  if (since < Date.now() - MAX_LOOKBACK_MS) {
    console.warn("CDC cursor is older than QBO keeps changes; anything older was missed: run the backfill command");
    since = Date.now() - MAX_LOOKBACK_MS;
  }
  const { entities, time } = await deps.qbo.cdc(SYNCED_QBO_ENTITIES, new Date(since).toISOString());
  let hints = 0;
  let truncated = false;
  let latest = since;
  for (const [entity, records] of Object.entries(entities)) {
    if (records.length >= MAX_ROWS) truncated = true;
    for (const r of records) {
      const lastUpdated: string | undefined = r.MetaData?.LastUpdatedTime;
      if (lastUpdated) latest = Math.max(latest, Date.parse(lastUpdated));
      await recordHint(deps.pool, {
        side: "qbo",
        recordType: entity.toLowerCase(),
        recordId: r.Id,
        dedupeKey: qboHintKey(entity, r.Id, r.status === "Deleted" ? "Delete" : undefined, lastUpdated),
      });
      hints++;
    }
  }
  // QBO's own clock for the next poll (ours may disagree), unless the response was
  // cut off: then only as far as what was actually seen, so the rest is read next time.
  const cursor = truncated ? new Date(latest).toISOString() : time;
  await deps.pool.query("INSERT INTO cdc_cursor (id, cursor) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET cursor = EXCLUDED.cursor", [
    cursor,
  ]);
  return hints;
}

/** Polls now and then every minute until stopped; a poll never overlaps the previous one. */
export function startCdcPoller(deps: SyncDeps): () => void {
  let running = false;
  const poll = async () => {
    if (running) return;
    running = true;
    await pollCdc(deps).catch((err) => console.error(`CDC poll failed: ${err.message}`));
    running = false;
  };
  void poll();
  const timer = setInterval(poll, 60_000);
  return () => clearInterval(timer);
}
