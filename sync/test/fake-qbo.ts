import Fastify from "fastify";
import type { AddressInfo } from "node:net";

/**
 * In-memory stand-in for the subset of the QBO Accounting API the sync uses.
 * It is the integration seam: everything else in tests is real. Shapes follow
 * QBO's JSON (PascalCase entities, string Ids and SyncTokens, Fault errors).
 * Every create/update is also queued in `events`, the way QBO would send a webhook.
 */
export type QboEvent = { name: string; id: string; operation: "Create" | "Update"; lastUpdated: string };

export type FakeQbo = {
  url: string;
  realmId: string;
  customers: any[];
  items: any[];
  invoices: any[];
  events: QboEvent[];
  /** Every write request the sync made, for asserting "no writes". */
  writes: { method: string; path: string; body: any }[];
  addItem(name: string): string;
  addCustomer(displayName: string): string;
  /** An accountant creates an Invoice in the QBO UI. */
  accountantCreate(fields: object): any;
  /** An accountant edits an Invoice in the QBO UI (sparse fields, Line replaces all lines). */
  accountantEdit(id: string, fields: object): any;
  close(): Promise<void>;
};

class Fault extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export async function startFakeQbo(): Promise<FakeQbo> {
  const realmId = "9130000000000000";
  let nextId = 1;
  // Strictly increasing timestamps, so last-writer-wins is deterministic in tests.
  let clock = Date.now();
  const now = () => new Date((clock += 1000)).toISOString();
  const tables: Record<string, any[]> = { Customer: [], Item: [], Invoice: [] };
  const events: QboEvent[] = [];
  const writes: FakeQbo["writes"] = [];

  const emit = (name: string, id: string, operation: QboEvent["operation"], lastUpdated: string) =>
    events.push({ name, id, operation, lastUpdated });

  /** Applies QBO's server-side rules to an Invoice body: references, lines, totals. */
  function shapeInvoice(body: any, existing?: any) {
    const merged = { ...existing, ...body };
    if (merged.DocNumber && tables.Invoice.some((i) => i.DocNumber === merged.DocNumber && i.Id !== existing?.Id)) {
      throw new Fault("6140", "Duplicate Document Number Error");
    }
    const customer = tables.Customer.find((c) => c.Id === merged.CustomerRef?.value);
    if (!customer) throw new Fault("2500", "Invalid Reference Id: CustomerRef");
    const sales = (merged.Line ?? []).filter((l: any) => l.DetailType === "SalesItemLineDetail");
    for (const l of sales) {
      if (!tables.Item.some((i) => i.Id === l.SalesItemLineDetail?.ItemRef?.value)) {
        throw new Fault("2500", "Invalid Reference Id: ItemRef");
      }
    }
    const kept = (merged.Line ?? []).filter((l: any) => l.DetailType !== "SubTotalLineDetail");
    const lines = kept.map((l: any, i: number) => ({ ...l, Id: String(i + 1), LineNum: i + 1 }));
    const sign = (l: any) => (l.DetailType === "DiscountLineDetail" ? -1 : 1);
    const total = Math.round(lines.reduce((s: number, l: any) => s + sign(l) * l.Amount * 100, 0)) / 100;
    delete merged.sparse;
    return {
      ...merged,
      CustomerRef: { value: customer.Id, name: customer.DisplayName },
      // Real QBO appends a subtotal line; normalizers must skip it.
      Line: [...lines, { Amount: total, DetailType: "SubTotalLineDetail", SubTotalLineDetail: {} }],
      TotalAmt: total,
      Balance: total,
    };
  }

  function createInvoice(body: any) {
    const t = now();
    const invoice = { ...shapeInvoice(body), Id: String(nextId++), SyncToken: "0", MetaData: { CreateTime: t, LastUpdatedTime: t } };
    tables.Invoice.push(invoice);
    emit("Invoice", invoice.Id, "Create", t);
    return invoice;
  }

  function updateInvoice(id: string, body: any, checkSyncToken: boolean) {
    const idx = tables.Invoice.findIndex((i) => i.Id === id);
    if (idx < 0) throw new Fault("610", "Object Not Found");
    const existing = tables.Invoice[idx];
    if (checkSyncToken && body.SyncToken !== existing.SyncToken) {
      throw new Fault("5010", "Stale Object Error : You and another user were working on the same thing.");
    }
    const t = now();
    const updated = {
      ...shapeInvoice(body, existing),
      Id: existing.Id,
      SyncToken: String(Number(existing.SyncToken) + 1),
      MetaData: { ...existing.MetaData, LastUpdatedTime: t },
    };
    tables.Invoice[idx] = updated;
    emit("Invoice", id, "Update", t);
    return updated;
  }

  const app = Fastify();
  app.addHook("onRequest", async (req, reply) => {
    if (!req.headers.authorization?.startsWith("Bearer ")) {
      return reply.code(401).send({ fault: { error: [{ message: "AuthenticationFailed", code: "3200" }] } });
    }
  });
  app.addHook("preHandler", async (req) => {
    if (req.method !== "GET") writes.push({ method: req.method, path: req.url.split("?")[0], body: req.body });
  });
  app.setErrorHandler((err: Error, _req, reply) => {
    const code = err instanceof Fault ? err.code : "500";
    reply.code(err instanceof Fault ? 400 : 500).send({
      Fault: { Error: [{ Message: err.message, Detail: err.message, code }], type: "ValidationFault" },
    });
  });

  const base = `/v3/company/${realmId}`;

  app.get(`${base}/query`, async (req) => {
    const sql = (req.query as { query: string }).query;
    const m = /^select \* from (\w+)(?: where (\w+) = '((?:[^'\\]|\\.)*)')?\s*$/i.exec(sql.trim());
    if (!m || !tables[m[1]]) throw new Fault("4000", `unsupported query: ${sql}`);
    const [, entity, field, raw] = m;
    const value = raw?.replace(/\\(.)/g, "$1");
    const rows = tables[entity].filter((r) => !field || String(r[field]) === value);
    return { QueryResponse: rows.length ? { [entity]: rows } : {}, time: now() };
  });

  app.post(`${base}/customer`, async (req) => {
    const body = req.body as any;
    if (tables.Customer.some((c) => c.DisplayName === body.DisplayName)) throw new Fault("6240", "Duplicate Name Exists Error");
    const t = now();
    const customer = { ...body, Id: String(nextId++), SyncToken: "0", Active: true, MetaData: { CreateTime: t, LastUpdatedTime: t } };
    tables.Customer.push(customer);
    return { Customer: customer, time: t };
  });

  // QBO uses one endpoint for create and update: a body with Id is an update.
  app.post(`${base}/invoice`, async (req) => {
    const body = req.body as any;
    const invoice = body.Id ? updateInvoice(body.Id, body, true) : createInvoice(body);
    return { Invoice: invoice, time: now() };
  });

  app.get(`${base}/invoice/:id`, async (req) => {
    const invoice = tables.Invoice.find((i) => i.Id === (req.params as { id: string }).id);
    if (!invoice) throw new Fault("610", "Object Not Found");
    return { Invoice: invoice, time: now() };
  });

  await app.listen({ host: "127.0.0.1", port: 0 });
  const add = (entity: string, fields: object) => {
    const t = now();
    const row = { ...fields, Id: String(nextId++), SyncToken: "0", Active: true, MetaData: { CreateTime: t, LastUpdatedTime: t } };
    tables[entity].push(row);
    return row.Id;
  };

  return {
    url: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`,
    realmId,
    customers: tables.Customer,
    items: tables.Item,
    invoices: tables.Invoice,
    events,
    writes,
    addItem: (name) => add("Item", { Name: name, Type: "Service" }),
    addCustomer: (displayName) => add("Customer", { DisplayName: displayName }),
    accountantCreate: (fields) => createInvoice(fields),
    accountantEdit: (id, fields) => updateInvoice(id, fields, false),
    close: () => app.close(),
  };
}
