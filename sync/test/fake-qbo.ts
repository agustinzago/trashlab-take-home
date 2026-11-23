import Fastify from "fastify";
import type { AddressInfo } from "node:net";

/**
 * In-memory stand-in for the subset of the QBO Accounting API the sync uses.
 * It is the integration seam: everything else in tests is real. Shapes follow
 * QBO's JSON (PascalCase entities, string Ids and SyncTokens, Fault errors).
 * Every create/update is also queued in `events`, the way QBO would send a webhook.
 */
export type QboEvent = { name: string; id: string; operation: "Create" | "Update" | "Void" | "Delete"; lastUpdated: string };

/**
 * Faults to inject into matching requests. A "timeout" drops the connection, so the
 * client cannot tell whether the write happened: before commit nothing was applied,
 * after commit it was.
 */
export type FaultKind = "timeoutBeforeCommit" | "timeoutAfterCommit" | 500 | 429;
type InjectedFault = { kind: FaultKind; times: number; method: string; path: RegExp };

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
  /** An accountant voids an Invoice in QBO: kept, zeroed, noted "Voided". */
  accountantVoid(id: string): any;
  /** An accountant hard-deletes an Invoice in QBO. */
  accountantDelete(id: string): void;
  /** Fails the next `times` requests matching method and path (default: any POST). */
  injectFault(kind: FaultKind, opts?: { times?: number; method?: string; path?: RegExp }): void;
  /** Runs `fn` just before the next write is applied, e.g. a concurrent accountant edit. */
  beforeNextWrite(fn: () => void): void;
  /** Whether a repeated `requestid` replays the first response (QBO's window is short and not guaranteed). */
  requestIdDedupe: boolean;
  /** While true every request is rejected as unauthorized, like an expired connection. */
  authExpired: boolean;
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

  const faults: InjectedFault[] = [];
  const beforeWrite: (() => void)[] = [];
  const replies = new Map<string, { statusCode: number; payload: string }>();
  const control = { requestIdDedupe: true, authExpired: false };

  /** QBO's void: the record stays, its amounts are zeroed and PrivateNote says "Voided" (to confirm in the spike). */
  function voidInvoice(id: string, syncToken: string | null) {
    const idx = tables.Invoice.findIndex((i) => i.Id === id);
    if (idx < 0) throw new Fault("610", "Object Not Found");
    const existing = tables.Invoice[idx];
    if (syncToken !== null && syncToken !== existing.SyncToken) throw new Fault("5010", "Stale Object Error");
    const t = now();
    const voided = {
      ...existing,
      Line: existing.Line.map((l: any) => ({ ...l, Amount: 0 })),
      TotalAmt: 0,
      Balance: 0,
      PrivateNote: `Voided${existing.PrivateNote ? ` ${existing.PrivateNote}` : ""}`,
      SyncToken: String(Number(existing.SyncToken) + 1),
      MetaData: { ...existing.MetaData, LastUpdatedTime: t },
    };
    tables.Invoice[idx] = voided;
    emit("Invoice", id, "Void", t);
    return voided;
  }

  function deleteInvoice(id: string) {
    const idx = tables.Invoice.findIndex((i) => i.Id === id);
    if (idx < 0) throw new Fault("610", "Object Not Found");
    tables.Invoice.splice(idx, 1);
    emit("Invoice", id, "Delete", now());
  }

  const app = Fastify({ logger: false });
  app.addHook("onRequest", async (req, reply) => {
    if (control.authExpired || !req.headers.authorization?.startsWith("Bearer ")) {
      return reply.code(401).send({ fault: { error: [{ message: "AuthenticationFailed", detail: "Token expired", code: "3200" }] } });
    }
    const path = req.url.split("?")[0];
    const fault = faults.find((f) => f.method === req.method && f.path.test(path));
    if (!fault) return;
    if (--fault.times <= 0) faults.splice(faults.indexOf(fault), 1);
    if (fault.kind === "timeoutBeforeCommit") {
      req.raw.socket.destroy();
      return reply.hijack();
    }
    if (fault.kind === "timeoutAfterCommit") {
      (req as any).dropAfterCommit = true;
      return;
    }
    const message = fault.kind === 429 ? "ThrottleExceeded" : "An application error has occurred";
    return reply.code(fault.kind).send({ Fault: { Error: [{ Message: message, code: fault.kind === 429 ? "003001" : "10000" }] } });
  });
  app.addHook("preHandler", async (req, reply) => {
    if (req.method === "GET") return;
    writes.push({ method: req.method, path: req.url.split("?")[0], body: req.body });
    const requestId = (req.query as { requestid?: string }).requestid;
    const seen = requestId && replies.get(requestId);
    if (seen && control.requestIdDedupe) {
      (req as any).replayed = true;
      return reply.code(seen.statusCode).type("application/json").send(seen.payload);
    }
    beforeWrite.splice(0).forEach((fn) => fn());
  });
  app.addHook("onSend", async (req, reply, payload) => {
    const requestId = (req.query as { requestid?: string }).requestid;
    // ponytail: replays successful writes only; confirm in the sandbox spike whether QBO also replays errors.
    if (requestId && !(req as any).replayed && reply.statusCode < 300) {
      replies.set(requestId, { statusCode: reply.statusCode, payload: payload as string });
    }
    // The write is committed; now lose the response.
    if ((req as any).dropAfterCommit) req.raw.socket.destroy();
    return payload;
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
    const operation = (req.query as { operation?: string }).operation;
    if (operation === "void") return { Invoice: voidInvoice(body.Id, body.SyncToken), time: now() };
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
    injectFault: (kind, opts = {}) =>
      faults.push({ kind, times: opts.times ?? 1, method: opts.method ?? "POST", path: opts.path ?? /./ }),
    beforeNextWrite: (fn) => beforeWrite.push(fn),
    get requestIdDedupe() {
      return control.requestIdDedupe;
    },
    set requestIdDedupe(v) {
      control.requestIdDedupe = v;
    },
    get authExpired() {
      return control.authExpired;
    },
    set authExpired(v) {
      control.authExpired = v;
    },
    accountantCreate: (fields) => createInvoice(fields),
    accountantEdit: (id, fields) => updateInvoice(id, fields, false),
    accountantVoid: (id) => voidInvoice(id, null),
    accountantDelete: (id) => deleteInvoice(id),
    close: () => app.close(),
  };
}
