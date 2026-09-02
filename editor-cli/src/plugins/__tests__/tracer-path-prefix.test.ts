import { describe, expect, it } from "vitest"
import { computeTracerPathPrefix } from "../tracer-plugin.js"

/**
 * Pins the tracer's path-prefix math in both root layouts.
 *
 * WHY THIS EXISTS. `vite-plugin-vue-tracer` hardcodes
 * `relative(process.cwd(), id)`. On 2026-08-08 `core.ts` started chdir-ing to
 * the prototype's Vite root, so that a user `vite.config.ts` calling
 * `process.cwd()` — the canonical Vite idiom, and the thing that made
 * vue-element-plus-admin fail to serve — resolves against the prototype rather
 * than the Desde checkout.
 *
 * That flipped what the tracer emits: from "launch-cwd relative, needing a
 * long `../../…` STRIP" to "Vite-root relative, needing a `<subdir>/`
 * PREPEND". Both directions yield a plausible path, so getting it backwards
 * does not throw — it attributes an edit to the WRONG FILE, silently. The boot
 * smoke asserts `data-desde-src` is PRESENT, not that its prefix is right, so it
 * passes either way.
 *
 * The value is published to the browser as
 * `window.__DESDE_TRACER_PATH_PREFIX__` and consumed by
 * `src/bridge/tracer-attribution.ts`.
 */
describe("computeTracerPathPrefix", () => {
  it("is empty when the Vite root IS the repo root — the normal single-package case", () => {
    // The tracer already emits `src/App.vue`, which is exactly what
    // `data-desde-src` emits. Any non-empty prefix here would corrupt every path.
    expect(computeTracerPathPrefix("/abs/prototype", "/abs/prototype")).toBe("")
  })

  it("is `<subdir>/` when the prototype is a package inside a larger repo", () => {
    // `editor-cli/self-host` is the in-repo example of this layout.
    expect(
      computeTracerPathPrefix("/abs/repo", "/abs/repo/editor-cli/self-host"),
    ).toBe("editor-cli/self-host/")
    expect(computeTracerPathPrefix("/abs/repo", "/abs/repo/app")).toBe("app/")
  })

  it("refuses to emit a `../` prefix when the Vite root is above the repo root", () => {
    // Not a supported layout. Prepending "../" to every path would corrupt
    // every attribution, so degrade to a no-op instead.
    expect(computeTracerPathPrefix("/abs/repo/nested", "/abs/repo")).toBe("")
    expect(computeTracerPathPrefix("/abs/repo/a/b", "/abs/other")).toBe("")
  })

  it("normalizes separators so the browser-side startsWith/prepend is posix", () => {
    // The bridge compares against forward-slash paths from the tracer (which
    // uses `pathe`). A backslash here would make the prepend a silent no-op.
    const prefix = computeTracerPathPrefix("/abs/repo", "/abs/repo/pkg/app")
    expect(prefix).toBe("pkg/app/")
    expect(prefix).not.toContain("\\")
  })
})
