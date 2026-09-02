import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runStampingPreflight } from '../preflight.js'

let root: string

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'pt-attach-preflight-'))
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

async function write(rel: string, contents: string): Promise<void> {
  await fs.writeFile(join(root, rel), contents, 'utf8')
}

describe('runStampingPreflight — needs-config', () => {
  it('targets an existing next.config.mjs and offers a pasteable block', async () => {
    await write('package.json', '{"name":"x"}')
    await write('next.config.mjs', 'const nextConfig = {}\nexport default nextConfig\n')

    const result = await runStampingPreflight({
      prototypeRoot: root,
      host: 'next',
      framework: 'react',
      proxyOrigin: 'http://127.0.0.1:7411',
    })

    expect(result.status).toBe('needs-config')
    if (result.status !== 'needs-config') return
    expect(result.configFileRelative).toBe('next.config.mjs')
    expect(result.configFileExists).toBe(true)
    expect(result.block).toContain("import { PHASE_DEVELOPMENT_SERVER }")
    expect(result.block).toContain("'*.jsx'")
    expect(result.steps.join(' ')).toContain('withDesde(nextConfig)')
    expect(result.requiredStamperFiles.map((f) => f.path)).toEqual([
      '.desde/stamp/next-loader.cjs',
    ])
  })

  it('generates the typed block for a next.config.ts', async () => {
    await write('package.json', '{"name":"x"}')
    await write('next.config.ts', 'export default {}\n')

    const result = await runStampingPreflight({ prototypeRoot: root, host: 'next', framework: 'react' })
    expect(result.status).toBe('needs-config')
    if (result.status !== 'needs-config') return
    expect(result.configFileRelative).toBe('next.config.ts')
    expect(result.block).toContain("import type { NextConfig } from 'next'")
  })

  it('names the file the framework itself would load when several exist', async () => {
    // Next, Vite and c12 all prefer .js over .ts. Naming the TypeScript one
    // would send the user to edit a file nothing reads.
    await write('package.json', '{"name":"x"}')
    await write('next.config.ts', 'export default {}\n')
    await write('next.config.mjs', 'export default {}\n')
    await write('next.config.js', 'module.exports = {}\n')

    const result = await runStampingPreflight({ prototypeRoot: root, host: 'next', framework: 'react' })
    if (result.status !== 'needs-config') throw new Error('expected needs-config')
    expect(result.configFileRelative).toBe('next.config.js')
  })

  it('never offers to edit a next.config.cjs, which Next does not read', async () => {
    await write('package.json', '{"name":"x"}')
    await write('next.config.cjs', 'module.exports = {}\n')

    const result = await runStampingPreflight({ prototypeRoot: root, host: 'next', framework: 'react' })
    if (result.status !== 'needs-config') throw new Error('expected needs-config')
    // Falls through to creating the file Next WILL read.
    expect(result.configFileRelative).toBe('next.config.mjs')
    expect(result.configFileExists).toBe(false)
  })

  it('uses the proxy hostname, with the port stripped', async () => {
    await write('package.json', '{"name":"x"}')
    await write('next.config.mjs', 'export default {}\n')

    const result = await runStampingPreflight({
      prototypeRoot: root,
      host: 'next',
      framework: 'react',
      proxyOrigin: 'http://proto.local:7412',
    })
    if (result.status !== 'needs-config') throw new Error('expected needs-config')
    expect(result.block).toContain("'proto.local'")
    expect(result.block).not.toContain('7412')
  })

  it('writes a whole next.config when the project has none', async () => {
    await write('package.json', '{"name":"x"}')

    const result = await runStampingPreflight({ prototypeRoot: root, host: 'next', framework: 'react' })
    expect(result.status).toBe('needs-config')
    if (result.status !== 'needs-config') return
    // No tsconfig.json → .mjs, which is unambiguous whatever package.json#type says.
    expect(result.configFileRelative).toBe('next.config.mjs')
    expect(result.configFileExists).toBe(false)
    expect(result.block).toContain('export default withDesde(nextConfig)')
    expect(result.steps[0]).toContain('Create next.config.mjs')
  })

  it('creates a .ts config for a TypeScript project', async () => {
    await write('package.json', '{"name":"x"}')
    await write('tsconfig.json', '{}')

    const result = await runStampingPreflight({ prototypeRoot: root, host: 'nuxt', framework: 'vue3' })
    if (result.status !== 'needs-config') throw new Error('expected needs-config')
    expect(result.configFileRelative).toBe('nuxt.config.ts')
    expect(result.block).toContain('defineNuxtConfig')
  })

  it('emits CommonJS for a bare .js config in a non-module package', async () => {
    await write('package.json', '{"name":"x"}')
    await write('next.config.js', 'module.exports = {}\n')

    const result = await runStampingPreflight({ prototypeRoot: root, host: 'next', framework: 'react' })
    if (result.status !== 'needs-config') throw new Error('expected needs-config')
    expect(result.block).toContain("require('next/constants')")
  })

  it('emits ESM for a bare .js config when package.json says type: module', async () => {
    await write('package.json', '{"name":"x","type":"module"}')
    await write('next.config.js', 'export default {}\n')

    const result = await runStampingPreflight({ prototypeRoot: root, host: 'next', framework: 'react' })
    if (result.status !== 'needs-config') throw new Error('expected needs-config')
    expect(result.block).toContain("from 'next/constants.js'")
  })

  it('picks the Vue stamper for nuxt and the JSX stamper for react-router', async () => {
    await write('package.json', '{"name":"x"}')
    await write('nuxt.config.ts', 'export default defineNuxtConfig({})\n')
    await write('vite.config.ts', 'export default {}\n')

    const nuxt = await runStampingPreflight({ prototypeRoot: root, host: 'nuxt', framework: 'vue3' })
    if (nuxt.status !== 'needs-config') throw new Error('expected needs-config')
    expect(nuxt.requiredStamperFiles.map((f) => f.path)).toEqual([
      '.desde/stamp/vue-source-tag.mjs',
      '.desde/stamp/vue-source-tag.d.mts',
    ])

    const rr = await runStampingPreflight({
      prototypeRoot: root,
      host: 'react-router',
      framework: 'react',
    })
    if (rr.status !== 'needs-config') throw new Error('expected needs-config')
    expect(rr.configFileRelative).toBe('vite.config.ts')
    expect(rr.requiredStamperFiles.map((f) => f.path)).toEqual([
      '.desde/stamp/jsx-source-tag.mjs',
      '.desde/stamp/jsx-source-tag.d.mts',
    ])
  })

  it('tells the user to commit the stamper alongside the config', async () => {
    await write('package.json', '{"name":"x"}')
    await write('vite.config.ts', 'export default {}\n')
    const result = await runStampingPreflight({ prototypeRoot: root, host: 'vite', framework: 'react' })
    if (result.status !== 'needs-config') throw new Error('expected needs-config')
    expect(result.steps.join(' ')).toContain('.git/info/exclude')
  })
})

describe('runStampingPreflight — already-wired', () => {
  it('recognises its own block and reports no warnings', async () => {
    await write('package.json', '{"name":"x"}')
    await write(
      'vite.config.ts',
      "import desdeSourceTag from './.desde/stamp/jsx-source-tag.mjs'\nexport default { plugins: [desdeSourceTag()] }\n",
    )
    const result = await runStampingPreflight({
      prototypeRoot: root,
      host: 'react-router',
      framework: 'react',
    })
    expect(result.status).toBe('already-wired')
    if (result.status !== 'already-wired') return
    expect(result.marker).toBe('.desde/stamp/')
    expect(result.warnings).toEqual([])
  })

  it('reports a wired-but-leaking Next config rather than staying silent', async () => {
    await write('package.json', '{"name":"x"}')
    await write(
      'next.config.mjs',
      [
        "const loader = './.desde/stamp/next-loader.cjs'",
        'export default {',
        "  turbopack: { rules: { '*.tsx': { loaders: [loader] } } },",
        '}',
      ].join('\n'),
    )
    const result = await runStampingPreflight({ prototypeRoot: root, host: 'next', framework: 'react' })
    if (result.status !== 'already-wired') throw new Error('expected already-wired')
    // Three separate defects, each of which is silent at boot.
    expect(result.warnings).toHaveLength(3)
    expect(result.warnings.join(' ')).toContain("no '*.jsx' entry")
    expect(result.warnings.join(' ')).toContain('PHASE_DEVELOPMENT_SERVER')
    expect(result.warnings.join(' ')).toContain('allowedDevOrigins')
  })
})

describe('runStampingPreflight — no-config-file', () => {
  it('refuses to invent a root vite.config', async () => {
    await write('package.json', '{"name":"x"}')
    const result = await runStampingPreflight({
      prototypeRoot: root,
      host: 'react-router',
      framework: 'react',
    })
    expect(result.status).toBe('no-config-file')
    if (result.status !== 'no-config-file') return
    expect(result.searched).toHaveLength(6)
    // Vite's own DEFAULT_CONFIG_FILES order: .js first.
    expect(result.searched[0].endsWith('vite.config.js')).toBe(true)
    expect(result.message).toContain('not a shape we can wire')
  })
})
