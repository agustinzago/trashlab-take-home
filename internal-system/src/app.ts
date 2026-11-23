import Fastify, { type FastifyInstance } from "fastify";
import type pg from "pg";
import { tx } from "../../shared/db.ts";
import { emit } from "./outbox.ts";

type Line = { description: string; amountCents: number; revenueCategory: string };
type InvoiceBody = {
  docNumber: string;
  customerId: number;
  txnDate: string;
  dueDate?: string | null;
  memo?: string | null;
  lines: Line[];
  status?: "draft" | "issued";
};

const date = { type: "string", format: "date" } as const;
const lineSchema = {
  type: "object",
  required: ["description", "amountCents", "revenueCategory"],
  additionalProperties: false,
  properties: {
    description: { type: "string" },
    amountCents: { type: "integer" },
    revenueCategory: { type: "string", minLength: 1 },
  },
} as const;
const idParams = { type: "object", properties: { id: { type: "integer" } } } as const;

function httpError(statusCode: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode });
}

const INVOICE_SELECT = `
  SELECT i.*, COALESCE(SUM(p.amount_cents) FILTER (WHERE p.status = 'active'), 0)::int AS paid_cents
  FROM invoices i LEFT JOIN payments p ON p.invoice_id = i.id`;

function invoiceJson(r: any) {
  const lines: Line[] = r.lines;
  // A Void keeps the lines for history but zeroes what is owed.
  const totalCents = r.status === "voided" ? 0 : lines.reduce((s, l) => s + l.amountCents, 0);
  const paidCents: number = r.paid_cents;
  return {
    id: r.id,
    docNumber: r.doc_number,
    customerId: r.customer_id,
    txnDate: r.txn_date,
    dueDate: r.due_date,
    memo: r.memo,
    lines,
    status: r.status,
    version: r.version,
    updatedAt: r.updated_at.toISOString(),
    totalCents,
    paidCents,
    balanceCents: totalCents - paidCents,
    paymentStatus: paidCents === 0 ? "unpaid" : paidCents >= totalCents ? "paid" : "partially_paid",
  };
}

function paymentJson(r: any) {
  return {
    id: r.id,
    ref: r.ref,
    invoiceId: r.invoice_id,
    amountCents: r.amount_cents,
    txnDate: r.txn_date,
    method: r.method,
    status: r.status,
    version: r.version,
    updatedAt: r.updated_at.toISOString(),
  };
}

function customerJson(r: any) {
  return { id: r.id, displayName: r.display_name, version: r.version, updatedAt: r.updated_at.toISOString() };
}

/**
 * Locks a record for a versioned change. Enforces If-Match: missing is 428,
 * a version other than the current one is 409 (nothing is changed).
 */
async function lockForChange(c: pg.PoolClient, table: "invoices" | "payments", id: number, ifMatch: unknown) {
  if (typeof ifMatch !== "string") throw httpError(428, "If-Match header is required");
  const digits = ifMatch.replace(/^W\//, "").replaceAll('"', "").trim();
  if (!/^\d+$/.test(digits)) throw httpError(400, "If-Match must be a version number");
  const expected = Number(digits);
  const { rows } = await c.query(`SELECT * FROM ${table} WHERE id = $1 FOR UPDATE`, [id]);
  if (!rows[0]) throw httpError(404, `${table.slice(0, -1)} not found`);
  if (rows[0].version !== expected) throw httpError(409, `version is ${rows[0].version}, not ${expected}`);
  return rows[0];
}

const INVOICE_COLUMNS: Record<string, string> = {
  docNumber: "doc_number",
  customerId: "customer_id",
  txnDate: "txn_date",
  dueDate: "due_date",
  memo: "memo",
  lines: "lines",
};

async function loadInvoice(db: pg.Pool | pg.PoolClient, id: number) {
  const { rows } = await db.query(`${INVOICE_SELECT} WHERE i.id = $1 GROUP BY i.id`, [id]);
  if (!rows[0]) throw httpError(404, "invoice not found");
  return invoiceJson(rows[0]);
}

/**
 * Runs a create in one transaction. With an Idempotency-Key, the first request
 * claims the key and stores its response; a repeat (even a concurrent one, which
 * blocks on the claim) replays that response instead of creating again.
 * ponytail: a reused key with a different body replays the first result; hash the body if that must be a 422.
 */
async function idempotentCreate(
  pool: pg.Pool,
  scope: string,
  key: unknown,
  create: (c: pg.PoolClient) => Promise<unknown>,
): Promise<unknown> {
  return tx(pool, async (c) => {
    if (typeof key === "string") {
      const claim = await c.query(
        "INSERT INTO idempotency_keys (scope, key) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [scope, key],
      );
      if (claim.rowCount === 0) {
        const { rows } = await c.query("SELECT body FROM idempotency_keys WHERE scope = $1 AND key = $2", [scope, key]);
        return rows[0].body;
      }
    }
    const body = await create(c);
    if (typeof key === "string") {
      await c.query("UPDATE idempotency_keys SET body = $3 WHERE scope = $1 AND key = $2", [
        scope,
        key,
        JSON.stringify(body),
      ]);
    }
    return body;
  });
}

export function buildApp(pool: pg.Pool): FastifyInstance {
  const app = Fastify();

  app.setErrorHandler((err: any, _req, reply) => {
    // unique_violation / foreign_key_violation: the request names a taken or unknown record.
    if (err.code === "23505" || err.code === "23503") return reply.code(422).send({ message: err.detail });
    throw err;
  });

  app.post<{ Body: { displayName: string } }>(
    "/customers",
    {
      schema: {
        body: {
          type: "object",
          required: ["displayName"],
          additionalProperties: false,
          properties: { displayName: { type: "string", minLength: 1 } },
        },
      },
    },
    async (req, reply) => {
      const body = await idempotentCreate(pool, "customers", req.headers["idempotency-key"], async (c) => {
        const { rows } = await c.query("INSERT INTO customers (display_name) VALUES ($1) RETURNING *", [
          req.body.displayName,
        ]);
        await emit(c, "customer", rows[0].id);
        return customerJson(rows[0]);
      });
      return reply.code(201).send(body);
    },
  );

  app.get<{ Params: { id: number } }>("/customers/:id", { schema: { params: idParams } }, async (req) => {
    const { rows } = await pool.query("SELECT * FROM customers WHERE id = $1", [req.params.id]);
    if (!rows[0]) throw httpError(404, "customer not found");
    return customerJson(rows[0]);
  });

  app.get<{ Querystring: { displayName?: string } }>("/customers", async (req) => {
    const { rows } = await pool.query(
      "SELECT * FROM customers WHERE $1::text IS NULL OR display_name = $1 ORDER BY id",
      [req.query.displayName ?? null],
    );
    return rows.map(customerJson);
  });

  app.post(
    "/invoices",
    {
      schema: {
        body: {
          type: "object",
          required: ["docNumber", "customerId", "txnDate", "lines"],
          additionalProperties: false,
          properties: {
            docNumber: { type: "string", minLength: 1 },
            customerId: { type: "integer" },
            txnDate: date,
            dueDate: { ...date, nullable: true },
            memo: { type: "string", nullable: true },
            lines: { type: "array", items: lineSchema },
            status: { type: "string", enum: ["draft", "issued"] },
          },
        },
      },
    },
    async (req, reply) => {
      const b = req.body as InvoiceBody;
      const body = await idempotentCreate(pool, "invoices", req.headers["idempotency-key"], async (c) => {
        const { rows } = await c.query(
          `INSERT INTO invoices (doc_number, customer_id, txn_date, due_date, memo, lines, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [b.docNumber, b.customerId, b.txnDate, b.dueDate ?? null, b.memo ?? null, JSON.stringify(b.lines), b.status ?? "draft"],
        );
        await emit(c, "invoice", rows[0].id);
        return loadInvoice(c, rows[0].id);
      });
      return reply.code(201).send(body);
    },
  );

  app.get<{ Params: { id: number } }>("/invoices/:id", { schema: { params: idParams } }, (req) =>
    loadInvoice(pool, req.params.id),
  );

  // ponytail: unpaginated list; add a cursor when backfill volumes need it.
  app.get<{ Querystring: { docNumber?: string } }>("/invoices", async (req) => {
    const { docNumber } = req.query;
    const { rows } = await pool.query(
      `${INVOICE_SELECT} WHERE $1::text IS NULL OR i.doc_number = $1 GROUP BY i.id ORDER BY i.id`,
      [docNumber ?? null],
    );
    return rows.map(invoiceJson);
  });

  app.patch(
    "/invoices/:id",
    {
      schema: {
        params: idParams,
        body: {
          type: "object",
          additionalProperties: false,
          minProperties: 1,
          properties: {
            docNumber: { type: "string", minLength: 1 },
            customerId: { type: "integer" },
            txnDate: date,
            dueDate: { ...date, nullable: true },
            memo: { type: "string", nullable: true },
            lines: { type: "array", items: lineSchema },
          },
        },
      },
    },
    async (req) => {
      const { id } = req.params as { id: number };
      const body = req.body as Partial<InvoiceBody>;
      return tx(pool, async (c) => {
        const row = await lockForChange(c, "invoices", id, req.headers["if-match"]);
        if (row.status === "voided") throw httpError(422, "a voided invoice cannot be updated");
        const entries = Object.entries(body);
        const sets = entries.map(([k], i) => `${INVOICE_COLUMNS[k]} = $${i + 2}`);
        const values = entries.map(([k, v]) => (k === "lines" ? JSON.stringify(v) : v));
        await c.query(
          `UPDATE invoices SET ${sets.join(", ")}, version = version + 1, updated_at = clock_timestamp() WHERE id = $1`,
          [id, ...values],
        );
        await emit(c, "invoice", id);
        return loadInvoice(c, id);
      });
    },
  );

  // Lifecycle transitions: draft -> issued -> voided.
  for (const [action, from, to] of [
    ["issue", "draft", "issued"],
    ["void", "issued", "voided"],
  ] as const) {
    app.post("/invoices/:id/" + action, { schema: { params: idParams } }, async (req) => {
      const { id } = req.params as { id: number };
      return tx(pool, async (c) => {
        const row = await lockForChange(c, "invoices", id, req.headers["if-match"]);
        if (row.status !== from) throw httpError(422, `only a ${from} invoice can ${action}, this one is ${row.status}`);
        await c.query("UPDATE invoices SET status = $2, version = version + 1, updated_at = clock_timestamp() WHERE id = $1", [id, to]);
        await emit(c, "invoice", id);
        return loadInvoice(c, id);
      });
    });
  }

  app.delete("/invoices/:id", { schema: { params: idParams } }, async (req, reply) => {
    const { id } = req.params as { id: number };
    await tx(pool, async (c) => {
      const row = await lockForChange(c, "invoices", id, req.headers["if-match"]);
      if (row.status !== "draft") throw httpError(422, "only a draft invoice can be deleted; void it instead");
      await c.query("DELETE FROM invoices WHERE id = $1", [id]);
      await emit(c, "invoice", id);
    });
    return reply.code(204).send();
  });

  app.post(
    "/payments",
    {
      schema: {
        body: {
          type: "object",
          required: ["invoiceId", "amountCents", "txnDate", "method"],
          additionalProperties: false,
          properties: {
            invoiceId: { type: "integer" },
            amountCents: { type: "integer", minimum: 1 },
            txnDate: date,
            method: { type: "string", minLength: 1 },
            ref: { type: "string", minLength: 1 },
          },
        },
      },
    },
    async (req, reply) => {
      const b = req.body as { invoiceId: number; amountCents: number; txnDate: string; method: string; ref?: string };
      const body = await idempotentCreate(pool, "payments", req.headers["idempotency-key"], async (c) => {
        // FOR SHARE: a concurrent void of the Invoice waits for this Payment, or this waits for the void.
        const inv = await c.query("SELECT status FROM invoices WHERE id = $1 FOR SHARE", [b.invoiceId]);
        if (!inv.rows[0]) throw httpError(422, "invoice not found");
        if (inv.rows[0].status !== "issued") throw httpError(422, `cannot pay a ${inv.rows[0].status} invoice`);
        const { rows } = await c.query(
          `WITH n AS (SELECT nextval('payments_id_seq')::int AS id)
           INSERT INTO payments (id, ref, invoice_id, amount_cents, txn_date, method)
           SELECT id, COALESCE($1, 'PAY-' || id), $2, $3, $4, $5 FROM n RETURNING *`,
          [b.ref ?? null, b.invoiceId, b.amountCents, b.txnDate, b.method],
        );
        await emit(c, "payment", rows[0].id);
        return paymentJson(rows[0]);
      });
      return reply.code(201).send(body);
    },
  );

  app.get<{ Params: { id: number } }>("/payments/:id", { schema: { params: idParams } }, async (req) => {
    const { rows } = await pool.query("SELECT * FROM payments WHERE id = $1", [req.params.id]);
    if (!rows[0]) throw httpError(404, "payment not found");
    return paymentJson(rows[0]);
  });

  app.get<{ Querystring: { invoiceId?: string; ref?: string } }>("/payments", async (req) => {
    const { rows } = await pool.query(
      `SELECT * FROM payments WHERE ($1::int IS NULL OR invoice_id = $1) AND ($2::text IS NULL OR ref = $2) ORDER BY id`,
      [req.query.invoiceId ?? null, req.query.ref ?? null],
    );
    return rows.map(paymentJson);
  });

  app.post("/payments/:id/void", { schema: { params: idParams } }, async (req) => {
    const { id } = req.params as { id: number };
    return tx(pool, async (c) => {
      const row = await lockForChange(c, "payments", id, req.headers["if-match"]);
      if (row.status === "voided") throw httpError(422, "payment is already voided");
      const { rows } = await c.query(
        "UPDATE payments SET status = 'voided', version = version + 1, updated_at = clock_timestamp() WHERE id = $1 RETURNING *",
        [id],
      );
      await emit(c, "payment", id);
      return paymentJson(rows[0]);
    });
  });

  return app;
}
