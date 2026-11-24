// Operator commands, e.g. `docker compose run --rm sync node sync/src/cli.ts reconcile`.
import { backfill } from "./backfill.ts";
import { depsFromEnv } from "./config.ts";
import { reconcile } from "./reconcile.ts";

const [command, ...flags] = process.argv.slice(2);
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
    case "backfill": {
      // Queues hints only; the running sync service's worker does the linking.
      const report = await backfill(deps, { createMissing: flags.includes("--create-missing") });
      console.log(
        `Hinted ${report.hinted} Invoices (${report.pairs} same-DocNumber pairs). ` +
          `Skipped one-sided: ${report.skippedOneSided.internal} internal, ${report.skippedOneSided.qbo} QBO` +
          (report.skippedOneSided.internal + report.skippedOneSided.qbo ? " (use --create-missing to copy them)." : "."),
      );
      break;
    }
    case "qbo-ids": {
      // The ids ACCOUNT_MAPPING needs: Items for revenue categories, deposit accounts for payment methods.
      for (const i of await deps.qbo.query("Item")) console.log(`Item     ${i.Id.padStart(5)}  ${i.Name} (${i.Type})`);
      for (const a of await deps.qbo.query("Account")) {
        if (["Bank", "Other Current Asset"].includes(a.AccountType)) console.log(`Account  ${a.Id.padStart(5)}  ${a.Name} (${a.AccountSubType ?? a.AccountType})`);
      }
      break;
    }
    default:
      console.error("usage: cli.ts reconcile | backfill [--create-missing] | qbo-ids");
      exitCode = 2;
  }
} finally {
  await deps.pool.end();
}
process.exit(exitCode);
