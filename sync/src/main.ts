import { buildSyncApp } from "./app.ts";
import { startCdcPoller } from "./cdc.ts";
import { depsFromEnv } from "./config.ts";
import { CustomTxnNumbersOff, assertCustomTxnNumbers } from "./qbo-auth.ts";
import { startWorker } from "./worker.ts";

const deps = await depsFromEnv({ server: true });
if (await deps.tokens.isConnected()) {
  // Refuse to sync a company where DocNumber can't be set: there would be no shared identity.
  // Only a definite "off" stops the service; an expired connection or an outage must not keep
  // the operator from reaching /admin/qbo/connect, so the service starts and holds work instead.
  await assertCustomTxnNumbers(deps.qbo).catch((err) => {
    if (err instanceof CustomTxnNumbersOff) {
      console.error(err.message);
      process.exit(1);
    }
    console.warn(`Could not check QBO preferences (${err.message}); starting, sync work is held until QBO answers.`);
  });
} else {
  console.log("QBO is not connected yet: connect it from the web console or /admin/qbo/connect. Sync work is held until then.");
}
const app = buildSyncApp(deps);
await app.listen({ host: "0.0.0.0", port: Number(process.env.PORT ?? 3000) });
const stopWorker = startWorker(deps);
const stopCdc = startCdcPoller(deps);
console.log("sync service listening");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    stopCdc();
    await stopWorker();
    await app.close();
    await deps.pool.end();
    process.exit(0);
  });
}
