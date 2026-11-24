import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { tx } from "../../shared/db.ts";
import { createQboClient, type QboAuth, type QboClient } from "./qbo.ts";

export type OAuthConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  authorizeUrl: string;
  tokenUrl: string;
  /** The Accounting API base URL, for the Custom transaction numbers check at connect time. */
  apiBaseUrl: string;
};

type Tokens = { access_token: string; refresh_token: string; expires_in: number; x_refresh_token_expires_in: number };

const SCOPE = "com.intuit.quickbooks.accounting";
const REFRESH_MARGIN_MS = 60_000;

/** Anything the sync must hold for rather than fail on: it surfaces as the "auth" error class (401). */
const authError = (message: string) => Object.assign(new Error(message), { status: 401 });

/** QBO definitely reports "Custom transaction numbers" off: the one case that stops the service. */
export class CustomTxnNumbersOff extends Error {}

export async function tokenRequest(oauth: OAuthConfig, params: Record<string, string>): Promise<Tokens> {
  const res = await fetch(oauth.tokenUrl, {
    method: "POST",
    headers: {
      authorization: "Basic " + Buffer.from(`${oauth.clientId}:${oauth.clientSecret}`).toString("base64"),
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(15_000),
  });
  const json: any = await res.json().catch(() => null);
  if (!res.ok) {
    // A rejected grant (expired or revoked refresh token) needs a person to reconnect: hold, don't fail.
    const message = `QBO token request failed: ${res.status} ${json?.error ?? ""}`.trim();
    throw res.status === 400 || res.status === 401 ? authError(message) : Object.assign(new Error(message), { status: res.status });
  }
  return json;
}

const isFresh = (row: { access_expires_at: Date }) => row.access_expires_at.getTime() > Date.now() + REFRESH_MARGIN_MS;
const authOf = (row: { realm_id: string; access_token: string }): QboAuth => ({ realmId: row.realm_id, accessToken: row.access_token });

/** Stores a token pair; a refresh and a new connection both replace all four values in one statement. */
async function saveTokens(db: pg.Pool | pg.PoolClient, realmId: string, t: Tokens) {
  await db.query(
    `INSERT INTO qbo_connection (id, realm_id, access_token, refresh_token, access_expires_at, refresh_expires_at)
     VALUES (1, $1, $2, $3, now() + $4 * interval '1 second', now() + $5 * interval '1 second')
     ON CONFLICT (id) DO UPDATE SET access_token = EXCLUDED.access_token, refresh_token = EXCLUDED.refresh_token,
       access_expires_at = EXCLUDED.access_expires_at, refresh_expires_at = EXCLUDED.refresh_expires_at, refreshed_at = now()`,
    [realmId, t.access_token, t.refresh_token, t.expires_in, t.x_refresh_token_expires_in],
  );
}
export { saveTokens };

/**
 * The stored QBO connection: hands out a current access token, refreshing it when
 * it is about to expire. A refresh locks the connection row, so concurrent callers
 * refresh once, and replaces both tokens in the same transaction: if the call or
 * the process fails midway, the old (still valid) pair is left in place.
 */
export function createTokenStore(pool: pg.Pool, oauth: OAuthConfig) {
  return {
    async getAuth(): Promise<QboAuth> {
      const { rows } = await pool.query("SELECT * FROM qbo_connection WHERE id = 1");
      const row = rows[0];
      if (!row) throw authError("QBO is not connected: an operator must connect it at /admin/qbo/connect");
      if (isFresh(row)) return authOf(row);
      if (row.refresh_expires_at.getTime() <= Date.now()) {
        throw authError("The QBO connection has expired: an operator must reconnect it at /admin/qbo/connect");
      }
      return tx(pool, async (c) => {
        const locked = (await c.query("SELECT * FROM qbo_connection WHERE id = 1 FOR UPDATE")).rows[0];
        if (isFresh(locked)) return authOf(locked); // refreshed by someone else meanwhile
        // ponytail: if Intuit rotates the refresh token and we crash before COMMIT, we keep the previous one;
        // the sandbox spike saw the previous refresh token still honoured after a refresh.
        const t = await tokenRequest(oauth, { grant_type: "refresh_token", refresh_token: locked.refresh_token });
        await saveTokens(c, locked.realm_id, t);
        return { realmId: locked.realm_id, accessToken: t.access_token };
      });
    },
    async isConnected(): Promise<boolean> {
      return ((await pool.query("SELECT 1 FROM qbo_connection WHERE id = 1")).rowCount ?? 0) > 0;
    },
  };
}

/** DocNumber is the shared identity, so QBO must let us set it: "Custom transaction numbers" must be on. */
export async function assertCustomTxnNumbers(qbo: QboClient): Promise<void> {
  const prefs = await qbo.preferences();
  if (prefs?.SalesFormsPrefs?.CustomTxnNumbers !== true) {
    throw new CustomTxnNumbersOff(
      "QBO \"Custom transaction numbers\" is off. Turn it on (Settings > Account and settings > Sales > Custom transaction numbers); " +
        "without it DocNumber cannot be kept equal on both Sides, so the sync refuses to run.",
    );
  }
}

const page = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head>` +
  `<body style="font:15px system-ui;max-width:640px;margin:40px auto;padding:0 16px"><h1>${title}</h1>${body}</body></html>`;

/** GET /admin/qbo/connect: sends the operator to Intuit's sign-in to pick a QBO company and consent (behind the admin password). */
export function registerConnectRoute(app: FastifyInstance, pool: pg.Pool, oauth: OAuthConfig) {
  app.get("/admin/qbo/connect", async (_req, reply) => {
    const state = randomBytes(24).toString("base64url");
    await pool.query("INSERT INTO oauth_states (state) VALUES ($1)", [state]);
    const url = new URL(oauth.authorizeUrl);
    url.search = new URLSearchParams({
      client_id: oauth.clientId,
      response_type: "code",
      scope: SCOPE,
      redirect_uri: oauth.redirectUri,
      state,
    }).toString();
    return reply.code(302).header("location", url.toString()).send();
  });
}

/** GET /qbo/callback: Intuit's sign-in returns here with a one-time code; exchange it and store the connection. */
export function registerCallbackRoute(app: FastifyInstance, pool: pg.Pool, oauth: OAuthConfig) {
  app.get("/qbo/callback", async (req, reply) => {
    const { code, state, realmId, error } = req.query as Record<string, string | undefined>;
    const notConnected = (status: number, why: string) => reply.code(status).type("text/html").send(page("Not connected", `<p>${escapeHtml(why)}</p>`));
    if (error) return notConnected(400, `QBO said: ${error}`);
    // The state must be one we issued in the last 10 minutes, used once: no forged or replayed callbacks.
    const issued = await pool.query("DELETE FROM oauth_states WHERE state = $1 AND created_at > now() - interval '10 minutes'", [
      state ?? "",
    ]);
    if (!issued.rowCount || !code || !realmId) return notConnected(400, "This link is invalid or expired. Start again from the admin page.");
    // Links, the CDC cursor and Account Mapping all belong to one company: reconnecting may renew it, never switch it.
    const current = (await pool.query("SELECT realm_id FROM qbo_connection WHERE id = 1")).rows[0];
    if (current && current.realm_id !== realmId) {
      return notConnected(409, `This sync is connected to QBO company ${current.realm_id}. Reconnect that company; a different one needs a fresh sync database.`);
    }
    let t: Tokens;
    try {
      t = await tokenRequest(oauth, { grant_type: "authorization_code", code, redirect_uri: oauth.redirectUri });
    } catch (err) {
      return notConnected(400, `The sign-in could not be completed (${(err as Error).message}). Start again from the admin page.`);
    }
    const qbo = createQboClient({ baseUrl: oauth.apiBaseUrl, getAuth: async () => ({ realmId, accessToken: t.access_token }) });
    try {
      await assertCustomTxnNumbers(qbo);
    } catch (err) {
      return notConnected(err instanceof CustomTxnNumbersOff ? 409 : 502, (err as Error).message);
    }
    await saveTokens(pool, realmId, t);
    return reply.type("text/html").send(page("Connected", `<p>QBO company ${escapeHtml(realmId)} is connected. Held sync work resumes shortly.</p>`));
  });
}

const escapeHtml = (v: string) => v.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
