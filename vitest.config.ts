import { defineConfig } from "vitest/config";

// Test files share one real Postgres database, so they run one at a time.
export default defineConfig({ test: { fileParallelism: false } });
