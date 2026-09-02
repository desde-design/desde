import { describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createGroundingService } from './create-grounding-service'

const MISSING_ROOT = '/no/such/prototype/root'

describe('createGroundingService', () => {
  it('resolves all sources against a missing root without throwing', async () => {
    const g = createGroundingService({ root: MISSING_ROOT })
    // No node_modules at the root → null manifest, [] tokens.
    expect(await g.getManifestSource()).toBeNull()
    expect(await g.tokens.listTokens()).toEqual([])
    expect(await g.tokens.getToken('--acme-color-background-primary')).toBeNull()
  })

  it('memoizes the manifest source (same promise across calls)', () => {
    const g = createGroundingService({ root: MISSING_ROOT })
    expect(g.getManifestSource()).toBe(g.getManifestSource())
  })

  it('getGroundingHealth resolves null before the manifest source has been built', async () => {
    const g = createGroundingService({ root: MISSING_ROOT })
    expect(await g.getGroundingHealth()).toBeNull()
  })

  it('getGroundingHealth resolves the health of the built bundle after getManifestSource resolves', async () => {
    const g = createGroundingService({ root: MISSING_ROOT })
    await g.getManifestSource()
    const health = await g.getGroundingHealth()
    // A missing root means buildManifestSource returns null (no bundle built)
    // — health stays null too, since there's nothing to report.
    expect(health).toBeNull()
  })

  it('getGroundingHealth resolves a real report once a real root has been built', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cgs-'))
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '0.0.0' }))
    const g = createGroundingService({ root })
    expect(await g.getGroundingHealth()).toBeNull()
    await g.getManifestSource()
    const health = await g.getGroundingHealth()
    expect(health?.root).toBe(await fs.realpath(root))
    expect(health?.sources.length).toBeGreaterThan(0)
  })

  it('tokens.listTokens() resolves via the deferred builder against a tmp fixture', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cgs-tokens-'))
    await fs.writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'fixture', version: '0.0.0' }),
    )
    await fs.writeFile(
      path.join(root, 'tokens.css'),
      ':root {\n  --color-primary: #0044f4;\n}',
    )

    const g = createGroundingService({ root })
    // `tokens` is a synchronous DesignTokenSource value even though the
    // discovery + composition it wraps (`buildDesignTokenSources`) is async —
    // the DeferredDesignTokenSource defers that work to this first call.
    const tokens = await g.tokens.listTokens()

    expect(tokens.find((t) => t.name === '--color-primary')).toMatchObject({
      value: '#0044f4',
      source: 'app-stylesheets',
    })
  })
})
