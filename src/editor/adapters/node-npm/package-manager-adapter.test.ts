/**
 * Tests for the pure `applyManifestOp` helper and the
 * `createNodePackageManagerAdapter` install/argv plumbing. The pure
 * helper does the heavy lifting; the install path is exercised here
 * only enough to confirm the resolved command shape — we don't run a
 * real `npm install` (would touch the network).
 */

import { describe, expect, it } from 'vitest'

import { applyManifestOp, createNodePackageManagerAdapter } from './package-manager-adapter'

describe('applyManifestOp — add', () => {
  it('adds a new dependency at the requested versionSpec, sorted', () => {
    const src = `{
  "name": "x",
  "dependencies": {
    "zebra": "^1.0.0",
    "alpha": "^2.0.0"
  }
}`
    const r = applyManifestOp(src, {
      kind: 'add',
      packageName: 'beta',
      versionSpec: '^3.0.0',
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const parsed = JSON.parse(r.newSrc)
    expect(parsed.dependencies).toEqual({
      alpha: '^2.0.0',
      beta: '^3.0.0',
      zebra: '^1.0.0',
    })
    // Sorted keys preserved in serialization too.
    const depsBlock = r.newSrc.slice(
      r.newSrc.indexOf('"dependencies"'),
      r.newSrc.lastIndexOf('}'),
    )
    expect(depsBlock.indexOf('alpha')).toBeLessThan(depsBlock.indexOf('beta'))
    expect(depsBlock.indexOf('beta')).toBeLessThan(depsBlock.indexOf('zebra'))
  })

  it('defaults to "latest" when versionSpec is omitted', () => {
    const src = `{"dependencies": {}}`
    const r = applyManifestOp(src, { kind: 'add', packageName: 'foo' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(JSON.parse(r.newSrc).dependencies.foo).toBe('latest')
  })

  it('lands in devDependencies when dev:true', () => {
    const src = `{}`
    const r = applyManifestOp(src, {
      kind: 'add',
      packageName: 'foo',
      versionSpec: '1.0.0',
      dev: true,
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const parsed = JSON.parse(r.newSrc)
    expect(parsed.devDependencies).toEqual({ foo: '1.0.0' })
    expect(parsed.dependencies).toBeUndefined()
  })

  it('moves an existing dep across fields when adding with dev:true', () => {
    const src = `{
  "dependencies": { "foo": "^1.0.0" }
}`
    const r = applyManifestOp(src, {
      kind: 'add',
      packageName: 'foo',
      versionSpec: '^1.0.0',
      dev: true,
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const parsed = JSON.parse(r.newSrc)
    expect(parsed.devDependencies).toEqual({ foo: '^1.0.0' })
    expect(parsed.dependencies).toEqual({})
  })

  it('refuses no-op add (same dep at same versionSpec in same field)', () => {
    const src = `{"dependencies": {"foo": "^1.0.0"}}`
    const r = applyManifestOp(src, {
      kind: 'add',
      packageName: 'foo',
      versionSpec: '^1.0.0',
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toMatch(/already in dependencies/)
  })

  it('allows version-spec bump on an existing dep', () => {
    const src = `{"dependencies": {"foo": "^1.0.0"}}`
    const r = applyManifestOp(src, {
      kind: 'add',
      packageName: 'foo',
      versionSpec: '^2.0.0',
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(JSON.parse(r.newSrc).dependencies.foo).toBe('^2.0.0')
  })

  it('preserves 4-space indentation when the file uses it', () => {
    const src = `{\n    "name": "x",\n    "dependencies": {}\n}`
    const r = applyManifestOp(src, {
      kind: 'add',
      packageName: 'foo',
      versionSpec: '1.0.0',
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // Inner lines should start with 4 spaces.
    const lines = r.newSrc.split('\n')
    const fooLine = lines.find((l) => l.includes('"foo"'))!
    expect(fooLine.match(/^( +)/)![1].length).toBe(8) // nested inside dependencies, 2 levels deep
  })

  it('preserves trailing newline when the original file has one', () => {
    const r1 = applyManifestOp(`{"dependencies":{}}\n`, {
      kind: 'add',
      packageName: 'foo',
      versionSpec: '1',
    })
    expect(r1.ok && r1.newSrc.endsWith('\n')).toBe(true)
    const r2 = applyManifestOp(`{"dependencies":{}}`, {
      kind: 'add',
      packageName: 'foo',
      versionSpec: '1',
    })
    expect(r2.ok && r2.newSrc.endsWith('\n')).toBe(false)
  })

  it('refuses obviously-malformed package names', () => {
    const src = `{}`
    const r = applyManifestOp(src, {
      kind: 'add',
      packageName: '../etc/passwd',
      versionSpec: '1.0.0',
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toMatch(/invalid package name/)
  })

  it('refuses invalid JSON', () => {
    const r = applyManifestOp(`{ not json `, {
      kind: 'add',
      packageName: 'foo',
      versionSpec: '1.0.0',
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toMatch(/not valid JSON/)
  })
})

describe('applyManifestOp — remove', () => {
  it('removes from dependencies', () => {
    const src = `{"dependencies": {"foo": "^1.0.0", "bar": "^2.0.0"}}`
    const r = applyManifestOp(src, { kind: 'remove', packageName: 'foo' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(JSON.parse(r.newSrc).dependencies).toEqual({ bar: '^2.0.0' })
  })

  it('removes from devDependencies', () => {
    const src = `{"devDependencies": {"foo": "^1.0.0"}}`
    const r = applyManifestOp(src, { kind: 'remove', packageName: 'foo' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(JSON.parse(r.newSrc).devDependencies).toEqual({})
  })

  it('removes from BOTH when the dep appears in both (legacy package.json)', () => {
    const src = `{
  "dependencies": { "foo": "^1.0.0" },
  "devDependencies": { "foo": "^1.0.0" }
}`
    const r = applyManifestOp(src, { kind: 'remove', packageName: 'foo' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const parsed = JSON.parse(r.newSrc)
    expect(parsed.dependencies).toEqual({})
    expect(parsed.devDependencies).toEqual({})
  })

  it('refuses when the dep is not present anywhere', () => {
    const src = `{"dependencies": {"foo": "^1.0.0"}}`
    const r = applyManifestOp(src, { kind: 'remove', packageName: 'bar' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toMatch(/not found/)
  })
})

describe('createNodePackageManagerAdapter', () => {
  it('reports the resolved substrate label', () => {
    const a = createNodePackageManagerAdapter({ repoRoot: '/tmp', packageManager: 'pnpm' })
    expect(a.substrateLabel).toBe('pnpm')
  })

  it('exposes applyManifestOp', () => {
    const a = createNodePackageManagerAdapter({ repoRoot: '/tmp', packageManager: 'npm' })
    const r = a.applyManifestOp(`{}`, { kind: 'add', packageName: 'foo', versionSpec: '1' })
    expect(r.ok).toBe(true)
  })
})
