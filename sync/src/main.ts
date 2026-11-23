import { buildSyncApp } from "./app.ts";
import { depsFromEnv } from "./config.ts";
import { startWorker } from "./worker.ts";

const deps = await depsFromEnv({ server: true });
const app = buildSyncApp(deps);
await app.listen({ host: "0.0.0.0", port: Number(process.env.PORT ?? 3000) });
const stopWorker = startWorker(deps);
console.log("sync service listening");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await stopWorker();
    await app.close();
    await deps.pool.end();
    process.exit(0);
  });
}
