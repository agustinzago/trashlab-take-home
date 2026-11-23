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
    if (!res.ok) throw new Error(`Internal System GET ${path} -> ${res.status} ${await res.text()}`);
    return res.json() as Promise<T>;
  }
  return {
    getInvoice: (id: string | number) => get<InternalInvoice>(`/invoices/${id}`),
    getCustomer: (id: string | number) => get<InternalCustomer>(`/customers/${id}`),
  };
}

export type InternalClient = ReturnType<typeof createInternalClient>;
