import pg from "pg";
import { buildApp } from "./app.ts";
import { migrate } from "../../shared/db.ts";
import { startDelivery } from "./outbox.ts";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const pool = new pg.Pool({ connectionString: required("DATABASE_URL") });
await migrate(pool, new URL("./schema.sql", import.meta.url));

const app = buildApp(pool);
await app.listen({ host: "0.0.0.0", port: Number(process.env.PORT ?? 3001) });

const chaos = process.env.CHAOS === "1" || process.env.CHAOS === "true";
const stopDelivery = startDelivery(pool, { url: required("WEBHOOK_URL"), secret: required("WEBHOOK_SECRET"), chaos });
console.log(`internal system listening; webhooks to ${process.env.WEBHOOK_URL}${chaos ? " (CHAOS on)" : ""}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await stopDelivery();
    await app.close();
    await pool.end();
    process.exit(0);
  });
}
