import { createHmac, timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import type pg from "pg";
import type { InternalClient } from "./internal.ts";
import type { QboClient } from "./qbo.ts";
import { recordHint } from "./worker.ts";

export type SyncDeps = {
  pool: pg.Pool;
  internal: InternalClient;
  qbo: QboClient;
  internalWebhookSecret: string;
};

function signatureValid(raw: string, header: unknown, secret: string): boolean {
  if (typeof header !== "string") return false;
  const expected = Buffer.from("sha256=" + createHmac("sha256", secret).update(raw).digest("hex"));
  const given = Buffer.from(header);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

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
        if (!signatureValid((req as any).rawBody ?? "", req.headers["x-signature"], deps.internalWebhookSecret)) {
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

  return app;
}
