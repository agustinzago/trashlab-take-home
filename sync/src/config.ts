import pg from "pg";
import { migrate } from "../../shared/db.ts";
import type { SyncDeps } from "./app.ts";
import { createInternalClient } from "./internal.ts";
import { createQboClient } from "./qbo.ts";
import { createTokenStore, type OAuthConfig } from "./qbo-auth.ts";
import { setAccountMapping } from "./worker.ts";

type TokenStore = Pick<ReturnType<typeof createTokenStore>, "getAuth" | "isConnected">;

export function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

/**
 * The sync service's dependencies from its environment, shared by the server and
 * the CLI. Only the server needs the webhook and admin secrets.
 */
export async function depsFromEnv({ server }: { server: boolean }): Promise<SyncDeps & { tokens: TokenStore }> {
  const pool = new pg.Pool({ connectionString: required("DATABASE_URL") });
  await migrate(pool, new URL("./schema.sql", import.meta.url));

  // ACCOUNT_MAPPING='{"revenue_category":{"consulting":"1"},"payment_method":{"check":"35"}}' maps internal keys to QBO ids.
  const mapping = JSON.parse(process.env.ACCOUNT_MAPPING ?? "{}") as Record<string, Record<string, string>>;
  for (const [kind, entries] of Object.entries(mapping)) {
    for (const [key, ref] of Object.entries(entries)) await setAccountMapping(pool, kind as "revenue_category", key, ref);
  }

  const common = {
    pool,
    internal: createInternalClient(required("INTERNAL_URL")),
    internalWebhookSecret: server ? required("INTERNAL_WEBHOOK_SECRET") : "",
    qboWebhookVerifier: server ? required("QBO_WEBHOOK_VERIFIER") : "",
    // Fails closed: the admin page can resolve Conflicts, so it never runs open.
    adminPassword: server ? required("ADMIN_PASSWORD") : undefined,
  };

  // Without an Intuit app configured, run against the mock QBO service (mock-qbo/), so the stack works
  // out of the box. The mock accepts any token, so the "connection" is recorded once and never refreshed.
  if (!process.env.QBO_CLIENT_ID) {
    const baseUrl = required("QBO_MOCK_URL");
    const realmId = process.env.QBO_MOCK_REALM ?? "9130000000000000";
    await pool.query(
      `INSERT INTO qbo_connection (id, realm_id, access_token, refresh_token, access_expires_at, refresh_expires_at)
       VALUES (1, $1, 'mock', 'mock', now() + interval '100 years', now() + interval '100 years') ON CONFLICT (id) DO NOTHING`,
      [realmId],
    );
    const tokens: TokenStore = { getAuth: async () => ({ realmId, accessToken: "mock" }), isConnected: async () => true };
    return { ...common, tokens, qbo: createQboClient({ baseUrl, getAuth: tokens.getAuth }) };
  }

  const oauth: OAuthConfig = {
    clientId: required("QBO_CLIENT_ID"),
    clientSecret: required("QBO_CLIENT_SECRET"),
    redirectUri: required("QBO_REDIRECT_URI"),
    authorizeUrl: process.env.QBO_AUTHORIZE_URL ?? "https://appcenter.intuit.com/connect/oauth2",
    tokenUrl: process.env.QBO_TOKEN_URL ?? "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
    apiBaseUrl: process.env.QBO_BASE_URL ?? "https://sandbox-quickbooks.api.intuit.com",
  };
  const tokens = createTokenStore(pool, oauth);
  return { ...common, oauth, tokens, qbo: createQboClient({ baseUrl: oauth.apiBaseUrl, getAuth: tokens.getAuth }) };
}
