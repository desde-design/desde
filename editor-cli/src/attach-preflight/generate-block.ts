import type { ModuleSyntax } from './config-file.js'
import { JSX_PLUGIN_PATH, NEXT_LOADER_PATH, VUE_PLUGIN_PATH } from './stamper-files.js'
import type { AttachHost, StamperFramework } from './types.js'

/**
 * The config text the user pastes. Pure string building — no fs, no process
 * state — so every variant is unit-testable without a real project.
 *
 * The blocks carry their own comments and those comments are load-bearing.
 * Each one records a measurement that made the line necessary; without them
 * the next person to touch a generated config removes the `*.jsx` rule as
 * redundant, or "simplifies" the phase gate to `NODE_ENV`, and the failure
 * that follows is silent in both cases.
 */

const OPEN = '// ─── Desde attach mode ──────────────────────────────────'
const CLOSE = '// ─── end Desde ──────────────────────────────────────────'

export interface NextBlockOptions {
  syntax: ModuleSyntax
  typed: boolean
  /**
   * Hostnames (never host:port) to add to `allowedDevOrigins`. See
   * `proxyHostname` for why the port is stripped before it gets here.
   */
  allowedDevHostnames: readonly string[]
}

/**
 * Reduce whatever the caller has — a full origin, a host:port, a bare
 * hostname — to the hostname Next actually compares against.
 *
 * MEASURED against Next 16.3.0's own source
 * (`server/lib/router-utils/block-cross-site-dev.js` →
 * `app-render/csrf-protection.js`): the request's `Origin` header is parsed and
 * only `parsedOrigin.hostname` is compared, so an `allowedDevOrigins` entry
 * containing a port can never match anything. The earlier spike listed
 * `"127.0.0.1:7131"` and appeared to work — because Next's built-in defaults
 * (`localhost`, `**.localhost`, plus the dev server's own hostname) covered the
 * case, not because the entry did.
 */
export function proxyHostname(origin: string): string | null {
  let value = origin.trim()
  if (!value) return null
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
  // Strip credentials, then any path/query/fragment.
  const at = value.lastIndexOf('@')
  if (at !== -1) value = value.slice(at + 1)
  value = value.split(/[/?#]/)[0]
  if (!value) return null
  // IPv6 literal: `[::1]:7411` → `::1`.
  if (value.startsWith('[')) {
    const end = value.indexOf(']')
    return end === -1 ? null : value.slice(1, end).toLowerCase() || null
  }
  const colon = value.indexOf(':')
  const host = colon === -1 ? value : value.slice(0, colon)
  return host ? host.toLowerCase() : null
}

/**
 * Hostnames Next already trusts in dev, so an `allowedDevOrigins` entry for
 * them is dead weight in the user's committed config.
 *
 * MEASURED (Next 16.3, no `allowedDevOrigins` configured at all): an internal
 * endpoint answers 200 to `Origin: http://localhost:9999` and 403 to
 * `Origin: http://127.0.0.1:9999`. The default list is
 * `['**.localhost', 'localhost']` (`block-cross-site-dev.js`), so `localhost`
 * and any `*.localhost` subdomain need nothing.
 */
function isDefaultTrustedDevHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname.endsWith('.localhost')
}

export function generateNextBlock(opts: NextBlockOptions): string {
  const { syntax, typed } = opts
  const requested =
    opts.allowedDevHostnames.length > 0 ? opts.allowedDevHostnames : ['127.0.0.1']
  // Emit the key ONLY for hosts Next does not already trust. The attach proxy
  // binds to localhost by default precisely so this list comes out empty and
  // the user's config carries one less line that can be wrong.
  const hostnames = requested.filter((h) => !isDefaultTrustedDevHost(h.toLowerCase()))
  const hostList = hostnames.map((h) => `'${h}'`).join(', ')

  const imports =
    syntax === 'esm'
      ? [
          ...(typed ? ["import type { NextConfig } from 'next'"] : []),
          // MEASURED on Next 16.3.0: `next` publishes no `exports` map, so a
          // native-ESM bare specifier only resolves WITH the extension —
          // `from 'next/constants'` throws ERR_MODULE_NOT_FOUND.
          "import { PHASE_DEVELOPMENT_SERVER } from 'next/constants.js'",
        ].join('\n')
      : "const { PHASE_DEVELOPMENT_SERVER } = require('next/constants')"

  // Type annotations are the ONLY difference between the two variants — the
  // runtime bodies below are shared verbatim, so a fix cannot land in one lane
  // and miss the other.
  const t = typed
    ? {
        decls: `
/** Whatever \`turbopack.rules\` maps a glob to — see the two shapes in \`desdeRule\`. */
type DesdeRule = NonNullable<NonNullable<NextConfig['turbopack']>['rules']>[string]

type DesdeNextConfig =
  | NextConfig
  | Promise<NextConfig>
  | ((phase: string, ctx: { defaultConfig: NextConfig }) => NextConfig | Promise<NextConfig>)
`,
        thenableSig: '(value: unknown): value is Promise<NextConfig>',
        thenableBody: "return typeof (value as { then?: unknown } | null | undefined)?.then === 'function'",
        ruleSig: '(existing: DesdeRule | undefined): DesdeRule',
        applySig:
          '(\n  phase: string,\n  base: NextConfig | Promise<NextConfig>,\n): NextConfig | Promise<NextConfig>',
        withSig: 'config: DesdeNextConfig',
        wrappedSig: '(phase: string, ctx: { defaultConfig: NextConfig })',
      }
    : {
        decls: '',
        thenableSig: '(value)',
        thenableBody: "return typeof value?.then === 'function'",
        ruleSig: '(existing)',
        applySig: '(phase, base)',
        withSig: 'config',
        wrappedSig: '(phase, ctx)',
      }

  return `${OPEN}
// Stamps data-desde-src="file:line:col" on every JSX element so the Editor can map
// a click in the running app back to the exact line of source. Without it the
// prototype is inspect-only and every edit is refused.
${imports}

const DESDE_LOADER = './${NEXT_LOADER_PATH}'
${t.decls}
/**
 * A config export may be asynchronous — \`export default async (phase) => …\`,
 * or a promise-valued export. MEASURED on Next 16.3.0
 * (\`server/config-shared.js\` → \`normalizeConfig\`): the function form is
 * invoked and its result is \`await\`ed, so handing a promise back from here is
 * supported. SPREADING one is not — \`{ ...promise }\` is \`{}\`, which drops the
 * user's entire configuration without an error.
 */
function desdeIsThenable${t.thenableSig} {
  ${t.thenableBody}
}

/**
 * Merge our loader into whatever the config already declares for a glob.
 * Assigning \`{ loaders: [DESDE_LOADER] }\` outright would drop the user's
 * own loaders for that glob, and the failure is silent — their transform just
 * stops running.
 *
 * Both shapes Next accepts are handled (MEASURED from
 * \`TurbopackRuleConfigCollection\` in \`next/dist/server/config-shared.d.ts\`,
 * 16.3.0): a LIST of loader items and/or rule objects, or a single rule OBJECT
 * whose \`loaders\` sits alongside \`as\` / \`condition\` / \`type\`. Ours is
 * appended, so existing entries keep their order and their options, and the
 * object form is spread so its sibling keys survive.
 */
function desdeRule${t.ruleSig} {
  if (Array.isArray(existing)) return [...existing, DESDE_LOADER]
  if (existing) return { ...existing, loaders: [...(existing.loaders ?? []), DESDE_LOADER] }
  return { loaders: [DESDE_LOADER] }
}

/**
 * The gate is the PHASE Next passes in — NOT process.env.NODE_ENV.
 *
 * This loader lives in a committed config file, so it runs during \`next build\`
 * too, and a stamped production build ships internal file paths and line
 * numbers to end users (MEASURED: 34 data-desde-src attributes in the prerendered
 * HTML). NODE_ENV cannot close that: it is ambient, and a CI runner that
 * exports NODE_ENV=development re-enables the leak. The phase argument comes
 * from Next itself and nothing in the environment can forge it.
 */
function desdeApply${t.applySig} {
  if (desdeIsThenable(base)) return base.then((resolved) => desdeApply(phase, resolved))
  if (phase !== PHASE_DEVELOPMENT_SERVER) return base
  const rules = base.turbopack?.rules
  return {
    ...base,
    turbopack: {
      ...base.turbopack,
      rules: {
        ...rules,
        // BOTH extensions are required. MEASURED: a '*.tsx' rule on its own
        // leaves every .jsx file unstamped, and an unstamped file fails
        // silently — the app boots, the element is inspectable, and only the
        // edit is refused.
        '*.tsx': desdeRule(rules?.['*.tsx']),
        '*.jsx': desdeRule(rules?.['*.jsx']),
      },
    },
${
    hostnames.length === 0
      ? ''
      : `    // MEASURED: Next 16 dev answers 403 to an INTERNAL (/_next, /__nextjs)
    // request carrying an Origin header from a host it does not recognise, and
    // attach mode puts the browser on the proxy's origin. Entries are compared
    // against the origin's HOSTNAME with the port discarded, so an entry like
    // '127.0.0.1:7411' matches nothing — list the bare hostname.
    allowedDevOrigins: [...(base.allowedDevOrigins ?? []), ${hostList}],\n`
  }
  }
}

/**
 * Synchronous in, synchronous out — this wrapper is deliberately NOT \`async\`.
 * MEASURED on Next 16.3.0: \`next dev\` runs \`validateTurboNextConfig\`
 * (\`lib/turbopack-warning.js\`, reached from \`server/lib/start-server.js\`),
 * which calls the exported config function and reads \`.turbopack\` /
 * \`.webpack\` off the result WITHOUT awaiting it. An unconditionally async
 * wrapper makes both reads \`undefined\` for every project and silently
 * disables Next's own Turbopack config validation.
 */
function withDesde(${t.withSig}) {
  return ${t.wrappedSig} =>
    desdeApply(phase, typeof config === 'function' ? config(phase, ctx) : config)
}
${CLOSE}`
}

/** A complete `next.config` for a project that has none. */
export function generateNextFullConfig(opts: NextBlockOptions): string {
  const block = generateNextBlock(opts)
  const decl = opts.typed
    ? 'const nextConfig: NextConfig = {}'
    : '/** @type {import(\'next\').NextConfig} */\nconst nextConfig = {}'
  const exp = opts.syntax === 'esm' ? 'export default withDesde(nextConfig)' : 'module.exports = withDesde(nextConfig)'
  return `${block}\n\n${decl}\n\n${exp}\n`
}

export interface ViteBlockOptions {
  host: Exclude<AttachHost, 'next'>
  framework: StamperFramework
  syntax: ModuleSyntax
  configFileRelative: string
}

/** Where the plugin call has to go, per host. */
const PLUGIN_ARRAY: Record<Exclude<AttachHost, 'next'>, string> = {
  nuxt: 'vite.plugins',
  astro: 'vite.plugins',
  'react-router': 'plugins',
  vite: 'plugins',
}

export function generateViteBlock(opts: ViteBlockOptions): string {
  const pluginPath = opts.framework === 'vue3' ? VUE_PLUGIN_PATH : JSX_PLUGIN_PATH
  const importLine =
    opts.syntax === 'esm'
      ? `import desdeSourceTag from './${pluginPath}'`
      : // A CJS config requiring an ESM bundle: Vite/Nuxt/Astro all pre-bundle
        // the config with esbuild, which inlines the relative import, and Node
        // >= 22.12 can require() ESM directly. Either way the namespace comes
        // back, so the default export needs naming explicitly.
        `const desdeSourceTag = require('./${pluginPath}').default`

  const arrayPath = PLUGIN_ARRAY[opts.host]
  const nested = arrayPath.includes('.')

  const arraySnippet = nested
    ? `  vite: {\n    plugins: [desdeSourceTag()],\n  },`
    : `  plugins: [desdeSourceTag(), /* …your existing plugins… */],`

  const astroNote =
    opts.host === 'astro'
      ? `\n//    NOTE: this stamps framework islands (.jsx/.tsx/.vue) only. Markup\n//    written directly in a .astro file has no stamper and stays inspect-only.`
      : ''

  const orderNote = nested
    ? `\n//    Create the \`vite\` block if the config does not have one yet.`
    : `\n//    Position in the array does not matter. The plugin is enforce: 'pre'.`

  return `${OPEN}
// Stamps data-desde-src="file:line:col" so the Editor can map a click in the
// running app back to the exact line of source. The plugin declares
// \`apply: 'serve'\`, so it is inert in a production build and cannot ship
// source paths to end users — the leak that the Next lane needs an explicit
// phase gate to avoid.
//
// 1. Add this import at the top of ${opts.configFileRelative}:
${importLine}

// 2. Add desdeSourceTag() to the \`${arrayPath}\` array:${orderNote}${astroNote}
${arraySnippet}
${CLOSE}`
}

/**
 * A complete `nuxt.config` / `astro.config` for a project that has none.
 *
 * Narrowed to those two hosts deliberately: the body writes a nested
 * `vite: { plugins }`, which is right for a framework config and wrong for a
 * root `vite.config`. Those hosts are also the only ones `canCreateConfig`
 * allows, so the type keeps a future caller from reaching a shape that would
 * boot and silently stamp nothing.
 */
export function generateViteFullConfig(
  opts: ViteBlockOptions & { host: 'nuxt' | 'astro' },
): string {
  const pluginPath = opts.framework === 'vue3' ? VUE_PLUGIN_PATH : JSX_PLUGIN_PATH
  const importLine =
    opts.syntax === 'esm'
      ? `import desdeSourceTag from './${pluginPath}'`
      : `const desdeSourceTag = require('./${pluginPath}').default`
  const defineCall = opts.host === 'nuxt' ? 'defineNuxtConfig' : 'defineConfig'
  const astroImport =
    opts.host === 'astro'
      ? opts.syntax === 'esm'
        ? "import { defineConfig } from 'astro/config'\n"
        : "const { defineConfig } = require('astro/config')\n"
      : ''
  const exp = opts.syntax === 'esm' ? 'export default' : 'module.exports ='
  return `// Desde attach mode: stamps data-desde-src so the Editor can map a click in
// the running app back to source. The plugin declares \`apply: 'serve'\`, so a
// production build never sees it and never ships source paths to end users.
${astroImport}${importLine}

${exp} ${defineCall}({
  vite: {
    plugins: [desdeSourceTag()],
  },
})
`
}
