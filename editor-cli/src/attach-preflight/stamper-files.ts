import type { RequiredStamperFile, StamperFramework } from './types.js'

/**
 * Where the bundled stampers live inside the prototype, and what the generated
 * config blocks assume about them.
 *
 * **Why inside the prototype at all.** "Add our plugin to your config"
 * presumes a published package. There isn't one: editor-cli's build script is
 * `build:ui` only and the plugins are TS source with no entry point. v1 keeps
 * distribution internal — the CLI writes a bundle into the prototype's
 * `.desde/stamp/` and the generated block imports it from there. No npm
 * publish, no new package to version, and the path never moves.
 *
 * **Why the factory takes no arguments.** The earlier spike passed
 * `{ repoRoot }` from the config file, which forces the block to compute its
 * own directory — and `import.meta.dirname` vs `__dirname` is not the same
 * expression across a `.mjs` Vite config, a jiti-loaded `nuxt.config.ts` and a
 * CJS `next.config.js`. The bundle sits at a known depth (`.desde/stamp/`)
 * so it can derive the repo root from its own location instead, and the block
 * shrinks to an import plus a call that is identical in every host.
 *
 * **Why two bundles and not one.** The Vue stamper module-scope imports
 * `@vue/compiler-sfc`; bundling both lanes into one file would drag the Vue
 * compiler into React-only projects, which is the exact defect `d98606ed`
 * fixed. One bundle per lane, chosen by the detected framework.
 */
export const STAMP_DIR = '.desde/stamp'

/**
 * The substring every generated block contains. Detection keys on this, so it
 * has to appear in the block verbatim and must not appear anywhere else by
 * accident.
 */
export const STAMP_MARKER = '.desde/stamp/'

export const VUE_PLUGIN_PATH = `${STAMP_DIR}/vue-source-tag.mjs`
export const JSX_PLUGIN_PATH = `${STAMP_DIR}/jsx-source-tag.mjs`
export const NEXT_LOADER_PATH = `${STAMP_DIR}/next-loader.cjs`

const VITE_PLUGIN_CONTRACT =
  'Default-exports a zero-argument factory returning a Vite plugin ' +
  "(`{ name, enforce: 'pre', apply: 'serve', transform(code, id) }`). The repo " +
  "root is derived from the file's own location (two directories up), not " +
  "passed in. `apply: 'serve'` is the production gate for this lane: without " +
  'it a `nuxt build` / `astro build` / `react-router build` stamps the output ' +
  'and ships source paths to end users, exactly as a Next build does without ' +
  'its phase gate.'

/** Files the Vite-hosted lanes (nuxt / astro / react-router / vite) need. */
export function vitePluginFiles(framework: StamperFramework): RequiredStamperFile[] {
  const isVue = framework === 'vue3'
  const path = isVue ? VUE_PLUGIN_PATH : JSX_PLUGIN_PATH
  return [
    {
      path,
      moduleFormat: 'esm',
      role: 'vite-plugin',
      stamper: framework,
      contract: `${VITE_PLUGIN_CONTRACT} Bundled from ${
        isVue ? 'editor-cli/src/plugins/source-tag-plugin.ts' : 'editor-cli/src/plugins/jsx-source-tag-plugin.ts'
      }.`,
    },
    {
      // A TypeScript config file that imports a bare `.mjs` fails typecheck
      // with TS7016 ("could not find a declaration file"), which breaks
      // `nuxt typecheck` / `vue-tsc` for anyone who runs it. The sibling
      // declaration is not optional polish.
      path: `${path.replace(/\.mjs$/, '')}.d.mts`,
      moduleFormat: 'esm',
      role: 'type-declaration',
      stamper: framework,
      contract:
        'Declares the default export as `() => { name: string; enforce: "pre"; ' +
        'transform(code: string, id: string): { code: string; map: null } | null }`. ' +
        'Self-contained — it must not import Vite types, which a prototype may not have installed.',
    },
  ]
}

/** File the Next lane needs. */
export function nextLoaderFiles(): RequiredStamperFile[] {
  return [
    {
      path: NEXT_LOADER_PATH,
      moduleFormat: 'cjs',
      role: 'webpack-loader',
      stamper: 'react',
      contract:
        'CommonJS webpack-style loader: `module.exports = function (source) { … }`, using ' +
        '`this.resourcePath` as the module id and deriving the repo root from `__dirname` ' +
        '(two directories up). Wraps the UNMODIFIED `jsxSourceTagPlugin(...).transform`, ' +
        'which is a pure (code, id) => code with no dependency on Vite plugin context. ' +
        'Must never throw: a stamping failure returns the source unchanged rather than ' +
        "breaking the user's dev server.",
    },
  ]
}
