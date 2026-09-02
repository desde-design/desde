/**
 * Tests for `scanInstalledReactLibraries` — the bounded React auto-scan.
 * Pure filesystem fixtures under a tmpdir; no real TS checker involved
 * (`discoverReactDtsEntries` only reads `package.json` + checks file
 * existence).
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { scanInstalledReactLibraries } from './auto-scan'

const tmpDirs: string[] = []

async function mkPrototype(deps: Record<string, string> = {}): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'react-auto-scan-'))
  tmpDirs.push(root)
  await fs.writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'fixture', version: '0.0.0', dependencies: deps }),
  )
  return root
}

async function addPackage(
  prototypeRoot: string,
  packageName: string,
  pkgJson: Record<string, unknown>,
  entryFile = 'index.d.ts',
  entryContent = 'export declare const Widget: () => null;\n',
): Promise<void> {
  const pkgRoot = path.join(prototypeRoot, 'node_modules', ...packageName.split('/'))
  await fs.mkdir(pkgRoot, { recursive: true })
  await fs.writeFile(
    path.join(pkgRoot, 'package.json'),
    JSON.stringify({ name: packageName, version: '1.0.0', types: entryFile, ...pkgJson }),
  )
  await fs.writeFile(path.join(pkgRoot, entryFile), entryContent)
}

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })))
})

describe('scanInstalledReactLibraries', () => {
  it('finds a declared dep with react in peerDependencies and a resolvable types entry', async () => {
    const root = await mkPrototype({ 'acme-react-ui': '^1.0.0' })
    await addPackage(root, 'acme-react-ui', { peerDependencies: { react: '^18.0.0' } })

    const found = await scanInstalledReactLibraries(root)

    expect(found).toHaveLength(1)
    expect(found[0].packageName).toBe('acme-react-ui')
    expect(found[0].packageRoot).toBe(path.join(root, 'node_modules/acme-react-ui'))
    expect(found[0].entryFiles).toEqual([
      path.join(root, 'node_modules/acme-react-ui/index.d.ts'),
    ])
  })

  it('excludes a declared dep that does not depend on react', async () => {
    const root = await mkPrototype({ 'acme-utils': '^1.0.0' })
    await addPackage(root, 'acme-utils', { dependencies: { lodash: '^4.0.0' } })

    expect(await scanInstalledReactLibraries(root)).toEqual([])
  })

  it('excludes @types/* packages even when they declare react', async () => {
    const root = await mkPrototype({ '@types/react': '^18.0.0' })
    await addPackage(root, '@types/react', { peerDependencies: { react: '^18.0.0' } })

    expect(await scanInstalledReactLibraries(root)).toEqual([])
  })

  it('does not scan node_modules packages the prototype does not declare', async () => {
    const root = await mkPrototype({}) // nothing declared
    await addPackage(root, 'undeclared-react-ui', { peerDependencies: { react: '^18.0.0' } })

    expect(await scanInstalledReactLibraries(root)).toEqual([])
  })

  it('returns [] when node_modules is missing entirely', async () => {
    const root = await mkPrototype({ 'acme-react-ui': '^1.0.0' })
    // No node_modules directory created at all.

    expect(await scanInstalledReactLibraries(root)).toEqual([])
  })

  it('sorts results by packageName', async () => {
    const root = await mkPrototype({ zeta: '^1.0.0', alpha: '^1.0.0' })
    await addPackage(root, 'zeta', { peerDependencies: { react: '^18.0.0' } })
    await addPackage(root, 'alpha', { peerDependencies: { react: '^18.0.0' } })

    const found = await scanInstalledReactLibraries(root)
    expect(found.map((f) => f.packageName)).toEqual(['alpha', 'zeta'])
  })
})
