import { configDefaults, defineConfig } from "vitest/config";

// Test files share one real Postgres database, so they run one at a time.
// The web console has its own package and test run (web/).
export default defineConfig({ test: { fileParallelism: false, exclude: [...configDefaults.exclude, "web/**"] } });
