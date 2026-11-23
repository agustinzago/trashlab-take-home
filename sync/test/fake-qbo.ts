import Fastify from "fastify";
import type { AddressInfo } from "node:net";

/**
 * In-memory stand-in for the subset of the QBO Accounting API the sync uses.
 * It is the integration seam: everything else in tests is real. Shapes follow
 * QBO's JSON (PascalCase entities, string Ids and SyncTokens, Fault errors).
 */
export type FakeQbo = {
  url: string;
  realmId: string;
  customers: any[];
  items: any[];
  invoices: any[];
  addItem(name: string): string;
  addCustomer(displayName: string): string;
  close(): Promise<void>;
};

const fault = (code: string, message: string) => ({
  Fault: { Error: [{ Message: message, Detail: message, code }], type: "ValidationFault" },
});

export async function startFakeQbo(): Promise<FakeQbo> {
  const realmId = "9130000000000000";
  let nextId = 1;
  const now = () => new Date().toISOString();
  const meta = () => ({ CreateTime: now(), LastUpdatedTime: now() });
  const tables: Record<string, any[]> = { Customer: [], Item: [], Invoice: [] };

  const app = Fastify();
  app.addHook("onRequest", async (req, reply) => {
    if (!req.headers.authorization?.startsWith("Bearer ")) {
      return reply.code(401).send({ fault: { error: [{ message: "AuthenticationFailed", code: "3200" }] } });
    }
  });

  const base = `/v3/company/${realmId}`;

  app.get(`${base}/query`, async (req, reply) => {
    const sql = (req.query as { query: string }).query;
    const m = /^select \* from (\w+)(?: where (\w+) = '((?:[^'\\]|\\.)*)')?\s*$/i.exec(sql.trim());
    if (!m || !tables[m[1]]) return reply.code(400).send(fault("4000", `unsupported query: ${sql}`));
    const [, entity, field, raw] = m;
    const value = raw?.replace(/\\(.)/g, "$1");
    const rows = tables[entity].filter((r) => !field || String(r[field]) === value);
    return { QueryResponse: rows.length ? { [entity]: rows } : {}, time: now() };
  });

  app.post(`${base}/customer`, async (req, reply) => {
    const body = req.body as any;
    if (tables.Customer.some((c) => c.DisplayName === body.DisplayName)) {
      return reply.code(400).send(fault("6240", "Duplicate Name Exists Error"));
    }
    const customer = { ...body, Id: String(nextId++), SyncToken: "0", Active: true, MetaData: meta() };
    tables.Customer.push(customer);
    return { Customer: customer, time: now() };
  });

  app.post(`${base}/invoice`, async (req, reply) => {
    const body = req.body as any;
    if (body.DocNumber && tables.Invoice.some((i) => i.DocNumber === body.DocNumber)) {
      return reply.code(400).send(fault("6140", "Duplicate Document Number Error"));
    }
    const customer = tables.Customer.find((c) => c.Id === body.CustomerRef?.value);
    if (!customer) return reply.code(400).send(fault("2500", "Invalid Reference Id: CustomerRef"));
    for (const l of body.Line ?? []) {
      if (!tables.Item.some((i) => i.Id === l.SalesItemLineDetail?.ItemRef?.value)) {
        return reply.code(400).send(fault("2500", "Invalid Reference Id: ItemRef"));
      }
    }
    const lines = (body.Line ?? []).map((l: any, i: number) => ({ ...l, Id: String(i + 1), LineNum: i + 1 }));
    const total = Math.round(lines.reduce((s: number, l: any) => s + l.Amount * 100, 0)) / 100;
    const invoice = {
      ...body,
      Id: String(nextId++),
      SyncToken: "0",
      CustomerRef: { value: customer.Id, name: customer.DisplayName },
      // Real QBO appends a subtotal line; normalizers must skip it.
      Line: [...lines, { Amount: total, DetailType: "SubTotalLineDetail", SubTotalLineDetail: {} }],
      TotalAmt: total,
      Balance: total,
      MetaData: meta(),
    };
    tables.Invoice.push(invoice);
    return { Invoice: invoice, time: now() };
  });

  app.get(`${base}/invoice/:id`, async (req, reply) => {
    const invoice = tables.Invoice.find((i) => i.Id === (req.params as { id: string }).id);
    if (!invoice) return reply.code(400).send(fault("610", "Object Not Found"));
    return { Invoice: invoice, time: now() };
  });

  await app.listen({ host: "127.0.0.1", port: 0 });
  const add = (entity: string, fields: object) => {
    const row = { ...fields, Id: String(nextId++), SyncToken: "0", Active: true, MetaData: meta() };
    tables[entity].push(row);
    return row.Id;
  };

  return {
    url: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`,
    realmId,
    customers: tables.Customer,
    items: tables.Item,
    invoices: tables.Invoice,
    addItem: (name) => add("Item", { Name: name, Type: "Service" }),
    addCustomer: (displayName) => add("Customer", { DisplayName: displayName }),
    close: () => app.close(),
  };
}
