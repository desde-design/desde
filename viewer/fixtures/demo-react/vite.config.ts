import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

/**
 * `base: "./"` is load-bearing, not a preference.
 *
 * The viewer serves prototypes under `/p/{slug}/`. Vite's default
 * `base: "/"` bakes root-absolute asset URLs, which the serve layer then has
 * to compensate for with a Referer-scoped root fallback (see the viewer
 * README, "Notes and current limits"). Relative URLs need no compensation at
 * all, and the demo's whole job is to be the case that just works.
 */
export default defineConfig({
  base: "./",
  plugins: [react()],
  // Component names survive minification. The Viewer's inspector names a
  // component from its function name at runtime, and the production bundle
  // was showing the demo's Button as "di" (review finding, 2026-09-02).
  esbuild: { keepNames: true },
})
