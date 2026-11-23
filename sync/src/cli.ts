// Operator commands, e.g. `docker compose run --rm sync node sync/src/cli.ts reconcile`.
import { depsFromEnv } from "./config.ts";
import { reconcile } from "./reconcile.ts";

const [command] = process.argv.slice(2);
const deps = await depsFromEnv({ server: false });
let exitCode = 0;
try {
  switch (command) {
    case "reconcile": {
      const report = await reconcile(deps);
      console.log(`Checked ${report.checked} linked Invoices; ${report.mismatches.length} mismatch(es).`);
      for (const m of report.mismatches) {
        const show = (a: (typeof m)["internal"]) =>
          "missing" in a ? "missing" : `total ${(a.totalCents / 100).toFixed(2)} balance ${(a.balanceCents / 100).toFixed(2)}`;
        console.log(`  ${m.docNumber}: internal ${show(m.internal)} | QBO ${show(m.qbo)}`);
      }
      exitCode = report.mismatches.length ? 1 : 0;
      break;
    }
    default:
      console.error("usage: cli.ts reconcile");
      exitCode = 2;
  }
} finally {
  await deps.pool.end();
}
process.exit(exitCode);
