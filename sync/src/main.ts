import pg from "pg";
import { migrate } from "../../shared/db.ts";
import { buildSyncApp } from "./app.ts";
import { createInternalClient } from "./internal.ts";
import { createQboClient } from "./qbo.ts";
import { setAccountMapping, startWorker } from "./worker.ts";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const pool = new pg.Pool({ connectionString: required("DATABASE_URL") });
await migrate(pool, new URL("./schema.sql", import.meta.url));

// ACCOUNT_MAPPING='{"revenue_category":{"consulting":"1"}}' maps internal keys to QBO Item ids.
const mapping = JSON.parse(process.env.ACCOUNT_MAPPING ?? "{}") as Record<string, Record<string, string>>;
for (const [kind, entries] of Object.entries(mapping)) {
  for (const [key, ref] of Object.entries(entries)) await setAccountMapping(pool, kind as "revenue_category", key, ref);
}

// ponytail: static access token until the OAuth connection (#2) stores and refreshes tokens.
const accessToken = required("QBO_ACCESS_TOKEN");
const deps = {
  pool,
  internal: createInternalClient(required("INTERNAL_URL")),
  qbo: createQboClient({
    baseUrl: process.env.QBO_BASE_URL ?? "https://sandbox-quickbooks.api.intuit.com",
    realmId: required("QBO_REALM_ID"),
    getAccessToken: async () => accessToken,
  }),
  internalWebhookSecret: required("INTERNAL_WEBHOOK_SECRET"),
  qboWebhookVerifier: required("QBO_WEBHOOK_VERIFIER"),
};

const app = buildSyncApp(deps);
await app.listen({ host: "0.0.0.0", port: Number(process.env.PORT ?? 3000) });
const stopWorker = startWorker(deps);
console.log("sync service listening");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await stopWorker();
    await app.close();
    await pool.end();
    process.exit(0);
  });
}
