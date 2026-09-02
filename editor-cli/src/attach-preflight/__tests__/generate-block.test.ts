import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  generateNextBlock,
  generateNextFullConfig,
  generateViteBlock,
  generateViteFullConfig,
  proxyHostname,
} from '../generate-block.js'

/** MEASURED from `next/constants` (16.3.0). */
const DEV_PHASE = 'phase-development-server'
const BUILD_PHASE = 'phase-production-build'

type Ctx = { defaultConfig: Record<string, unknown> }
type NextConfigLike = Record<string, unknown>
type Wrapper = (
  config: unknown,
) => (phase: string, ctx: Ctx) => NextConfigLike | Promise<NextConfigLike>

/**
 * Import the generated block as a real ES module and hand back its
 * `withDesde`.
 *
 * String-matching the block only proves it was *spelled* a certain way. Both
 * bugs this guards against — spreading a promise, and replacing a rule the user
 * already had — produce perfectly plausible-looking text, so the assertions
 * below run the thing instead.
 *
 * The only rewrite is the `next/constants.js` specifier, pointed at a local stub
 * so the suite needs no Next install. The import STATEMENT is left intact, so a
 * block that generated an unparseable import still fails here.
 */
async function loadWrapper(block: string): Promise<Wrapper> {
  const dir = mkdtempSync(join(tmpdir(), 'pt-next-block-'))
  writeFileSync(
    join(dir, 'next-constants-stub.mjs'),
    `export const PHASE_DEVELOPMENT_SERVER = '${DEV_PHASE}'\n`,
  )
  const source = block.replace("'next/constants.js'", "'./next-constants-stub.mjs'")
  const file = join(dir, 'block.mjs')
  writeFileSync(file, `${source}\nexport { withDesde }\n`)
  const mod = (await import(pathToFileURL(file).href)) as { withDesde: Wrapper }
  return mod.withDesde
}

const BLOCK_OPTS = { syntax: 'esm', typed: false, allowedDevHostnames: ['127.0.0.1'] } as const

async function resolveConfig(userConfig: unknown, phase = DEV_PHASE): Promise<NextConfigLike> {
  const withDesde = await loadWrapper(generateNextBlock(BLOCK_OPTS))
  return await withDesde(userConfig)(phase, { defaultConfig: {} })
}

describe('proxyHostname', () => {
  it.each([
    ['http://127.0.0.1:7411', '127.0.0.1'],
    ['https://127.0.0.1:7411/', '127.0.0.1'],
    ['127.0.0.1:7411', '127.0.0.1'],
    ['127.0.0.1', '127.0.0.1'],
    ['http://LOCALHOST:3000', 'localhost'],
    ['http://[::1]:7411', '::1'],
    ['[::1]:7411', '::1'],
    ['http://user:pass@10.0.0.4:7411/path?x=1', '10.0.0.4'],
    ['http://proto.local:7411/deep/path', 'proto.local'],
  ])('reduces %s to %s', (input, expected) => {
    expect(proxyHostname(input)).toBe(expected)
  })

  it('returns null for input with no host', () => {
    expect(proxyHostname('')).toBeNull()
    expect(proxyHostname('   ')).toBeNull()
    expect(proxyHostname('http://')).toBeNull()
  })
})

describe('generateNextBlock', () => {
  const base = { syntax: 'esm', typed: false, allowedDevHostnames: ['127.0.0.1'] } as const

  it('registers a loader rule for BOTH .tsx and .jsx', () => {
    // A *.tsx rule alone leaves .jsx unstamped, which is invisible until an
    // edit to a .jsx file is refused.
    const block = generateNextBlock(base)
    expect(block).toContain("'*.tsx': desdeRule(rules?.['*.tsx'])")
    expect(block).toContain("'*.jsx': desdeRule(rules?.['*.jsx'])")
  })

  it('gates on the Next phase, never on NODE_ENV', () => {
    const block = generateNextBlock(base)
    expect(block).toContain('if (phase !== PHASE_DEVELOPMENT_SERVER) return base')
    // NODE_ENV may be *named* in the explanatory comment, but must never be
    // the thing the gate compares.
    expect(block).not.toMatch(/if\s*\([^)]*NODE_ENV/)
    expect(block).not.toContain("process.env.NODE_ENV ===")
  })

  it('imports next/constants WITH the .js extension in ESM', () => {
    // Measured on Next 16.3.0: `next` ships no exports map, so native ESM
    // resolution of the extensionless specifier throws ERR_MODULE_NOT_FOUND.
    const block = generateNextBlock(base)
    expect(block).toContain("import { PHASE_DEVELOPMENT_SERVER } from 'next/constants.js'")
  })

  it('uses require() in a CommonJS config', () => {
    const block = generateNextBlock({ ...base, syntax: 'cjs' })
    expect(block).toContain("const { PHASE_DEVELOPMENT_SERVER } = require('next/constants')")
    expect(block).not.toContain('import {')
  })

  it('adds the NextConfig type import only for a typed config', () => {
    expect(generateNextBlock({ ...base, typed: true })).toContain(
      "import type { NextConfig } from 'next'",
    )
    expect(generateNextBlock(base)).not.toContain('import type')
  })

  it('lists allowedDevOrigins as bare hostnames, never host:port', () => {
    // Next parses the request Origin and compares `hostname` only, so an
    // entry carrying a port matches nothing.
    const block = generateNextBlock({ ...base, allowedDevHostnames: ['127.0.0.1', 'proto.local'] })
    const line = block.split('\n').find((l) => l.includes('allowedDevOrigins:'))
    expect(line).toBeDefined()
    expect(line).toContain("'127.0.0.1'")
    expect(line).toContain("'proto.local'")
    expect(line).not.toMatch(/'[^']*:\d+'/)
  })

  it('preserves any allowedDevOrigins the user already has', () => {
    expect(generateNextBlock(base)).toContain('...(base.allowedDevOrigins ?? [])')
  })

  it('threads a function-form config through the wrapper', () => {
    expect(generateNextBlock(base)).toContain(
      "desdeApply(phase, typeof config === 'function' ? config(phase, ctx) : config)",
    )
  })

  it('generates a whole file that wraps its own export', () => {
    const file = generateNextFullConfig(base)
    expect(file).toContain('export default withDesde(nextConfig)')
    const cjs = generateNextFullConfig({ ...base, syntax: 'cjs' })
    expect(cjs).toContain('module.exports = withDesde(nextConfig)')
  })
})

// The block is pasted into a config the user already owns, so every one of
// these shapes is a config that exists in the wild today. Verified against the
// real thing as well: each case below was loaded through Next 16.3.0's own
// `loadConfig` and produced the same resolved config.
describe('generateNextBlock — executed against real config shapes', () => {
  it('keeps a plain object config and adds our rules', async () => {
    const resolved = await resolveConfig({ reactStrictMode: true, basePath: '/app' })
    expect(resolved.reactStrictMode).toBe(true)
    expect(resolved.basePath).toBe('/app')
    expect(resolved.turbopack).toEqual({
      rules: {
        '*.tsx': { loaders: ['./.desde/stamp/next-loader.cjs'] },
        '*.jsx': { loaders: ['./.desde/stamp/next-loader.cjs'] },
      },
    })
    expect(resolved.allowedDevOrigins).toEqual(['127.0.0.1'])
  })

  it('calls a sync function config with the phase and ctx', async () => {
    const resolved = await resolveConfig((phase: string, ctx: Ctx) => ({
      env: { PHASE: phase, GOT_CTX: String(Boolean(ctx.defaultConfig)) },
    }))
    expect(resolved.env).toEqual({ PHASE: DEV_PHASE, GOT_CTX: 'true' })
  })

  it('does NOT spread an async function config into nothing', async () => {
    // The defect this replaces: `{ ...config(phase, ctx) }` on a promise is
    // `{}`, so the user's whole configuration vanished with no error — the
    // dev server booted on defaults and nothing said why.
    const resolved = await resolveConfig(async () => ({
      reactStrictMode: true,
      basePath: '/app',
      images: { unoptimized: true },
    }))
    expect(resolved.reactStrictMode).toBe(true)
    expect(resolved.basePath).toBe('/app')
    expect(resolved.images).toEqual({ unoptimized: true })
    expect(resolved.turbopack).toBeDefined()
  })

  it('accepts a promise-valued config export', async () => {
    // `export default Promise.resolve({…})` — Next awaits the export itself,
    // not only a function's return value.
    const resolved = await resolveConfig(Promise.resolve({ basePath: '/promised' }))
    expect(resolved.basePath).toBe('/promised')
    expect(resolved.allowedDevOrigins).toEqual(['127.0.0.1'])
  })

  it('stays synchronous for a synchronous config', async () => {
    // Next's own `validateTurboNextConfig` calls the exported config function
    // and reads `.turbopack` / `.webpack` off the result WITHOUT awaiting it,
    // so an unconditionally-async wrapper would blank out Next's Turbopack
    // config validation for every project.
    const withDesde = await loadWrapper(generateNextBlock(BLOCK_OPTS))
    const unawaited = withDesde({ webpack: () => ({}) })(DEV_PHASE, { defaultConfig: {} })
    expect(unawaited).not.toBeInstanceOf(Promise)
    expect((unawaited as NextConfigLike).turbopack).toBeDefined()
  })

  it('appends to a rule already declared in ARRAY form, preserving order and options', async () => {
    const resolved = await resolveConfig({
      turbopack: {
        rules: {
          '*.tsx': [{ loader: 'user-loader-a', options: { flavour: 'strawberry' } }, 'user-loader-b'],
          '*.svg': { loaders: ['@svgr/webpack'], as: '*.js' },
        },
      },
    })
    const rules = (resolved.turbopack as { rules: Record<string, unknown> }).rules
    expect(rules['*.tsx']).toEqual([
      { loader: 'user-loader-a', options: { flavour: 'strawberry' } },
      'user-loader-b',
      './.desde/stamp/next-loader.cjs',
    ])
    // An unrelated glob is carried through untouched.
    expect(rules['*.svg']).toEqual({ loaders: ['@svgr/webpack'], as: '*.js' })
  })

  it('appends to a rule already declared in OBJECT form, keeping as/condition/type', async () => {
    const resolved = await resolveConfig({
      turbopack: {
        root: '/somewhere',
        rules: {
          '*.jsx': {
            loaders: [{ loader: 'user-loader-a', options: { flavour: 'strawberry' } }],
            as: '*.js',
            condition: 'development',
          },
        },
      },
    })
    const turbopack = resolved.turbopack as { root: string; rules: Record<string, unknown> }
    expect(turbopack.rules['*.jsx']).toEqual({
      loaders: [
        { loader: 'user-loader-a', options: { flavour: 'strawberry' } },
        './.desde/stamp/next-loader.cjs',
      ],
      as: '*.js',
      condition: 'development',
    })
    // Sibling turbopack keys survive the merge too.
    expect(turbopack.root).toBe('/somewhere')
  })

  it('appends to allowedDevOrigins the user already has', async () => {
    const resolved = await resolveConfig({ allowedDevOrigins: ['already.example'] })
    expect(resolved.allowedDevOrigins).toEqual(['already.example', '127.0.0.1'])
  })

  it('adds nothing outside the development-server phase, async config included', async () => {
    const userConfig = {
      turbopack: { rules: { '*.tsx': ['user-loader-a'] } },
      allowedDevOrigins: ['already.example'],
    }
    for (const config of [userConfig, async () => userConfig]) {
      const resolved = await resolveConfig(config, BUILD_PHASE)
      expect(resolved).toEqual(userConfig)
    }
  })
})

describe('generateViteBlock', () => {
  it('targets nuxt vite.plugins with the Vue stamper', () => {
    const block = generateViteBlock({
      host: 'nuxt',
      framework: 'vue3',
      syntax: 'esm',
      configFileRelative: 'nuxt.config.ts',
    })
    expect(block).toContain("import desdeSourceTag from './.desde/stamp/vue-source-tag.mjs'")
    expect(block).toContain('`vite.plugins` array')
    expect(block).toContain('vite: {\n    plugins: [desdeSourceTag()],\n  },')
    expect(block).toContain('nuxt.config.ts')
  })

  it('targets the root plugins array with the JSX stamper for react-router', () => {
    const block = generateViteBlock({
      host: 'react-router',
      framework: 'react',
      syntax: 'esm',
      configFileRelative: 'vite.config.ts',
    })
    expect(block).toContain("import desdeSourceTag from './.desde/stamp/jsx-source-tag.mjs'")
    expect(block).toContain('`plugins` array')
    expect(block).toContain('plugins: [desdeSourceTag()')
    expect(block).toContain("enforce: 'pre'")
  })

  it('warns that astro stamps islands only', () => {
    const block = generateViteBlock({
      host: 'astro',
      framework: 'react',
      syntax: 'esm',
      configFileRelative: 'astro.config.mjs',
    })
    expect(block).toContain('.astro file has no stamper')
  })

  it('names the default export when the config is CommonJS', () => {
    const block = generateViteBlock({
      host: 'vite',
      framework: 'react',
      syntax: 'cjs',
      configFileRelative: 'vite.config.cjs',
    })
    expect(block).toContain("const desdeSourceTag = require('./.desde/stamp/jsx-source-tag.mjs').default")
  })

  it('states the production gate so nobody deletes it', () => {
    const block = generateViteBlock({
      host: 'nuxt',
      framework: 'vue3',
      syntax: 'esm',
      configFileRelative: 'nuxt.config.ts',
    })
    expect(block).toContain("apply: 'serve'")
  })

  it('generates a whole nuxt config when the project has none', () => {
    const file = generateViteFullConfig({
      host: 'nuxt',
      framework: 'vue3',
      syntax: 'esm',
      configFileRelative: 'nuxt.config.ts',
    })
    expect(file).toContain('export default defineNuxtConfig({')
    expect(file).toContain('plugins: [desdeSourceTag()]')
  })

  it('imports defineConfig in a generated astro config', () => {
    const file = generateViteFullConfig({
      host: 'astro',
      framework: 'react',
      syntax: 'esm',
      configFileRelative: 'astro.config.mjs',
    })
    expect(file).toContain("import { defineConfig } from 'astro/config'")
    expect(file).toContain('export default defineConfig({')
  })
})

/**
 * The attach proxy binds to localhost by default, and Next already trusts
 * `localhost` / `*.localhost` in dev. Emitting an allowedDevOrigins entry for
 * a host Next trusts anyway is one more line in the user's committed config
 * that can drift or confuse — so it is omitted.
 */
describe('generateNextBlock — allowedDevOrigins is omitted when Next already trusts the host', () => {
  const base = { syntax: 'esm' as const, typed: false }

  it('omits the key entirely for localhost', () => {
    const block = generateNextBlock({ ...base, allowedDevHostnames: ['localhost'] })
    expect(block).not.toContain('allowedDevOrigins')
  })

  it('omits it for a *.localhost subdomain', () => {
    const block = generateNextBlock({ ...base, allowedDevHostnames: ['app.localhost'] })
    expect(block).not.toContain('allowedDevOrigins')
  })

  it('STILL emits it for 127.0.0.1, which Next does not trust by default', () => {
    const block = generateNextBlock({ ...base, allowedDevHostnames: ['127.0.0.1'] })
    expect(block).toContain('allowedDevOrigins')
    expect(block).toContain("'127.0.0.1'")
  })

  it('keeps only the untrusted hosts when both are requested', () => {
    const block = generateNextBlock({ ...base, allowedDevHostnames: ['localhost', '127.0.0.1'] })
    expect(block).toContain("'127.0.0.1'")
    expect(block).not.toContain("'localhost'")
  })
})
