export type InternalLine = { description: string; amountCents: number; revenueCategory: string };
export type InternalInvoice = {
  id: number;
  docNumber: string;
  customerId: number;
  txnDate: string;
  dueDate: string | null;
  memo: string | null;
  lines: InternalLine[];
  status: "draft" | "issued" | "voided";
  version: number;
  updatedAt: string;
};
export type InternalCustomer = { id: number; displayName: string };

/** HTTP client for the Internal System. Returns null for a record that does not exist. */
export function createInternalClient(baseUrl: string) {
  async function get<T>(path: string): Promise<T | null> {
    const res = await fetch(baseUrl + path, { signal: AbortSignal.timeout(10_000) });
    if (res.status === 404) return null;
    if (!res.ok) throw Object.assign(new Error(`Internal System GET ${path} -> ${res.status} ${await res.text()}`), { status: res.status });
    return res.json() as Promise<T>;
  }
  async function send<T>(method: string, path: string, body: object, headers: Record<string, string>): Promise<T> {
    const res = await fetch(baseUrl + path, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw Object.assign(new Error(`Internal System ${method} ${path} -> ${res.status} ${await res.text()}`), { status: res.status });
    return res.json() as Promise<T>;
  }
  const q = encodeURIComponent;
  return {
    getInvoice: (id: string | number) => get<InternalInvoice>(`/invoices/${id}`),
    findInvoices: async (docNumber: string) => (await get<InternalInvoice[]>(`/invoices?docNumber=${q(docNumber)}`))!,
    createInvoice: (body: object, idempotencyKey: string) =>
      send<InternalInvoice>("POST", "/invoices", body, { "idempotency-key": idempotencyKey }),
    /** Carries the version we read; a concurrent edit makes this fail with 409 instead of overwriting it. */
    updateInvoice: (id: number, version: number, patch: object) =>
      send<InternalInvoice>("PATCH", `/invoices/${id}`, patch, { "if-match": String(version) }),
    getCustomer: (id: string | number) => get<InternalCustomer>(`/customers/${id}`),
    findCustomers: async (displayName: string) => (await get<InternalCustomer[]>(`/customers?displayName=${q(displayName)}`))!,
    createCustomer: (displayName: string, idempotencyKey: string) =>
      send<InternalCustomer>("POST", "/customers", { displayName }, { "idempotency-key": idempotencyKey }),
  };
}

export type InternalClient = ReturnType<typeof createInternalClient>;
