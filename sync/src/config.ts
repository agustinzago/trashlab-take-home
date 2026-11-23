import pg from "pg";
import { migrate } from "../../shared/db.ts";
import type { SyncDeps } from "./app.ts";
import { createInternalClient } from "./internal.ts";
import { createQboClient } from "./qbo.ts";
import { setAccountMapping } from "./worker.ts";

export function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

/**
 * The sync service's dependencies from its environment, shared by the server and
 * the CLI. Only the server needs the webhook and admin secrets.
 */
export async function depsFromEnv({ server }: { server: boolean }): Promise<SyncDeps> {
  const pool = new pg.Pool({ connectionString: required("DATABASE_URL") });
  await migrate(pool, new URL("./schema.sql", import.meta.url));

  // ACCOUNT_MAPPING='{"revenue_category":{"consulting":"1"},"payment_method":{"check":"35"}}' maps internal keys to QBO ids.
  const mapping = JSON.parse(process.env.ACCOUNT_MAPPING ?? "{}") as Record<string, Record<string, string>>;
  for (const [kind, entries] of Object.entries(mapping)) {
    for (const [key, ref] of Object.entries(entries)) await setAccountMapping(pool, kind as "revenue_category", key, ref);
  }

  // ponytail: static access token until the OAuth connection (#2) stores and refreshes tokens.
  const accessToken = required("QBO_ACCESS_TOKEN");
  return {
    pool,
    internal: createInternalClient(required("INTERNAL_URL")),
    qbo: createQboClient({
      baseUrl: process.env.QBO_BASE_URL ?? "https://sandbox-quickbooks.api.intuit.com",
      realmId: required("QBO_REALM_ID"),
      getAccessToken: async () => accessToken,
    }),
    internalWebhookSecret: server ? required("INTERNAL_WEBHOOK_SECRET") : "",
    qboWebhookVerifier: server ? required("QBO_WEBHOOK_VERIFIER") : "",
    // Fails closed: the admin page can resolve Conflicts, so it never runs open.
    adminPassword: server ? required("ADMIN_PASSWORD") : undefined,
  };
}
