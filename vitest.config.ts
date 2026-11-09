import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts", "tests/integration/**/*.test.ts"],
    environment: "node",
    hookTimeout: 120_000,
    testTimeout: 30_000,
    // Integration files share one database; run files serially.
    fileParallelism: false,
  },
});
