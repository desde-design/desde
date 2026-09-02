/**
 * `designSystems` declarations — design systems a Editor prototype's owner
 * has declared for onboarding, persisted in
 * `<repoRoot>/desde.config.json`.
 *
 * This is the config-block sibling of `read-roots.ts`: same file, same
 * read-modify-write discipline, same "malformed config is loud at boot"
 * posture for the *loader*. It differs from read-roots in one respect —
 * declaring a design system does no I/O beyond the config file itself (no
 * git/npm/network calls here); resolving a declaration into an installed,
 * extracted design system (cloning a repo, running npm install, walking
 * `.d.ts`) is the boot-reconciliation step's job, not this module's.
 *
 * On-disk schema is intentionally FLAT (friendlier to hand-author than a
 * nested `source` object):
 *
 * ```jsonc
 * { "designSystems": [
 *   { "kind": "installed", "package": "@acme/design-system" },
 *   { "kind": "npm", "spec": "@acme/ds@^2", "designSystem": "acme" },
 *   { "kind": "repo", "url": "https://github.com/acme/ds", "ref": "main",
 *     "subdir": "packages/ui", "allowBuild": true }
 * ] }
 * ```
 *
 * `loadDesignSystemDeclarations` reshapes each flat entry into the nested
 * `DesignSystemDeclaration` wire/API shape and validates it through
 * `validateDeclaration` — there is exactly one validation path, shared with
 * the launcher's `POST .../design-systems/declare` route (Phase 3 task 4),
 * which receives `DesignSystemDeclaration[]` directly (already nested) from
 * the client.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// `DesignSystemSource` is defined in the onboarding module, which itself
// only imports `FrameworkId`/`DesignSystemId` from `./manifest` (a
// zero-import, core-safe file) — so importing this *type* here does not
// create a core→onboarding→core runtime cycle. Kept as a type-only import
// so it's erased at compile time regardless.
import type { DesignSystemSource } from '@/editor/onboarding/types'

import { CONFIG_FILENAME } from './read-roots'

/** A design system declared for this prototype (not yet necessarily onboarded). */
export interface DesignSystemDeclaration {
  source: DesignSystemSource
  /** Display label override; defaults downstream to the package name. */
  designSystem?: string
  /** repo-kind only: permit running the repo's build (spec §7 trust boundary). Default true (local editor). */
  allowBuild?: boolean
}

export type LoadDeclarationsResult =
  | { ok: true; declarations: DesignSystemDeclaration[]; warnings: string[] }
  | { ok: false; errors: string[] }

function hasControlChar(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string }

function requireTrimmedString(value: unknown, field: string): ParseResult<string> {
  if (typeof value !== 'string') {
    return { ok: false, error: `${field} is required` }
  }
  if (hasControlChar(value)) {
    return { ok: false, error: `${field} contains control characters` }
  }
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    return { ok: false, error: `${field} is required` }
  }
  return { ok: true, value: trimmed }
}

function validateOptionalString(value: unknown, field: string): ParseResult<string> {
  if (typeof value !== 'string') {
    return { ok: false, error: `${field} must be a string` }
  }
  if (hasControlChar(value)) {
    return { ok: false, error: `${field} contains control characters` }
  }
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    return { ok: false, error: `${field} must not be empty` }
  }
  return { ok: true, value: trimmed }
}

function validateSource(raw: Record<string, unknown>): ParseResult<DesignSystemSource> {
  const kind = raw.kind
  if (kind === 'installed') {
    const pkg = requireTrimmedString(raw.package, 'source.package')
    if (!pkg.ok) return pkg
    return { ok: true, value: { kind: 'installed', package: pkg.value } }
  }
  if (kind === 'npm') {
    const spec = requireTrimmedString(raw.spec, 'source.spec')
    if (!spec.ok) return spec
    return { ok: true, value: { kind: 'npm', spec: spec.value } }
  }
  if (kind === 'repo') {
    const url = requireTrimmedString(raw.url, 'source.url')
    if (!url.ok) return url

    let ref: string | undefined
    if (raw.ref !== undefined) {
      const r = validateOptionalString(raw.ref, 'source.ref')
      if (!r.ok) return r
      ref = r.value
    }

    let subdir: string | undefined
    if (raw.subdir !== undefined) {
      const r = validateOptionalString(raw.subdir, 'source.subdir')
      if (!r.ok) return r
      subdir = r.value
    }

    return {
      ok: true,
      value: {
        kind: 'repo',
        url: url.value,
        ...(ref !== undefined ? { ref } : {}),
        ...(subdir !== undefined ? { subdir } : {}),
      },
    }
  }
  return { ok: false, error: `unknown source kind: ${JSON.stringify(kind)}` }
}

/**
 * Validate a value against the `DesignSystemDeclaration` wire shape
 * (`{ source: DesignSystemSource, designSystem?, allowBuild? }`). This is
 * the SINGLE validation path — the loader below reshapes flat on-disk
 * entries into this shape and calls this same function, and the launcher's
 * declare route (Phase 3 task 4) validates client-submitted declarations
 * with it directly.
 */
export function validateDeclaration(
  value: unknown,
): { ok: true; declaration: DesignSystemDeclaration } | { ok: false; error: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, error: 'declaration must be an object' }
  }
  const v = value as Record<string, unknown>

  if (typeof v.source !== 'object' || v.source === null || Array.isArray(v.source)) {
    return { ok: false, error: 'declaration.source must be an object' }
  }
  const sourceResult = validateSource(v.source as Record<string, unknown>)
  if (!sourceResult.ok) return sourceResult

  let designSystem: string | undefined
  if (v.designSystem !== undefined) {
    const r = validateOptionalString(v.designSystem, 'designSystem')
    if (!r.ok) return r
    designSystem = r.value
  }

  let allowBuild: boolean | undefined
  if (v.allowBuild !== undefined) {
    if (typeof v.allowBuild !== 'boolean') {
      return { ok: false, error: 'allowBuild must be a boolean' }
    }
    allowBuild = v.allowBuild
  }

  return {
    ok: true,
    declaration: {
      source: sourceResult.value,
      ...(designSystem !== undefined ? { designSystem } : {}),
      ...(allowBuild !== undefined ? { allowBuild } : {}),
    },
  }
}

/** Reshape a flat on-disk entry into the nested candidate `validateDeclaration` expects. */
function flatEntryToDeclarationCandidate(entry: Record<string, unknown>): unknown {
  const { kind, package: pkg, spec, url, ref, subdir, designSystem, allowBuild } = entry
  let source: unknown
  if (kind === 'installed') {
    source = { kind, package: pkg }
  } else if (kind === 'npm') {
    source = { kind, spec }
  } else if (kind === 'repo') {
    source = { kind, url, ref, subdir }
  } else {
    // Unknown kind — pass the whole entry through so validateSource
    // produces the "unknown source kind" error with the actual value.
    source = { kind }
  }
  return { source, designSystem, allowBuild }
}

/** Inverse of `flatEntryToDeclarationCandidate` — used when writing a new entry. */
function declarationToFlatEntry(decl: DesignSystemDeclaration): Record<string, unknown> {
  const { source } = decl
  const entry: Record<string, unknown> = { kind: source.kind }
  if (source.kind === 'installed') {
    entry.package = source.package
  } else if (source.kind === 'npm') {
    entry.spec = source.spec
  } else {
    entry.url = source.url
    if (source.ref !== undefined) entry.ref = source.ref
    if (source.subdir !== undefined) entry.subdir = source.subdir
  }
  if (decl.designSystem !== undefined) entry.designSystem = decl.designSystem
  if (decl.allowBuild !== undefined) entry.allowBuild = decl.allowBuild
  return entry
}

/**
 * Stable identity for dedupe/reconcile matching. installed/npm sources
 * collapse to the (version-stripped) package name — an `installed`
 * declaration and an `npm` declaration for the same package are the SAME
 * design system by identity. repo sources key on the url|ref|subdir triple
 * so different refs/subdirs of the same repo are distinct declarations.
 */
export function declarationIdentity(source: DesignSystemSource): string {
  if (source.kind === 'installed') return source.package.trim()
  if (source.kind === 'npm') return packageNameFromSpec(source.spec.trim())
  return `repo:${source.url.trim()}|${(source.ref ?? '').trim()}|${(source.subdir ?? '').trim()}`
}

/** Strip the version suffix from an npm spec (`'name@^2'` / `'@scope/name@^2'` → the bare package name). */
function packageNameFromSpec(spec: string): string {
  if (spec.startsWith('@')) {
    const secondAt = spec.indexOf('@', 1)
    return secondAt === -1 ? spec : spec.slice(0, secondAt)
  }
  const at = spec.indexOf('@')
  return at === -1 ? spec : spec.slice(0, at)
}

async function readConfigFile(absPath: string): Promise<Record<string, unknown> | null> {
  let text: string
  try {
    text = await readFile(absPath, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch (err) {
    throw new Error(`failed to parse: ${(err as Error).message}`)
  }
}

/**
 * Read the `designSystems` array from `<repoRoot>/desde.config.json`.
 * Missing file or missing block → `ok:true` with `[]` (unconfigured default,
 * same posture as `loadReadRoots`). A malformed config — bad JSON, a
 * non-array `designSystems`, or any entry that fails `validateDeclaration` —
 * fails the whole load with one error per problem: a broken config should be
 * loud at boot, same as read-roots.
 */
export async function loadDesignSystemDeclarations(repoRoot: string): Promise<LoadDeclarationsResult> {
  const configPath = join(repoRoot, CONFIG_FILENAME)

  let raw: Record<string, unknown> | null
  try {
    raw = await readConfigFile(configPath)
  } catch (err) {
    return { ok: false, errors: [`${CONFIG_FILENAME}: ${(err as Error).message}`] }
  }

  if (!raw || raw.designSystems === undefined) {
    return { ok: true, declarations: [], warnings: [] }
  }

  if (!Array.isArray(raw.designSystems)) {
    return { ok: false, errors: [`${CONFIG_FILENAME}: "designSystems" must be an array`] }
  }

  const declarations: DesignSystemDeclaration[] = []
  const errors: string[] = []

  raw.designSystems.forEach((entry: unknown, index: number) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      errors.push(`${CONFIG_FILENAME}: designSystems[${index}] must be an object`)
      return
    }
    const candidate = flatEntryToDeclarationCandidate(entry as Record<string, unknown>)
    const result = validateDeclaration(candidate)
    if (!result.ok) {
      errors.push(`${CONFIG_FILENAME}: designSystems[${index}]: ${result.error}`)
      return
    }
    declarations.push(result.declaration)
  })

  if (errors.length > 0) {
    return { ok: false, errors }
  }

  return { ok: true, declarations, warnings: [] }
}

/**
 * Append a declaration to the `designSystems` block (creating the file/block
 * if absent), preserving every other key untouched — a read-modify-write of
 * the parsed JSON, 2-space indent, trailing newline. Refuses when a
 * declaration with the same `declarationIdentity` already exists (existing
 * malformed entries are ignored for the dedupe check, not fatal here — the
 * loader is where a broken config gets reported loudly).
 */
export async function appendDesignSystemDeclaration(
  repoRoot: string,
  decl: DesignSystemDeclaration,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const validated = validateDeclaration(decl)
  if (!validated.ok) {
    return { ok: false, reason: validated.error }
  }

  const configPath = join(repoRoot, CONFIG_FILENAME)

  let parsed: Record<string, unknown>
  try {
    const existing = await readConfigFile(configPath)
    parsed = existing ?? {}
  } catch (err) {
    return { ok: false, reason: `${CONFIG_FILENAME}: ${(err as Error).message}` }
  }

  const existingRaw: unknown[] = Array.isArray(parsed.designSystems) ? parsed.designSystems : []

  const newIdentity = declarationIdentity(validated.declaration.source)
  for (const entry of existingRaw) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    const candidate = flatEntryToDeclarationCandidate(entry as Record<string, unknown>)
    const result = validateDeclaration(candidate)
    if (!result.ok) continue // malformed existing entries can't collide; loader reports them separately
    if (declarationIdentity(result.declaration.source) === newIdentity) {
      return { ok: false, reason: `a declaration for "${newIdentity}" already exists` }
    }
  }

  const flatEntry = declarationToFlatEntry(validated.declaration)
  const nextConfig: Record<string, unknown> = {
    ...parsed,
    designSystems: [...existingRaw, flatEntry],
  }

  await writeFile(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`, 'utf8')
  return { ok: true }
}

/**
 * Remove the declaration whose source identity matches `identity`.
 *
 * The counterpart to {@link appendDesignSystemDeclaration}, added 2026-08-18
 * for the project settings page. Removal existed only at editor scope before
 * that (`DELETE /api/editor/design-systems/:id`, which needs an open project);
 * the settings page edits a project the CLI has not booted, so it needs the
 * config-file half on its own.
 *
 * Matched on `declarationIdentity`, the same key `append` refuses duplicates
 * on, so what you can add is exactly what you can remove.
 *
 * **Malformed neighbours are preserved, not dropped.** An entry that fails
 * validation cannot match an identity and is written back untouched. Rewriting
 * only what parsed would silently delete a hand-edited entry the loader is
 * already reporting as an error, which turns "your config has a typo" into
 * "your config lost a line".
 */
export async function removeDesignSystemDeclaration(
  repoRoot: string,
  identity: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const configPath = join(repoRoot, CONFIG_FILENAME)

  let parsed: Record<string, unknown> | null
  try {
    parsed = await readConfigFile(configPath)
  } catch (err) {
    return { ok: false, reason: `${CONFIG_FILENAME}: ${(err as Error).message}` }
  }
  if (!parsed || !Array.isArray(parsed.designSystems)) {
    return { ok: false, reason: `no design system declared for "${identity}"` }
  }

  const kept = (parsed.designSystems as unknown[]).filter((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return true
    const result = validateDeclaration(
      flatEntryToDeclarationCandidate(entry as Record<string, unknown>),
    )
    if (!result.ok) return true
    return declarationIdentity(result.declaration.source) !== identity
  })

  if (kept.length === (parsed.designSystems as unknown[]).length) {
    return { ok: false, reason: `no design system declared for "${identity}"` }
  }

  await writeFile(configPath, `${JSON.stringify({ ...parsed, designSystems: kept }, null, 2)}\n`, 'utf8')
  return { ok: true }
}
