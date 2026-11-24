export type QboAuth = { realmId: string; accessToken: string };
export type QboConfig = {
  baseUrl: string;
  /** The connected company and a current access token (refreshed as needed). */
  getAuth: () => Promise<QboAuth>;
};

export class QboError extends Error {
  status: number;
  code?: string;
  constructor(status: number, code: string | undefined, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const MINOR_VERSION = "75";

const withRequestId = (path: string, requestId?: string) =>
  requestId ? `${path}${path.includes("?") ? "&" : "?"}requestid=${encodeURIComponent(requestId)}` : path;

/** Thin client over the QBO Accounting API: query, create and read entities. */
export function createQboClient(cfg: QboConfig) {
  async function call(method: string, path: string, body?: object): Promise<any> {
    const sep = path.includes("?") ? "&" : "?";
    const { realmId, accessToken } = await cfg.getAuth();
    const res = await fetch(`${cfg.baseUrl}/v3/company/${realmId}/${path}${sep}minorversion=${MINOR_VERSION}`, {
      method,
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    const json: any = await res.json().catch(() => null);
    if (!res.ok) {
      // Validation faults use "Fault"/"Error"; auth faults (401) come back lowercase.
      const err = json?.Fault?.Error?.[0] ?? json?.fault?.error?.[0];
      const detail = [err?.Message ?? err?.message, err?.Detail ?? err?.detail].filter(Boolean).join(" ");
      throw new QboError(res.status, err?.code, `QBO ${method} ${path} -> ${res.status} ${detail}`.trim());
    }
    return json;
  }

  return {
    /** `select * from <entity> [where <field> = '<value>']` */
    async query(entity: string, where?: [field: string, value: string]): Promise<any[]> {
      const filter = where ? ` where ${where[0]} = '${where[1].replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'` : "";
      const json = await call("GET", `query?query=${encodeURIComponent(`select * from ${entity}${filter}`)}`);
      return json.QueryResponse?.[entity] ?? [];
    },
    /** `requestId` lets QBO recognise a retry of the same write (its replay window is short, so callers also look before re-creating). */
    async create(entity: string, body: object, requestId?: string): Promise<any> {
      return (await call("POST", withRequestId(entity.toLowerCase(), requestId), body))[entity];
    },
    /** QBO updates POST to the create endpoint with Id and SyncToken in the body. */
    async update(entity: string, body: { Id: string; SyncToken: string; [field: string]: unknown }, requestId?: string): Promise<any> {
      return (await call("POST", withRequestId(entity.toLowerCase(), requestId), body))[entity];
    },
    /** QBO's void keeps the record and zeroes it; it carries the SyncToken read, like an update. */
    async void(entity: string, body: { Id: string; SyncToken: string }, requestId?: string): Promise<any> {
      // An Invoice is voided with operation=void. A received Payment is voided as a sparse update with
      // include=void: on a Payment, operation=void means voiding a card charge (confirmed in the sandbox spike).
      const [path, payload] =
        entity === "Payment"
          ? ["payment?operation=update&include=void", { ...body, sparse: true }]
          : [`${entity.toLowerCase()}?operation=void`, body];
      return (await call("POST", withRequestId(path, requestId), payload))[entity];
    },
    /** Change data capture: everything of these entities changed since `changedSince`, deletes included. */
    async cdc(entities: string[], changedSince: string): Promise<{ entities: Record<string, any[]>; time: string }> {
      const json = await call("GET", `cdc?entities=${entities.join(",")}&changedSince=${encodeURIComponent(changedSince)}`);
      const found: Record<string, any[]> = {};
      for (const response of json.CDCResponse ?? []) {
        for (const q of response.QueryResponse ?? []) {
          for (const [entity, rows] of Object.entries(q)) if (Array.isArray(rows)) (found[entity] ??= []).push(...rows);
        }
      }
      return { entities: found, time: json.time };
    },
    /** Hard delete (used only by the spike script: the sync itself never deletes). */
    async delete(entity: string, body: { Id: string; SyncToken: string }): Promise<any> {
      return (await call("POST", `${entity.toLowerCase()}?operation=delete`, body))[entity];
    },
    async preferences(): Promise<any> {
      return (await call("GET", "preferences")).Preferences;
    },
    async get(entity: string, id: string): Promise<any> {
      return (await call("GET", `${entity.toLowerCase()}/${id}`))[entity];
    },
  };
}

export type QboClient = ReturnType<typeof createQboClient>;
