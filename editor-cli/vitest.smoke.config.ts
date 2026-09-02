import { defineConfig } from "vitest/config"

/**
 * Browser-driven smoke test config. Runs only the files in
 * `src/__smoke__/`, which boot the CLI in-process and drive a real
 * Chromium via Playwright. Slow (30-45s) and requires Chrome
 * installed at /Applications/Google Chrome.app — excluded from
 * default `npm test`. Run with `npm run test:smoke`.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/__smoke__/**/*.test.ts"],
    // Each smoke test boots a fresh CLI + browser. Force serial.
    fileParallelism: false,
    pool: "forks",
    testTimeout: 60_000,
    hookTimeout: 30_000,
  },
})
