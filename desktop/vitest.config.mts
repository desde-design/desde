import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    include: ["__tests__/**/*.test.ts"],
    exclude: ["**/node_modules/**", "dist/**"],
    // child.test.ts spawns real (tiny, fake-payload) Node child processes and
    // waits out real SIGTERM grace periods — generous but bounded.
    testTimeout: 20_000,
  },
})
