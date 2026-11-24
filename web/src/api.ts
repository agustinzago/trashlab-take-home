import { queryOptions } from "@tanstack/react-query";

// --- Types: the Internal System and the sync service's admin API, as they send them ---

export type Line = { description: string; amountCents: number; revenueCategory: string };
export type InvoiceStatus = "draft" | "issued" | "voided";
export type PaymentStatus = "unpaid" | "partially_paid" | "paid";

export type Invoice = {
  id: number;
  docNumber: string;
  customerId: number;
  txnDate: string;
  dueDate: string | null;
  memo: string | null;
  lines: Line[];
  status: InvoiceStatus;
  version: number;
  updatedAt: string;
  totalCents: number;
  paidCents: number;
  balanceCents: number;
  paymentStatus: PaymentStatus;
};

export type InvoiceInput = {
  docNumber: string;
  customerId: number;
  txnDate: string;
  dueDate: string | null;
  memo: string | null;
  lines: Line[];
};

export type Payment = {
  id: number;
  ref: string;
  invoiceId: number;
  amountCents: number;
  txnDate: string;
  method: string;
  status: "active" | "voided";
  version: number;
  updatedAt: string;
};

export type Customer = { id: number; displayName: string; version: number; updatedAt: string };

export type Side = "internal" | "qbo";
export type LinkState = "pending" | "linked" | "paused" | "attention" | "closed";
export type Link = { id: number; internalId: string | null; qboId: string | null; docNumber: string; state: LinkState; updatedAt: string };

export type Status = {
  qbo: { connected: false } | { connected: true; realmId: string; connectedAt: string; refreshedAt: string | null; refreshExpiresAt: string };
  jobs: { pending: number; running: number; failed: number };
  cdcCursor: string | null;
};

/** The fields the sync compares, in the shape both Sides share. */
export type SyncedFields = { docNumber: string; customer: string; txnDate: string; dueDate: string | null; memo: string | null; lines: Line[] };
export type FieldName = "customer" | "txnDate" | "lines" | "dueDate" | "memo";
export const SYNCED_FIELDS: FieldName[] = ["customer", "txnDate", "lines", "dueDate", "memo"];

export type Conflict = {
  id: number;
  linkId: number;
  docNumber: string;
  fields: { field: FieldName; base: unknown; internal: unknown; qbo: unknown }[];
  raisedAt: string;
};
export type Candidate = { id: number; docNumber: string; internalId: string; qboId: string; internal: SyncedFields; qbo: SyncedFields; raisedAt: string };
export type AttentionItem = { attemptId: number; linkId: number | null; docNumber: string | null; record: string; summary: string; at: string };
export type FailedJob = { id: number; record: string; attempts: number; error: string | null; at: string };
export type Attempt = {
  id: number;
  trigger: { side: Side; recordType: string; recordId: string };
  outcome: "synced" | "skipped" | "attention" | "candidate" | "conflict" | "paused" | "failed";
  summary: string;
  writes: { side: Side; action: string; entity: string; id: string; fields?: string[] }[];
  error: string | null;
  notes: string[];
  at: string;
};

// --- Session: the sync admin password, sent as HTTP Basic on every call ---

const KEY = "ledgerline.credential";
const read = () => {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
};
// ponytail: the Basic credential lives in sessionStorage (gone when the tab closes); swap for a session cookie
// once the sync service has real user accounts.
let credential = read();
const listeners = new Set<() => void>();

export const session = {
  signedIn: () => credential !== null,
  signIn(password: string) {
    credential = "Basic " + btoa(`admin:${password}`);
    try {
      sessionStorage.setItem(KEY, credential);
    } catch {
      /* private mode: this tab still works */
    }
  },
  signOut() {
    credential = null;
    try {
      sessionStorage.removeItem(KEY);
    } catch {
      /* nothing stored */
    }
    listeners.forEach((fn) => fn());
  },
  /** Called when a request comes back 401, so the app can return to the sign-in screen. */
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => void listeners.delete(fn);
  },
};

// --- Transport ---

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
  /** Someone else changed the record since it was read (If-Match mismatch). */
  get isStale() {
    return this.status === 409;
  }
}

/** A fresh Idempotency-Key. randomUUID needs a secure context, which a plain-HTTP LAN address is not. */
export function newIdempotencyKey(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
}

type Options = { method?: string; body?: unknown; version?: number; idempotencyKey?: string; signal?: AbortSignal };

async function request<T>(url: string, { method = "GET", body, version, idempotencyKey, signal }: Options = {}): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (credential) headers.authorization = credential;
  if (body !== undefined) headers["content-type"] = "application/json";
  if (version !== undefined) headers["if-match"] = String(version);
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;

  let res: Response;
  try {
    res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    throw new ApiError(0, "Can't reach the server. Check your connection and try again.");
  }
  if (res.status === 401) {
    session.signOut();
    throw new ApiError(401, "Your session has ended. Sign in again.");
  }
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, messageFor(res.status, data?.message));
  return data as T;
}

function messageFor(status: number, message: string | undefined): string {
  if (status === 409 && message?.startsWith("version is")) return "This record was changed by someone else (or by the sync) since you opened it.";
  if (status >= 500) return "The server had a problem. Try again in a moment.";
  if (!message) return `Request failed (${status}).`;
  return message.charAt(0).toUpperCase() + message.slice(1);
}

const internal = (path: string, o?: Options) => request<any>(`/api/internal${path}`, o);
const admin = (path: string, o?: Options) => request<any>(`/api/sync/admin/api${path}`, o);

export const api = {
  invoices: (): Promise<Invoice[]> => internal("/invoices"),
  invoice: (id: number): Promise<Invoice> => internal(`/invoices/${id}`),
  createInvoice: (body: InvoiceInput & { status: "draft" | "issued" }, idempotencyKey: string): Promise<Invoice> =>
    internal("/invoices", { method: "POST", body, idempotencyKey }),
  updateInvoice: (inv: Invoice, patch: Partial<InvoiceInput>): Promise<Invoice> =>
    internal(`/invoices/${inv.id}`, { method: "PATCH", body: patch, version: inv.version }),
  issueInvoice: (inv: Invoice): Promise<Invoice> => internal(`/invoices/${inv.id}/issue`, { method: "POST", version: inv.version }),
  voidInvoice: (inv: Invoice): Promise<Invoice> => internal(`/invoices/${inv.id}/void`, { method: "POST", version: inv.version }),
  deleteInvoice: (inv: Invoice): Promise<void> => internal(`/invoices/${inv.id}`, { method: "DELETE", version: inv.version }),

  customers: (): Promise<Customer[]> => internal("/customers"),
  createCustomer: (displayName: string, idempotencyKey: string): Promise<Customer> =>
    internal("/customers", { method: "POST", body: { displayName }, idempotencyKey }),

  payments: (invoiceId: number): Promise<Payment[]> => internal(`/payments?invoiceId=${invoiceId}`),
  allPayments: (): Promise<Payment[]> => internal("/payments"),
  createPayment: (
    body: { invoiceId: number; amountCents: number; txnDate: string; method: string; ref?: string },
    idempotencyKey: string,
  ): Promise<Payment> => internal("/payments", { method: "POST", body, idempotencyKey }),
  voidPayment: (p: Payment): Promise<Payment> => internal(`/payments/${p.id}/void`, { method: "POST", version: p.version }),

  status: (): Promise<Status> => admin("/status"),
  links: (): Promise<Link[]> => admin("/links"),
  attempts: (linkId: number): Promise<Attempt[]> => admin(`/links/${linkId}/attempts`),
  conflicts: (): Promise<Conflict[]> => admin("/conflicts"),
  candidates: (): Promise<Candidate[]> => admin("/candidates"),
  attention: (): Promise<AttentionItem[]> => admin("/attention"),
  failedJobs: (): Promise<FailedJob[]> => admin("/failed-jobs"),
  resolveConflict: (id: number, winner: Side) => admin(`/conflicts/${id}/resolve`, { method: "POST", body: { winner } }),
  confirmCandidate: (id: number, winner: Side) => admin(`/candidates/${id}/confirm`, { method: "POST", body: { winner } }),
  qboConnectUrl: (): Promise<{ url: string }> => admin("/qbo/connect", { method: "POST", body: {} }),
};

/** An Invoice's sync state as a pill shows it. Drafts are never synced; an issued one waits for its Link. */
export function syncStateOf(inv: Invoice, links: Link[] | undefined): LinkState | "none" | "draft" {
  if (inv.status === "draft") return "draft";
  return links?.find((l) => l.internalId === String(inv.id))?.state ?? "none";
}

// --- Queries: one key per resource, so a mutation knows what to refresh ---

/** The sync moves data in the background (QBO edits, retries), so views that show sync state poll. */
const LIVE = 15_000;

export const q = {
  invoices: () => queryOptions({ queryKey: ["invoices"], queryFn: api.invoices, refetchInterval: 30_000 }),
  invoice: (id: number) => queryOptions({ queryKey: ["invoices", id], queryFn: () => api.invoice(id), refetchInterval: LIVE }),
  customers: () => queryOptions({ queryKey: ["customers"], queryFn: api.customers, staleTime: 60_000 }),
  payments: (invoiceId: number) => queryOptions({ queryKey: ["payments", invoiceId], queryFn: () => api.payments(invoiceId), refetchInterval: LIVE }),
  allPayments: () => queryOptions({ queryKey: ["payments"], queryFn: api.allPayments, refetchInterval: 30_000 }),
  status: () => queryOptions({ queryKey: ["sync", "status"], queryFn: api.status, refetchInterval: LIVE }),
  links: () => queryOptions({ queryKey: ["sync", "links"], queryFn: api.links, refetchInterval: LIVE }),
  attempts: (linkId: number) => queryOptions({ queryKey: ["sync", "attempts", linkId], queryFn: () => api.attempts(linkId), refetchInterval: LIVE }),
  conflicts: () => queryOptions({ queryKey: ["sync", "conflicts"], queryFn: api.conflicts, refetchInterval: LIVE }),
  candidates: () => queryOptions({ queryKey: ["sync", "candidates"], queryFn: api.candidates, refetchInterval: LIVE }),
  attention: () => queryOptions({ queryKey: ["sync", "attention"], queryFn: api.attention, refetchInterval: LIVE }),
  failedJobs: () => queryOptions({ queryKey: ["sync", "failed-jobs"], queryFn: api.failedJobs, refetchInterval: LIVE }),
};
