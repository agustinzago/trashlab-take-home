import { timingSafeEqual } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { tx } from "../../shared/db.ts";
import { withInvoiceLock } from "./links.ts";
import { registerConnectRoute, type OAuthConfig } from "./qbo-auth.ts";
import { SYNCED_FIELDS } from "./merge.ts";
import { enqueue } from "./worker.ts";

type Winner = "internal" | "qbo";

const httpError = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });

/**
 * Resolves a Conflict for one Side. Each conflicting field's Base becomes the
 * losing Side's value as it was when the Conflict was raised, so the next run
 * sees only the winner as changed and copies it through the normal path. If the
 * loser was edited since, that field differs from the Base on both Sides again
 * and re-conflicts instead of silently overwriting an unreviewed edit.
 */
export async function resolveConflict(pool: pg.Pool, conflictId: number, winner: Winner) {
  return tx(pool, async (c) => {
    const { rows } = await c.query(
      `SELECT c.*, l.base, l.internal_id, l.state FROM conflicts c JOIN links l ON l.id = c.link_id WHERE c.id = $1 FOR UPDATE OF c, l`,
      [conflictId],
    );
    const conflict = rows[0];
    if (!conflict) throw httpError(404, "conflict not found");
    if (conflict.status !== "open") throw httpError(409, "conflict is already resolved");
    // Only a paused Link is waiting on this; any other state (e.g. a later Void) must not be undone here.
    if (conflict.state !== "paused") throw httpError(409, `the Invoice is ${conflict.state}, not paused`);
    const loser = winner === "internal" ? "qbo" : "internal";
    const base = { ...conflict.base };
    for (const f of conflict.fields) base[f.field] = f[loser];
    await c.query("UPDATE links SET base = $2, state = 'linked', updated_at = now() WHERE id = $1", [conflict.link_id, JSON.stringify(base)]);
    await c.query("UPDATE conflicts SET status = 'resolved', winner = $2, resolved_at = now() WHERE id = $1", [conflictId, winner]);
    await enqueue(c, "internal", "invoice", conflict.internal_id);
    return { id: conflictId, linkId: conflict.link_id, status: "resolved", winner };
  });
}

/**
 * Confirms a Link Candidate the same way a Conflict is resolved: the Link is created
 * with a Base equal to the losing Side's values as raised, so the next run copies
 * the winner across. A loser edited since then conflicts on a Financial Field
 * (a Cosmetic Field falls to last-writer-wins, as everywhere else).
 * Runs under the Invoice's lock so it cannot interleave with a run on the same pair.
 */
export async function confirmCandidate(pool: pg.Pool, candidateId: number, winner: Winner) {
  const doc = (await pool.query("SELECT doc_number FROM link_candidates WHERE id = $1", [candidateId])).rows[0]?.doc_number;
  if (!doc) throw httpError(404, "link candidate not found");
  return withInvoiceLock(pool, doc, () => confirmLocked(pool, candidateId, winner));
}

async function confirmLocked(pool: pg.Pool, candidateId: number, winner: Winner) {
  return tx(pool, async (c) => {
    const { rows } = await c.query("SELECT * FROM link_candidates WHERE id = $1 FOR UPDATE", [candidateId]);
    const candidate = rows[0];
    if (!candidate) throw httpError(404, "link candidate not found");
    if (candidate.status !== "open") throw httpError(409, `link candidate is ${candidate.status}`);
    const base = winner === "internal" ? candidate.qbo_fields : candidate.internal_fields;
    const { rows: link } = await c.query(
      `INSERT INTO links (record_type, internal_id, qbo_id, doc_number, state, base) VALUES ('invoice', $1, $2, $3, 'linked', $4)
       ON CONFLICT DO NOTHING RETURNING id`,
      [candidate.internal_id, candidate.qbo_id, candidate.doc_number, JSON.stringify(base)],
    );
    if (!link[0]) throw httpError(409, "one of these Invoices has been linked since");
    await c.query("UPDATE link_candidates SET status = 'confirmed', winner = $2, confirmed_at = now() WHERE id = $1", [candidateId, winner]);
    await enqueue(c, "internal", "invoice", candidate.internal_id);
    return { id: candidateId, linkId: link[0].id, status: "confirmed", winner };
  });
}

// --- Queries behind both the JSON API and the page ---------------------------------

async function openCandidates(pool: pg.Pool) {
  const { rows } = await pool.query("SELECT * FROM link_candidates WHERE status = 'open' ORDER BY id");
  return rows.map((r) => ({
    id: r.id,
    docNumber: r.doc_number,
    internalId: r.internal_id,
    qboId: r.qbo_id,
    internal: r.internal_fields,
    qbo: r.qbo_fields,
    raisedAt: r.raised_at,
  }));
}

const recordLabel = (side: string, recordType: string, recordId: string) => `${side} ${recordType} ${recordId}`;

async function openConflicts(pool: pg.Pool) {
  const { rows } = await pool.query(
    `SELECT c.id, c.link_id, l.doc_number, c.fields, c.raised_at FROM conflicts c JOIN links l ON l.id = c.link_id
     WHERE c.status = 'open' ORDER BY c.id`,
  );
  return rows.map((r) => ({ id: r.id, linkId: r.link_id, docNumber: r.doc_number, fields: r.fields, raisedAt: r.raised_at }));
}

/**
 * The latest Sync Attempt per Invoice (per Link once linked, else per record)
 * when it is Needs Attention. An unlinked record that has since been linked drops off.
 */
async function needsAttention(pool: pg.Pool) {
  // ponytail: scans all attempts; add an index on the record key when history grows large.
  const { rows } = await pool.query(
    `SELECT * FROM (
       SELECT DISTINCT ON (key) a.id AS attempt_id, a.link_id, a.outcome, a.summary, a.created_at, a.trigger, l.doc_number, l.state
       FROM (SELECT *, COALESCE('link:' || link_id, (trigger->>'side') || ':' || (trigger->>'recordId')) AS key FROM sync_attempts) a
       LEFT JOIN links l ON l.id = a.link_id
       ORDER BY key, a.id DESC
     ) latest
     WHERE outcome = 'attention' AND (state = 'attention' OR (link_id IS NULL AND NOT EXISTS (
       SELECT 1 FROM links k WHERE k.record_type = trigger->>'recordType'
         AND (CASE WHEN trigger->>'side' = 'internal' THEN k.internal_id ELSE k.qbo_id END) = trigger->>'recordId')))
     ORDER BY attempt_id DESC LIMIT 100`,
  );
  return rows.map((r) => ({
    attemptId: r.attempt_id,
    linkId: r.link_id,
    docNumber: r.doc_number,
    record: recordLabel(r.trigger.side, r.trigger.recordType, r.trigger.recordId),
    summary: r.summary,
    at: r.created_at,
  }));
}

async function failedJobs(pool: pg.Pool) {
  const { rows } = await pool.query(
    `SELECT j.id, j.side, j.record_type, j.record_id, j.attempts, j.updated_at,
       (SELECT error FROM sync_attempts a WHERE a.job_id = j.id ORDER BY a.id DESC LIMIT 1) AS error
     FROM sync_jobs j WHERE j.status = 'failed' ORDER BY j.id DESC LIMIT 100`,
  );
  return rows.map((r) => ({
    id: r.id,
    record: recordLabel(r.side, r.record_type, r.record_id),
    attempts: r.attempts,
    error: r.error,
    at: r.updated_at,
  }));
}

async function attempts(pool: pg.Pool, linkId: number) {
  const { rows } = await pool.query(
    "SELECT id, trigger, outcome, summary, writes, error, notes, created_at FROM sync_attempts WHERE link_id = $1 ORDER BY id DESC",
    [linkId],
  );
  return rows.map((r) => ({
    id: r.id,
    trigger: r.trigger,
    outcome: r.outcome,
    summary: r.summary,
    writes: r.writes,
    error: r.error,
    notes: r.notes,
    at: r.created_at,
  }));
}

// --- HTML -------------------------------------------------------------------------

const esc = (v: unknown) =>
  String(v ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

function showValue(field: string, value: any): string {
  if (field !== "lines") return esc(value ?? "(empty)");
  const items = (value as { description: string; amountCents: number; revenueCategory: string }[]).map(
    (l) => `<li>${esc(l.description)}: ${(l.amountCents / 100).toFixed(2)} <small>(${esc(l.revenueCategory)})</small></li>`,
  );
  return `<ul>${items.join("")}</ul>`;
}

const page = (title: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  body { font: 14px/1.45 system-ui, sans-serif; margin: 24px auto; max-width: 1000px; padding: 0 16px; color: #1d1d1f; background: #fff; }
  table { border-collapse: collapse; width: 100%; margin: 8px 0 24px; }
  th, td { border-bottom: 1px solid #ddd; padding: 6px 8px; text-align: left; vertical-align: top; }
  th { background: #f5f5f7; } ul { margin: 0; padding-left: 18px; } .empty { color: #777; }
  button { padding: 4px 10px; margin-right: 6px; }
</style></head><body>${body}</body></html>`;

const table = (headers: string[], rows: string[][]) =>
  rows.length
    ? `<table><tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</table>`
    : `<p class="empty">None.</p>`;

const linkTo = (linkId: number | null, label: unknown) => (linkId ? `<a href="/admin/links/${linkId}">${esc(label)}</a>` : esc(label));

/** Admin routes, in their own encapsulated scope so the form parser and auth hooks touch nothing else. */
export function registerAdmin(root: FastifyInstance, pool: pg.Pool, adminPassword: string | undefined, oauth?: OAuthConfig) {
  root.register(async (app) => {
    await adminRoutes(app, pool, adminPassword);
    if (oauth) registerConnectRoute(app, pool, oauth); // behind the same password
  });
}

async function adminRoutes(app: FastifyInstance, pool: pg.Pool, adminPassword: string | undefined) {
  // HTML forms post urlencoded bodies.
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) =>
    done(null, Object.fromEntries(new URLSearchParams(body as string))),
  );

  // A browser sends Basic credentials with any cross-site form post; refuse posts from another origin.
  app.addHook("onRequest", async (req, reply) => {
    if (req.method !== "POST") return;
    const origin = req.headers.origin;
    const crossSite = req.headers["sec-fetch-site"] === "cross-site" || (origin && new URL(origin).host !== req.headers.host);
    if (crossSite) return reply.code(403).send({ message: "cross-site request refused" });
  });

  // ponytail: one shared password over HTTP Basic; put it behind real auth before exposing it beyond operators.
  if (adminPassword) {
    const expected = Buffer.from("Basic " + Buffer.from(`admin:${adminPassword}`).toString("base64"));
    app.addHook("onRequest", async (req, reply) => {
      const given = Buffer.from(req.headers.authorization ?? "");
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
        return reply.code(401).header("www-authenticate", 'Basic realm="sync admin"').send();
      }
    });
  }

  const idParams = { type: "object", properties: { id: { type: "integer" } } } as const;
  const idOf = (req: { params: unknown }) => (req.params as { id: number }).id;
  const winnerBody = {
    type: "object",
    required: ["winner"],
    properties: { winner: { type: "string", enum: ["internal", "qbo"] } },
  } as const;

  app.get("/admin/api/conflicts", () => openConflicts(pool));
  app.get("/admin/api/candidates", () => openCandidates(pool));
  app.get("/admin/api/attention", () => needsAttention(pool));
  app.get("/admin/api/failed-jobs", () => failedJobs(pool));
  app.get("/admin/api/links/:id/attempts", { schema: { params: idParams } }, (req) => attempts(pool, idOf(req)));
  // Each action twice: JSON for the API, a redirect back to the page for its form.
  for (const [url, fromForm, action] of [
    ["/admin/api/conflicts/:id/resolve", false, resolveConflict],
    ["/admin/conflicts/:id/resolve", true, resolveConflict],
    ["/admin/api/candidates/:id/confirm", false, confirmCandidate],
    ["/admin/candidates/:id/confirm", true, confirmCandidate],
  ] as const) {
    app.post(url, { schema: { params: idParams, body: winnerBody } }, async (req, reply) => {
      const result = await action(pool, idOf(req), (req.body as { winner: Winner }).winner);
      return fromForm ? reply.code(303).header("location", "/admin").send() : result;
    });
  }

  app.get("/admin", async (_req, reply) => {
    const [conflicts, candidates, attention, failed] = await Promise.all([
      openConflicts(pool),
      openCandidates(pool),
      needsAttention(pool),
      failedJobs(pool),
    ]);
    const candidateRows = candidates.flatMap((c) =>
      SYNCED_FIELDS.filter((f) => !isDeepStrictEqual(c.internal[f], c.qbo[f]))
        .map((f, i) => [
          i === 0 ? esc(c.docNumber) : "",
          esc(f),
          showValue(f, c.internal[f]),
          showValue(f, c.qbo[f]),
          i === 0
            ? `<form method="post" action="/admin/candidates/${c.id}/confirm">
                 <button name="winner" value="internal">Keep internal</button><button name="winner" value="qbo">Keep QBO</button>
               </form>`
            : "",
        ]),
    );
    const conflictRows = conflicts.flatMap((c) =>
      c.fields.map((f: any, i: number) => [
        i === 0 ? linkTo(c.linkId, c.docNumber) : "",
        esc(f.field),
        showValue(f.field, f.base),
        showValue(f.field, f.internal),
        showValue(f.field, f.qbo),
        i === 0
          ? `<form method="post" action="/admin/conflicts/${c.id}/resolve">
               <button name="winner" value="internal">Keep internal</button><button name="winner" value="qbo">Keep QBO</button>
             </form>`
          : "",
      ]),
    );
    const body = `<h1>Invoice sync</h1>
      <h2>Conflicts (${conflicts.length})</h2>
      ${table(["Invoice", "Field", "Base", "Internal", "QBO", "Resolve"], conflictRows)}
      <h2>Link Candidates (${candidates.length})</h2>
      ${table(["Invoice", "Field", "Internal", "QBO", "Confirm"], candidateRows)}
      <h2>Needs Attention (${attention.length})</h2>
      ${table(["Invoice", "Record", "Why", "When"], attention.map((a) => [linkTo(a.linkId, a.docNumber ?? "-"), esc(a.record), esc(a.summary), esc(a.at.toISOString())]))}
      <h2>Failed jobs (${failed.length})</h2>
      ${table(["Record", "Attempts", "Last error", "When"], failed.map((j) => [esc(j.record), esc(j.attempts), esc(j.error), esc(j.at.toISOString())]))}`;
    return reply.type("text/html").send(page("Invoice sync admin", body));
  });

  app.get("/admin/links/:id", { schema: { params: idParams } }, async (req, reply) => {
    const id = idOf(req);
    const { rows } = await pool.query("SELECT * FROM links WHERE id = $1", [id]);
    if (!rows[0]) throw httpError(404, "link not found");
    const link = rows[0];
    const history = await attempts(pool, id);
    const body = `<p><a href="/admin">&larr; Admin</a></p>
      <h1>Invoice ${esc(link.doc_number)}</h1>
      <p>State: <strong>${esc(link.state)}</strong> &middot; internal ${esc(link.internal_id)} &middot; QBO ${esc(link.qbo_id)}</p>
      <h2>Sync Attempts</h2>
      ${table(
        ["When", "Trigger", "Outcome", "Summary", "Writes", "Notes", "Error"],
        history.map((a) => [
          esc(a.at.toISOString()),
          esc(recordLabel(a.trigger.side, a.trigger.recordType, a.trigger.recordId)),
          esc(a.outcome),
          esc(a.summary),
          esc(a.writes.map((w: any) => `${w.action} ${w.side} ${w.entity} ${w.id}`).join("; ")),
          esc(a.notes.join("; ")),
          esc(a.error),
        ]),
      )}`;
    return reply.type("text/html").send(page(`Invoice ${link.doc_number}`, body));
  });
}
