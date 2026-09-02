import { fileURLToPath } from "node:url"
import { jsxSourceTagPlugin } from "../../plugins/jsx-source-tag-plugin.js"

/**
 * Bundle entry for `.desde/stamp/jsx-source-tag.mjs` — the React lane's
 * Vite plugin. Same contract as the Vue entry beside it; see its docblock for
 * why the factory takes no arguments and why `apply: 'serve'` is load-bearing.
 *
 * Kept as a SEPARATE bundle from the Vue one rather than a single file with a
 * flag: the Vue stamper module-scope imports `@vue/compiler-sfc`, so one shared
 * bundle would drag the Vue compiler into React-only projects.
 */
export default function desdeSourceTag() {
  return { ...jsxSourceTagPlugin({ repoRoot: repoRootFromHere() }), apply: "serve" as const }
}

function repoRootFromHere(): string {
  return fileURLToPath(new URL("../../", import.meta.url))
}
