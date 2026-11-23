export type QboConfig = {
  baseUrl: string;
  realmId: string;
  getAccessToken: () => Promise<string>;
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

/** Thin client over the QBO Accounting API: query, create and read entities. */
export function createQboClient(cfg: QboConfig) {
  async function call(method: string, path: string, body?: object): Promise<any> {
    const sep = path.includes("?") ? "&" : "?";
    const res = await fetch(`${cfg.baseUrl}/v3/company/${cfg.realmId}/${path}${sep}minorversion=${MINOR_VERSION}`, {
      method,
      headers: {
        authorization: `Bearer ${await cfg.getAccessToken()}`,
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
    async create(entity: string, body: object): Promise<any> {
      return (await call("POST", entity.toLowerCase(), body))[entity];
    },
    async get(entity: string, id: string): Promise<any> {
      return (await call("GET", `${entity.toLowerCase()}/${id}`))[entity];
    },
  };
}

export type QboClient = ReturnType<typeof createQboClient>;
