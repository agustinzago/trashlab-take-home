import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { buildApp as buildInternalApp } from "../../internal-system/src/app.ts";
import { deliverDue } from "../../internal-system/src/outbox.ts";
import { internalTestPool } from "../../internal-system/test/harness.ts";
import { testPool } from "../../shared/test-db.ts";
import { buildSyncApp, type SyncDeps } from "../src/app.ts";
import { createInternalClient } from "../src/internal.ts";
import { createQboClient } from "../src/qbo.ts";
import { drain, setAccountMapping } from "../src/worker.ts";
import { startFakeQbo, type FakeQbo, type QboEvent } from "./fake-qbo.ts";

export const webhookSecret = "internal-webhook-secret";
export const qboWebhookVerifier = "qbo-verifier-token";
export const signQbo = (body: string) => createHmac("sha256", qboWebhookVerifier).update(body).digest("base64");

const urlOf = (app: FastifyInstance) => `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

/**
 * Both real services on their own databases, with QBO replaced by the fake.
 * Tests act through the Internal System API and the fake QBO, then deliver
 * notifications and drain the worker before asserting on end state.
 */
export async function setupSync() {
  const internalPool = await internalTestPool();
  const internalApp = buildInternalApp(internalPool);
  await internalApp.listen({ host: "127.0.0.1", port: 0 });

  const qbo: FakeQbo = await startFakeQbo();
  const pool = await testPool("sync_test", new URL("../src/schema.sql", import.meta.url), [
    "change_hints",
    "sync_jobs",
    "links",
    "sync_attempts",
    "account_mappings",
    "conflicts",
  ]);
  const deps: SyncDeps = {
    pool,
    internal: createInternalClient(urlOf(internalApp)),
    qbo: createQboClient({ baseUrl: qbo.url, realmId: qbo.realmId, getAccessToken: async () => "test-token" }),
    internalWebhookSecret: webhookSecret,
    qboWebhookVerifier,
  };
  const syncApp = buildSyncApp(deps);
  await syncApp.listen({ host: "127.0.0.1", port: 0 });

  const api = async (method: string, url: string, payload?: object, headers: Record<string, string> = {}) => {
    const res = await internalApp.inject({ method: method as any, url, payload, headers });
    if (res.statusCode >= 300) throw new Error(`${method} ${url} -> ${res.statusCode} ${res.body}`);
    return res.statusCode === 204 ? undefined : res.json();
  };

  /** Posts QBO change events to the sync service as a signed QBO webhook. */
  const sendQboWebhook = (entities: QboEvent[]) => {
    const body = JSON.stringify({ eventNotifications: [{ realmId: qbo.realmId, dataChangeEvent: { entities } }] });
    return syncApp.inject({
      method: "POST",
      url: "/webhooks/qbo",
      headers: { "content-type": "application/json", "intuit-signature": signQbo(body) },
      payload: body,
    });
  };

  const deliver = () =>
    deliverDue(internalPool, { url: `${urlOf(syncApp)}/webhooks/internal`, secret: webhookSecret, chaos: false, retryBaseMs: 0 });
  const deliverQbo = async () => {
    const pending = h.qbo.events.splice(0);
    if (pending.length) {
      const res = await sendQboWebhook(pending);
      if (res.statusCode >= 300) throw new Error(`QBO webhook -> ${res.statusCode} ${res.body}`);
    }
    return pending.length;
  };

  const h = {
    deps,
    pool,
    qbo,
    syncApp,
    api,
    sendQboWebhook,
    /** Sends every pending Internal System notification to the sync service once. */
    deliver,
    /** Sends every queued fake-QBO change event to the sync service once. */
    deliverQbo,
    drain: () => drain(deps),
    /** Delivers notifications from both Sides and drains, until the echoes of our own writes die out. */
    async settle() {
      for (let i = 0; i < 10; i++) {
        const delivered = (await deliver()) + (await deliverQbo());
        const processed = await drain(deps);
        if (delivered === 0 && processed === 0) return;
      }
      throw new Error("sync did not settle");
    },
    mapRevenue: (category: string, itemId: string) => setAccountMapping(pool, "revenue_category", category, itemId),
    async close() {
      await syncApp.close();
      await internalApp.close();
      await qbo.close();
      await pool.end();
      await internalPool.end();
    },
  };
  return h;
}

export type SyncHarness = Awaited<ReturnType<typeof setupSync>>;

export const line = (amountCents: number, revenueCategory = "consulting") => ({
  description: `${revenueCategory} work`,
  amountCents,
  revenueCategory,
});
