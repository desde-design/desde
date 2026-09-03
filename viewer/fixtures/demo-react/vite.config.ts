/**
 * The demo prototype. One build, served from five places: `/p/demo/` in the
 * viewer's path mode, the root of a loopback port, the root of a subdomain,
 * `/` under the Editor's own Vite, and the copy the Editor materializes to
 * `~/.desde-demo/` on first launch.
 *
 * `base: "./"` is load-bearing, not a preference. The viewer serves prototypes
 * under `/p/{slug}/`. Vite's default `base: "/"` bakes root-absolute asset
 * URLs, which the serve layer then has to compensate for with a Referer-scoped
 * root fallback (see the viewer README, "Notes and current limits"). Relative
 * URLs need no compensation at all, and the demo's whole job is to be the case
 * that just works.
 *
 * NO `import { defineConfig } from "vite"`, and that is load-bearing too. The
 * Editor supplies its own Vite when it supervises a prototype (see
 * `editor-cli/src/hosts/vite/host.ts`), and the packaged demo gets a
 * production-only install (`scripts/build-server-package.mts`), so `vite` is
 * absent from this directory's node_modules there. A `defineConfig` import
 * has to RESOLVE from here when Vite loads the config. MEASURED on the demo
 * this one replaced: importing it made the materialized demo fail to boot with
 * "Cannot find package 'vite'", while every unit test still passed.
 * `defineConfig` is only a type helper; a plain exported object is identical at
 * runtime.
 *
 * No `@vitejs/plugin-react` for the same reason: Vite transforms `.tsx`
 * natively, the viewer's `vite build` needs nothing more, and the Editor
 * injects its own JSX source-tag plugin at serve time. The only cost is Fast
 * Refresh, which a demo does not need.
 */
const config = {
  base: "./",
  // Component names survive minification. The Viewer's inspector names a
  // component from its function name at runtime, and the production bundle
  // was showing the demo's Button as "di" (review finding, 2026-09-02).
  esbuild: { keepNames: true },
}

export default config
