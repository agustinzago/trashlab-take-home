import { createHmac, timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import type pg from "pg";
import type { InternalClient } from "./internal.ts";
import type { QboClient } from "./qbo.ts";
import { registerAdmin } from "./admin.ts";
import { qboHintKey, recordHint, type RetryConfig } from "./worker.ts";

export type SyncDeps = {
  pool: pg.Pool;
  internal: InternalClient;
  qbo: QboClient;
  internalWebhookSecret: string;
  /** QBO's webhook verifier token, the HMAC key for the intuit-signature header. */
  qboWebhookVerifier: string;
  /** When set, /admin requires HTTP Basic auth as admin:<password>. */
  adminPassword?: string;
  /** Retry delays per error class; defaults to production values. */
  retry?: RetryConfig;
};

function hmacMatches(expected: string, header: unknown): boolean {
  if (typeof header !== "string") return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  return a.length === b.length && timingSafeEqual(a, b);
}

const internalSignature = (raw: string, secret: string) => "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");
const qboSignature = (raw: string, verifier: string) => createHmac("sha256", verifier).update(raw).digest("base64");

export function buildSyncApp(deps: SyncDeps): FastifyInstance {
  const app = Fastify();

  // Keep the raw body: the HMAC is over the exact bytes sent.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    (req as any).rawBody = body;
    try {
      done(null, JSON.parse(body as string));
    } catch (err) {
      done(Object.assign(err as Error, { statusCode: 400 }), undefined);
    }
  });

  app.post(
    "/webhooks/internal",
    {
      schema: {
        body: {
          type: "object",
          required: ["deliveryId", "type", "id"],
          properties: { deliveryId: { type: "string" }, type: { type: "string" }, id: { type: "integer" } },
        },
      },
      // Reject forgeries before validating or trusting anything in the body.
      preValidation: async (req, reply) => {
        const raw = (req as any).rawBody ?? "";
        if (!hmacMatches(internalSignature(raw, deps.internalWebhookSecret), req.headers["x-signature"])) {
          return reply.code(401).send({ message: "invalid signature" });
        }
      },
    },
    async (req, reply) => {
      const { deliveryId, type, id } = req.body as { deliveryId: string; type: string; id: number };
      await recordHint(deps.pool, { side: "internal", recordType: type, recordId: String(id), dedupeKey: `internal:${deliveryId}` });
      return reply.code(204).send();
    },
  );

  // QBO webhooks list changed entities by name and id only; each becomes a Change Hint.
  app.post(
    "/webhooks/qbo",
    {
      preValidation: async (req, reply) => {
        const raw = (req as any).rawBody ?? "";
        if (!hmacMatches(qboSignature(raw, deps.qboWebhookVerifier), req.headers["intuit-signature"])) {
          return reply.code(401).send({ message: "invalid signature" });
        }
      },
    },
    async (req, reply) => {
      const body = req.body as { eventNotifications?: { dataChangeEvent?: { entities?: any[] } }[] };
      for (const n of body.eventNotifications ?? []) {
        for (const e of n.dataChangeEvent?.entities ?? []) {
          if (typeof e?.name !== "string" || typeof e?.id !== "string") continue;
          await recordHint(deps.pool, {
            side: "qbo",
            recordType: e.name.toLowerCase(),
            recordId: e.id,
            dedupeKey: qboHintKey(e.name, e.id, e.operation, e.lastUpdated),
          });
        }
      }
      return reply.code(200).send();
    },
  );

  registerAdmin(app, deps.pool, deps.adminPassword);
  return app;
}
