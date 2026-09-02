import { defineConfig } from "vitest/config"
import { fileURLToPath } from "node:url"

export default defineConfig({
  resolve: {
    alias: {
      // The CLI imports src/editor modules that use the `@/` alias (e.g. the
      // onboarding + manifest pipeline). Mirror the runtime resolution so those
      // tests can load the real modules instead of failing at import.
      "@": fileURLToPath(new URL("../src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "ui-src/__tests__/**/*.test.ts"],
    // Browser smoke (src/__smoke__/) takes ~30-45s and requires Chrome
    // installed at /Applications/Google Chrome.app. Excluded from
    // default `npm test`; run with `npm run test:smoke`.
    exclude: ["**/node_modules/**", "src/__smoke__/**"],
    testTimeout: 30_000,
    env: {
      // No test in this suite may launch a real browser.
      //
      // The exclude above already says that about `src/__smoke__/`, but one
      // path defeated it from inside the product: the mini-turn edit lane
      // calls `createReviewSurface()`, which probes by launching and closing
      // a headless Chromium (`canLaunchReviewSurface`) and then launches a
      // second one. Any test that reaches that lane with a truthy `viteUrl`
      // pays for both, aimed at a dev server that isn't running.
      //
      // MEASURED: 1.4s for that pair on an idle machine, 26s under the full
      // parallel suite. `http-server-mini-turn-lock` has a 30s budget, so it
      // passed alone and timed out in the full run. The port race this was
      // first blamed on was not the cause.
      //
      // `off` is the product's own documented switch (`isReviewSurfaceEnabled`,
      // src/review-surface/index.ts), so this changes no product code and the
      // agent falls back to the live iframe exactly as it does for a user
      // with no launchable browser.
      EDITOR_REVIEW_SURFACE: "off",
    },
  },
})
