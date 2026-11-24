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
  payments: any[];
  /** The changedSince of every CDC request, in order. */
  cdcRequests: string[];
  undepositedFundsId: string;
  addAccount(name: string): string;
  /** An accountant receives a Payment in QBO: `applied` maps Invoice Id to amount. */
  accountantPay(fields: { customerId: string; applied: Record<string, number>; txnDate?: string; ref?: string }): any;
  accountantEditPayment(id: string, fields: object): any;
  accountantVoidPayment(id: string): any;
  /** Fails the next `times` requests matching method and path (default: any POST). */
  injectFault(kind: FaultKind, opts?: { times?: number; method?: string; path?: RegExp }): void;
  /** Runs `fn` just before the next write is applied, e.g. a concurrent accountant edit. */
  beforeNextWrite(fn: () => void): void;
  /** Whether a repeated `requestid` replays the first response (QBO's window is short and not guaranteed). */
  requestIdDedupe: boolean;
  /** While true every request is rejected as unauthorized, like an expired connection. */
  authExpired: boolean;
  /** QBO's "Custom transaction numbers" preference (DocNumber settable). */
  customTxnNumbers: boolean;
  /** When true, only the latest access token issued by the fake OAuth endpoint is accepted. */
  strictTokens: boolean;
  /** OAuth: the client credentials the token endpoint accepts, and the requests it received. */
  oauthClient: { id: string; secret: string };
  tokenRequests: Record<string, string>[];
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
  const tables: Record<string, any[]> = { Customer: [], Item: [], Invoice: [], Payment: [], Account: [] };
  const undepositedFunds = { Id: "4", Name: "Undeposited Funds", AccountType: "Other Current Asset", AccountSubType: "UndepositedFunds" };
  tables.Account.push(undepositedFunds);
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
    refreshInvoice(id);
    emit("Invoice", id, "Update", t);
    return tables.Invoice[idx];
  }

  const faults: InjectedFault[] = [];
  const beforeWrite: (() => void)[] = [];
  const replies = new Map<string, { statusCode: number; payload: string }>();
  const control = { requestIdDedupe: true, authExpired: false, customTxnNumbers: true, strictTokens: false };
  // Intuit's OAuth 2 token endpoint, modelled: authorization codes and refresh tokens are single-use, and a refresh rotates both tokens.
  const oauthClient = { id: "fake-client-id", secret: "fake-client-secret" };
  const tokenRequests: Record<string, string>[] = [];
  let tokenSeq = 0;
  let currentAccess: string | null = null;
  let currentRefresh: string | null = null;
  const issuedCodes = new Set(["good-code"]);

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

  // Hard deletes leave a tombstone that change-data-capture reports with status "Deleted".
  const tombstones: { entity: string; Id: string; LastUpdatedTime: string }[] = [];
  const cdcRequests: string[] = [];

  function deleteInvoice(id: string) {
    const idx = tables.Invoice.findIndex((i) => i.Id === id);
    if (idx < 0) throw new Fault("610", "Object Not Found");
    tables.Invoice.splice(idx, 1);
    const t = now();
    tombstones.push({ entity: "Invoice", Id: id, LastUpdatedTime: t });
    emit("Invoice", id, "Delete", t);
  }

  // --- Payments: each Line applies an amount to one Invoice through LinkedTxn ---------

  const appliedTo = (p: any) => p.Line.flatMap((l: any) => (l.LinkedTxn ?? []).filter((t: any) => t.TxnType === "Invoice").map((t: any) => t.TxnId));

  /** QBO derives an Invoice's Balance and its LinkedTxn list from the Payments applied to it. */
  function refreshInvoice(invoiceId: string) {
    const inv = tables.Invoice.find((i) => i.Id === invoiceId);
    if (!inv || String(inv.PrivateNote ?? "").startsWith("Voided")) return;
    const payments = tables.Payment.filter((p) => appliedTo(p).includes(invoiceId));
    const paid = payments.reduce(
      (s, p) => s + p.Line.filter((l: any) => l.LinkedTxn?.some((t: any) => t.TxnId === invoiceId)).reduce((a: number, l: any) => a + l.Amount * 100, 0),
      0,
    );
    inv.Balance = Math.round(inv.TotalAmt * 100 - paid) / 100;
    inv.LinkedTxn = payments.filter((p) => p.TotalAmt !== 0).map((p) => ({ TxnId: p.Id, TxnType: "Payment" }));
  }

  function shapePayment(body: any) {
    const customer = tables.Customer.find((c) => c.Id === body.CustomerRef?.value);
    if (!customer) throw new Fault("2500", "Invalid Reference Id: CustomerRef");
    for (const id of appliedTo(body)) {
      const inv = tables.Invoice.find((i) => i.Id === id);
      if (!inv) throw new Fault("2500", "Invalid Reference Id: LinkedTxn");
      if (inv.CustomerRef.value !== customer.Id) throw new Fault("6000", "The payment and the invoice must be for the same customer");
    }
    const deposit = body.DepositToAccountRef?.value ?? undepositedFunds.Id;
    if (!tables.Account.some((a) => a.Id === deposit)) throw new Fault("2500", "Invalid Reference Id: DepositToAccountRef");
    return { ...body, CustomerRef: { value: customer.Id, name: customer.DisplayName }, DepositToAccountRef: { value: deposit } };
  }

  function createPayment(body: any) {
    const t = now();
    const payment = { ...shapePayment(body), Id: String(nextId++), SyncToken: "0", MetaData: { CreateTime: t, LastUpdatedTime: t } };
    tables.Payment.push(payment);
    appliedTo(payment).forEach(refreshInvoice);
    emit("Payment", payment.Id, "Create", t);
    return payment;
  }

  function changePayment(id: string, change: (p: any) => any, operation: QboEvent["operation"], syncToken: string | null) {
    const idx = tables.Payment.findIndex((p) => p.Id === id);
    if (idx < 0) throw new Fault("610", "Object Not Found");
    const existing = tables.Payment[idx];
    if (syncToken !== null && syncToken !== existing.SyncToken) throw new Fault("5010", "Stale Object Error");
    const t = now();
    tables.Payment[idx] = {
      ...change(existing),
      Id: id,
      SyncToken: String(Number(existing.SyncToken) + 1),
      MetaData: { ...existing.MetaData, LastUpdatedTime: t },
    };
    new Set([...appliedTo(existing), ...appliedTo(tables.Payment[idx])]).forEach((i) => refreshInvoice(i as string));
    emit("Payment", id, operation, t);
    return tables.Payment[idx];
  }

  const voidPayment = (id: string, syncToken: string | null) =>
    changePayment(
      id,
      (p) => ({ ...p, TotalAmt: 0, Line: p.Line.map((l: any) => ({ ...l, Amount: 0 })), PrivateNote: `Voided${p.PrivateNote ? ` ${p.PrivateNote}` : ""}` }),
      "Void",
      syncToken,
    );

  const app = Fastify({ logger: false });
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) =>
    done(null, Object.fromEntries(new URLSearchParams(body as string))),
  );
  app.addHook("onRequest", async (req, reply) => {
    const path = req.url.split("?")[0];
    const fault = faults.find((f) => f.method === req.method && f.path.test(path));
    if (fault) {
      if (--fault.times <= 0) faults.splice(faults.indexOf(fault), 1);
      if (fault.kind === "timeoutBeforeCommit") {
        req.raw.socket.destroy();
        return reply.hijack();
      }
      if (fault.kind === "timeoutAfterCommit") {
        (req as any).dropAfterCommit = true;
      } else {
        const message = fault.kind === 429 ? "ThrottleExceeded" : "An application error has occurred";
        return reply.code(fault.kind).send({ Fault: { Error: [{ Message: message, code: fault.kind === 429 ? "003001" : "10000" }] } });
      }
    }
    if (path.startsWith("/oauth2/")) return; // the token endpoint authenticates the client with Basic auth
    const bearer = req.headers.authorization?.replace(/^Bearer /, "");
    if (control.authExpired || !req.headers.authorization?.startsWith("Bearer ") || (control.strictTokens && bearer !== currentAccess)) {
      return reply.code(401).send({ fault: { error: [{ message: "AuthenticationFailed", detail: "Token expired", code: "3200" }] } });
    }
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

  app.post("/oauth2/v1/tokens/bearer", async (req, reply) => {
    const body = req.body as Record<string, string>;
    tokenRequests.push(body);
    const expected = "Basic " + Buffer.from(`${oauthClient.id}:${oauthClient.secret}`).toString("base64");
    if (req.headers.authorization !== expected) return reply.code(401).send({ error: "invalid_client" });
    if (body.grant_type === "authorization_code") {
      if (!issuedCodes.delete(body.code)) return reply.code(400).send({ error: "invalid_grant" });
    } else if (body.grant_type === "refresh_token") {
      if (!currentRefresh || body.refresh_token !== currentRefresh) return reply.code(400).send({ error: "invalid_grant" });
    } else {
      return reply.code(400).send({ error: "unsupported_grant_type" });
    }
    tokenSeq++;
    currentAccess = `access-${tokenSeq}`;
    currentRefresh = `refresh-${tokenSeq}`;
    return { access_token: currentAccess, refresh_token: currentRefresh, token_type: "bearer", expires_in: 3600, x_refresh_token_expires_in: 8726400 };
  });

  const base = `/v3/company/${realmId}`;

  app.get(`${base}/preferences`, async () => ({
    Preferences: { SalesFormsPrefs: { CustomTxnNumbers: control.customTxnNumbers } },
    time: now(),
  }));

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

  // Change data capture: every entity of the listed types changed at or after changedSince, deletes included.
  app.get(`${base}/cdc`, async (req) => {
    const { entities, changedSince } = req.query as { entities: string; changedSince: string };
    const since = Date.parse(changedSince);
    if (Number.isNaN(since)) throw new Fault("4000", "changedSince is required");
    cdcRequests.push(changedSince);
    const time = now();
    const QueryResponse = entities.split(",").map((entity) => ({
      [entity]: [
        ...(tables[entity] ?? []).filter((r) => Date.parse(r.MetaData.LastUpdatedTime) >= since),
        ...tombstones
          .filter((d) => d.entity === entity && Date.parse(d.LastUpdatedTime) >= since)
          .map((d) => ({ domain: "QBO", status: "Deleted", Id: d.Id, MetaData: { LastUpdatedTime: d.LastUpdatedTime } })),
      ],
    }));
    return { CDCResponse: [{ QueryResponse }], time };
  });

  app.post(`${base}/payment`, async (req) => {
    const body = req.body as any;
    const operation = (req.query as { operation?: string }).operation;
    if (operation === "void") return { Payment: voidPayment(body.Id, body.SyncToken), time: now() };
    if (body.Id) throw new Fault("4000", "the fake does not model Payment updates by the sync");
    return { Payment: createPayment(body), time: now() };
  });

  app.get(`${base}/payment/:id`, async (req) => {
    const payment = tables.Payment.find((p) => p.Id === (req.params as { id: string }).id);
    if (!payment) throw new Fault("610", "Object Not Found");
    return { Payment: payment, time: now() };
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
    get customTxnNumbers() {
      return control.customTxnNumbers;
    },
    set customTxnNumbers(v) {
      control.customTxnNumbers = v;
    },
    get strictTokens() {
      return control.strictTokens;
    },
    set strictTokens(v) {
      control.strictTokens = v;
    },
    oauthClient,
    tokenRequests,
    get authExpired() {
      return control.authExpired;
    },
    set authExpired(v) {
      control.authExpired = v;
    },
    accountantCreate: (fields) => createInvoice(fields),
    accountantEdit: (id, fields) => updateInvoice(id, fields, false),
    accountantVoid: (id) => voidInvoice(id, null),
    payments: tables.Payment,
    cdcRequests,
    undepositedFundsId: undepositedFunds.Id,
    addAccount: (name) => add("Account", { Name: name, AccountType: "Bank" }),
    accountantPay: ({ customerId, applied, txnDate, ref }) =>
      createPayment({
        CustomerRef: { value: customerId },
        TxnDate: txnDate ?? "2026-11-10",
        PaymentRefNum: ref,
        TotalAmt: Object.values(applied).reduce((a, b) => a + b, 0),
        Line: Object.entries(applied).map(([invoiceId, amount]) => ({ Amount: amount, LinkedTxn: [{ TxnId: invoiceId, TxnType: "Invoice" }] })),
      }),
    accountantEditPayment: (id, fields) => changePayment(id, (p) => ({ ...p, ...fields }), "Update", null),
    accountantVoidPayment: (id) => voidPayment(id, null),
    accountantDelete: (id) => deleteInvoice(id),
    close: () => app.close(),
  };
}
