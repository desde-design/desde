import { fileURLToPath } from "node:url"
import { sourceTagPlugin } from "../../plugins/source-tag-plugin.js"

/**
 * Bundle entry for `.desde/stamp/vue-source-tag.mjs` — the Vue SFC
 * stamper the user adds to their OWN Vite-hosted config in attach mode.
 *
 * The exported factory takes no arguments on purpose. The earlier spike passed
 * `{ repoRoot }` from the config file, which forces the generated block to
 * compute its own directory — and `import.meta.dirname` vs `__dirname` is not
 * the same expression across a `.mjs` Vite config, a jiti-loaded
 * `nuxt.config.ts` and a CJS `next.config.js`. The bundle sits at a known depth
 * instead, so it derives the root from its own location and the pasted block
 * shrinks to an import plus a call.
 *
 * `apply: 'serve'` is the production gate for this lane. Without it a
 * `nuxt build` / `astro build` / `react-router build` stamps the output and
 * ships internal source paths to end users — the same leak the Next lane needs
 * an explicit phase gate to avoid.
 */
export default function desdeSourceTag() {
  return { ...sourceTagPlugin({ repoRoot: repoRootFromHere() }), apply: "serve" as const }
}

/**
 * Two directories up from this file: `<root>/.desde/stamp/x.mjs` →
 * `<root>`. `data-desde-src` paths are relative to it, and the Editor resolves
 * them against the same root, so the two must agree — which is why attach mode
 * refuses a prototype that is a SUBDIRECTORY of its git repo (see
 * `assertStampableLayout` in core.ts).
 */
function repoRootFromHere(): string {
  return fileURLToPath(new URL("../../", import.meta.url))
}
