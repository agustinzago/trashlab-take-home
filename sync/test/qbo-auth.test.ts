import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildSyncApp } from "../src/app.ts";
import { CustomTxnNumbersOff, assertCustomTxnNumbers, createTokenStore, type OAuthConfig } from "../src/qbo-auth.ts";
import { createQboClient } from "../src/qbo.ts";
import { line, setupSync, type SyncHarness } from "./harness.ts";

let h: SyncHarness;
let oauth: OAuthConfig;
let app: FastifyInstance;

beforeEach(async () => {
  h = await setupSync();
  oauth = {
    clientId: h.qbo.oauthClient.id,
    clientSecret: h.qbo.oauthClient.secret,
    redirectUri: "http://localhost:3000/qbo/callback",
    authorizeUrl: "https://appcenter.intuit.com/connect/oauth2",
    tokenUrl: `${h.qbo.url}/oauth2/v1/tokens/bearer`,
    apiBaseUrl: h.qbo.url,
  };
  app = buildSyncApp({ ...h.deps, oauth });
  h.qbo.strictTokens = true;
});
afterEach(async () => {
  await app.close();
  await h.close();
});

const store = () => createTokenStore(h.pool, oauth);
const connection = async () => (await h.pool.query("SELECT * FROM qbo_connection")).rows[0];

/** Follows the connect link and returns as Intuit would after the operator consents. */
async function connect(code = "good-code") {
  const start = await app.inject({ method: "GET", url: "/admin/qbo/connect" });
  const location = new URL(start.headers.location as string);
  const state = location.searchParams.get("state")!;
  return app.inject({ method: "GET", url: `/qbo/callback?code=${code}&state=${state}&realmId=${h.qbo.realmId}` });
}

describe("QBO connection (OAuth 2)", () => {
  it("sends the operator to Intuit with the client id, accounting scope, redirect and a state", async () => {
    const res = await app.inject({ method: "GET", url: "/admin/qbo/connect" });

    expect(res.statusCode).toBe(302);
    const url = new URL(res.headers.location as string);
    expect(url.origin + url.pathname).toBe(oauth.authorizeUrl);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: oauth.clientId,
      response_type: "code",
      scope: "com.intuit.quickbooks.accounting",
      redirect_uri: oauth.redirectUri,
      state: expect.stringMatching(/.{20,}/),
    });
  });

  it("hands the web console the same sign-in URL as JSON, with a state the callback accepts", async () => {
    const start = await app.inject({ method: "POST", url: "/admin/api/qbo/connect" });
    const state = new URL(start.json().url).searchParams.get("state");

    const res = await app.inject({ method: "GET", url: `/qbo/callback?code=good-code&state=${state}&realmId=${h.qbo.realmId}` });
    expect(res.statusCode).toBe(200);
    expect(await connection()).toMatchObject({ realm_id: h.qbo.realmId });
  });

  it("stores the tokens from the callback, and they persist for a new process", async () => {
    const res = await connect();

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(h.qbo.realmId);
    expect(await connection()).toMatchObject({ realm_id: h.qbo.realmId, access_token: "access-1", refresh_token: "refresh-1" });
    // A fresh token store (a restarted service) reads the same connection.
    expect(await store().getAuth()).toEqual({ realmId: h.qbo.realmId, accessToken: "access-1" });
  });

  it("rejects a callback whose state it did not issue", async () => {
    const res = await app.inject({ method: "GET", url: `/qbo/callback?code=good-code&state=forged&realmId=${h.qbo.realmId}` });
    expect(res.statusCode).toBe(400);
    expect(await connection()).toBeUndefined();
  });

  it("refuses to connect a company with Custom transaction numbers off", async () => {
    h.qbo.customTxnNumbers = false;

    const res = await connect();

    expect(res.statusCode).toBe(409);
    expect(res.body).toContain("Custom transaction numbers");
    expect(await connection()).toBeUndefined();
  });

  it("fails the startup check with a clear message when Custom transaction numbers is off", async () => {
    await connect();
    const qbo = createQboClient({ baseUrl: h.qbo.url, getAuth: store().getAuth });
    await expect(assertCustomTxnNumbers(qbo)).resolves.toBeUndefined();

    h.qbo.customTxnNumbers = false;
    await expect(assertCustomTxnNumbers(qbo)).rejects.toBeInstanceOf(CustomTxnNumbersOff);
    await expect(assertCustomTxnNumbers(qbo)).rejects.toThrow(/Custom transaction numbers.*off/);
  });

  it("refreshes an expiring token once, replacing both tokens together, even when asked concurrently", async () => {
    await connect();
    await h.pool.query("UPDATE qbo_connection SET access_expires_at = now() - interval '1 minute'");
    const before = h.qbo.tokenRequests.length;

    const [a, b] = await Promise.all([store().getAuth(), store().getAuth()]);

    expect(a.accessToken).toBe("access-2");
    expect(b.accessToken).toBe("access-2");
    expect(h.qbo.tokenRequests.length - before).toBe(1);
    expect(await connection()).toMatchObject({ access_token: "access-2", refresh_token: "refresh-2" });
  });

  it("keeps the old, still usable pair when a refresh fails partway", async () => {
    await connect();
    await h.pool.query("UPDATE qbo_connection SET access_expires_at = now() - interval '1 minute'");
    h.qbo.injectFault("timeoutBeforeCommit", { path: /tokens/ });

    await expect(store().getAuth()).rejects.toThrow();

    expect(await connection()).toMatchObject({ access_token: "access-1", refresh_token: "refresh-1" });
    expect((await store().getAuth()).accessToken).toBe("access-2"); // the retry uses the intact refresh token
  });

  it("asks for a reconnect, without calling QBO, once the refresh token has expired", async () => {
    await connect();
    await h.pool.query("UPDATE qbo_connection SET access_expires_at = now() - interval '1 minute', refresh_expires_at = now() - interval '1 second'");
    const before = h.qbo.tokenRequests.length;

    await expect(store().getAuth()).rejects.toMatchObject({ status: 401, message: expect.stringMatching(/reconnect/i) });
    expect(h.qbo.tokenRequests.length).toBe(before);
  });

  it("refuses to switch the connection to a different QBO company", async () => {
    await connect();
    await h.pool.query("UPDATE qbo_connection SET realm_id = 'another-company'");

    const res = await connect();

    expect(res.statusCode).toBe(409);
    expect(await connection()).toMatchObject({ realm_id: "another-company" });
  });

  it("shows a Not connected page when the code exchange fails", async () => {
    const res = await connect("used-or-wrong-code");
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("Not connected");
    expect(await connection()).toBeUndefined();
  });

  it("holds sync work while not connected, and resumes once connected", async () => {
    const deps = { ...h.deps, qbo: createQboClient({ baseUrl: h.qbo.url, getAuth: store().getAuth }) };
    await h.mapRevenue("consulting", h.qbo.addItem("Consulting"));
    const customer = await h.api("POST", "/customers", { displayName: "Acme" });
    await h.api("POST", "/invoices", { docNumber: "INV-1", customerId: customer.id, txnDate: "2026-11-01", lines: [line(100)], status: "issued" });
    await h.deliver();
    const { drain } = await import("../src/worker.ts");

    await drain(deps);
    expect(h.qbo.invoices).toHaveLength(0);
    expect((await h.pool.query("SELECT status FROM sync_jobs")).rows).toEqual([{ status: "pending" }]);

    await connect();
    await h.advanceClock();
    await drain(deps);
    expect(h.qbo.invoices).toHaveLength(1);
  });
});
