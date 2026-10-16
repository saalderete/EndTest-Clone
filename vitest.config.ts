import { defineConfig } from "vitest/config";
import path from "node:path";

// Tests run against a real PostgreSQL database named by TEST_DATABASE_URL
// (default: postgres://postgres@localhost:5432/testharvest_test). The global
// setup drops and re-creates it, then applies every migration.
const url = process.env.TEST_DATABASE_URL ?? "postgres://postgres@localhost:5432/testharvest_test";

export default defineConfig({
  resolve: {
    alias: {
      "@shared": path.resolve(import.meta.dirname, "shared"),
      "@": path.resolve(import.meta.dirname, "client", "src"),
    },
  },
  test: {
    globalSetup: ["tests/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 90_000,
    hookTimeout: 90_000,
    env: {
      NODE_ENV: "test",
      DATABASE_URL: url,
      APP_URL: "http://localhost:5000",
      APP_ENCRYPTION_KEY: "dGVzdGhhcnZlc3QtdGVzdC1rZXktbm90LWZvci1wcm8=",
      SESSION_SECRET: "test-session-secret-test-session-secret-0123456789",
      ALLOW_PRIVATE_NETWORK: "true",
      NOTIFICATIONS_ENABLED: "false",
      ARTIFACT_DIR: path.resolve(import.meta.dirname, "data/test-artifacts"),
      WORKER_CONCURRENCY: "2",
      WORKSPACE_MAX_CONCURRENCY: "4",
      LOG_LEVEL: "error",
      RUN_SCHEDULER: "false",
    },
  },
});
