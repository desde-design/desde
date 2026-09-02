import { defineConfig } from "vitest/config"
import react from "@vitejs/plugin-react"
import path from "path"

export default defineConfig({
  plugins: [react()],
  test: {
    /*
      MEASURED 2026-08-24 on an otherwise idle machine. This suite had NO
      `testTimeout`, so it ran on vitest's 5s default while `editor-cli` sets
      30s and `viewer` sets 20s. Nothing chose 5s for it; it was the value
      nobody set.

      5s is not enough. Running this suite while the other two run — routine,
      since concurrent sessions share this checkout — five tests failed. Idle
      and loaded times, both taken with these budgets in place so nothing is
      cut short by its own cap:

        inspector-panel   refreshes on every successive edit      278ms ->  5,585ms  (20.1x)
        dormant-lanes     does not wire the Detach action       1,567ms ->  6,661ms   (4.3x)
        build-manifest    two packages both exporting Button    1,269ms ->  6,399ms   (5.0x)
        build-manifest    hints-cache overlays                  1,333ms ->  4,860ms   (3.6x)
        gallery registry  renders every modal and inline state  8,326ms -> 46,013ms   (5.5x)

      None of them is slow for a bad reason: they are real React renders and
      real TypeScript extraction into tmpdirs. The budget was the defect.

      Note the first row. At 278ms idle it had 94% headroom and would have
      passed any margin review, then went 20x under load. Headroom analysis
      alone does not find these; only running the suite under load does.

      An earlier version of this table reported 609ms / 2,057ms / 2,898ms /
      4,147ms / 22,935ms for the idle column. Those were taken while a runaway
      background process held a core at 99%, which inflated the baseline by
      roughly 2-3x and UNDERSTATED every multiplier. Corrected above. The
      lesson is in tasks/lessons.md: a measurement without its machine
      condition is not a measurement.

      20s matches the viewer. The gallery sweep keeps its own larger
      override — see that file for why it is a growing cost.
    */
    testTimeout: 20_000,

    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test-setup.ts"],
    // Ignore Next's standalone build output — `next build` copies source files
    // (including *.test.ts) into .next/standalone, which vitest would then
    // double-discover.
    //
    // editor-cli/ is also excluded — the CLI is a sibling package with its
    // own vitest config (editor-cli/vitest.config.ts for unit, .smoke
    // config for the slow browser smoke). Crawling its tests from the parent
    // would run them under THIS config (different test-setup, different
    // exclude rules) which doesn't match the CLI's expectations.
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/editor-cli/**",
      "**/viewer/**",
      // desktop/ is a sibling package with its own vitest config
      // (desktop/vitest.config.mts) — same reasoning as editor-cli/ above.
      "**/desktop/**",
      // `.claude/worktrees/**` holds other sessions' git worktrees. Their
      // `src/` matches the include globs, so a root run collects THEIR tests
      // and runs them against THIS tree — failures that belong to nobody and
      // reproduce nowhere (a worktree predating the Composer → Editor rename
      // still importing `src/composer-ui/` is the obvious case). Excluded so
      // `npm test` reports on this checkout only.
      "**/.claude/worktrees/**",
    ],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
})
