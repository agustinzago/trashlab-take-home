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
import { startFakeQbo, type FakeQbo } from "./fake-qbo.ts";

export const webhookSecret = "internal-webhook-secret";

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
  ]);
  const deps: SyncDeps = {
    pool,
    internal: createInternalClient(urlOf(internalApp)),
    qbo: createQboClient({ baseUrl: qbo.url, realmId: qbo.realmId, getAccessToken: async () => "test-token" }),
    internalWebhookSecret: webhookSecret,
  };
  const syncApp = buildSyncApp(deps);
  await syncApp.listen({ host: "127.0.0.1", port: 0 });

  const api = async (method: string, url: string, payload?: object, headers: Record<string, string> = {}) => {
    const res = await internalApp.inject({ method: method as any, url, payload, headers });
    if (res.statusCode >= 300) throw new Error(`${method} ${url} -> ${res.statusCode} ${res.body}`);
    return res.statusCode === 204 ? undefined : res.json();
  };

  return {
    pool,
    qbo,
    syncApp,
    api,
    /** Sends every pending Internal System notification to the sync service once. */
    deliver: () =>
      deliverDue(internalPool, { url: `${urlOf(syncApp)}/webhooks/internal`, secret: webhookSecret, chaos: false, retryBaseMs: 0 }),
    drain: () => drain(deps),
    mapRevenue: (category: string, itemId: string) => setAccountMapping(pool, "revenue_category", category, itemId),
    async close() {
      await syncApp.close();
      await internalApp.close();
      await qbo.close();
      await pool.end();
      await internalPool.end();
    },
  };
}

export type SyncHarness = Awaited<ReturnType<typeof setupSync>>;

export const line = (amountCents: number, revenueCategory = "consulting") => ({
  description: `${revenueCategory} work`,
  amountCents,
  revenueCategory,
});
