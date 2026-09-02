/**
 * Reference directories — the WRITER for the `readRoots` block in
 * `desde.config.json`.
 *
 * `read-roots.ts` is the reader: it resolves the block into a registry the
 * agent's tools consume, and it owns the name rules. This file is what the
 * launcher wizard and the in-editor settings dialog call to change the block.
 * The split matches `design-system-declarations.ts` sitting beside its own
 * consumers.
 *
 * Two differences from the design-systems writer worth knowing:
 *
 *   - `readRoots` is an OBJECT keyed by name, not an array. The name is the
 *     identity, so dedupe is a key lookup rather than a computed identity.
 *   - There is a `remove`. The settings dialog lets a user take a reference
 *     directory away again, which design systems never needed.
 *
 * Validation is deliberately duplicated in spirit but NOT in code: the name
 * rule comes from `read-roots.ts` so a name this writer accepts can never be a
 * name the loader rejects at the next boot.
 */

import { readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve as resolvePath } from 'node:path'

import {
  CONFIG_FILENAME,
  READ_ROOT_NAME_RE,
  RESERVED_READ_ROOT_NAMES,
} from './read-roots'

/** One reference directory, as written to (and read from) the config file. */
export interface ReadRootDeclaration {
  /** Slug the agent uses to reference this root in tool args. */
  name: string
  /** Absolute path, or a path relative to the repo root. */
  path: string
  /** Free-form note telling the agent what this directory is for. */
  description?: string
}

export type ValidateReadRootResult =
  | { ok: true; declaration: ReadRootDeclaration }
  | { ok: false; error: string }

export type LoadReadRootDeclarationsResult =
  | { ok: true; declarations: ReadRootDeclaration[] }
  | { ok: false; errors: string[] }

export type WriteReadRootResult = { ok: true } | { ok: false; reason: string }

/**
 * Control characters (including NUL) would corrupt a log line or a tool
 * argument. Written as a codepoint scan rather than a regex, matching
 * `design-system-declarations.ts` — a character-class regex for this range
 * has to embed literal control bytes in the source, which no reviewer can see.
 */
function hasControlChar(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

function validateString(
  value: unknown,
  field: string,
): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof value !== 'string') return { ok: false, error: `"${field}" must be a string` }
  if (hasControlChar(value)) {
    return { ok: false, error: `"${field}" must not contain control characters` }
  }
  const trimmed = value.trim()
  if (trimmed.length === 0) return { ok: false, error: `"${field}" must not be empty` }
  return { ok: true, value: trimmed }
}

/**
 * Shape-check one declaration. Shared by the HTTP routes and by
 * {@link loadReadRootDeclarations}, so the API and the file agree on what a
 * valid entry is.
 *
 * Note what is NOT checked here: whether the path exists, is a directory, or is
 * a git repo. Those are filesystem questions, they need I/O, and they are the
 * loader's job at boot. Keeping this function pure means the wizard can
 * validate a typed-in path without touching the disk.
 */
export function validateReadRootDeclaration(candidate: unknown): ValidateReadRootResult {
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    return { ok: false, error: 'declaration must be an object' }
  }
  const { name, path, description } = candidate as Record<string, unknown>

  const nameResult = validateString(name, 'name')
  if (!nameResult.ok) return { ok: false, error: nameResult.error }
  if (!READ_ROOT_NAME_RE.test(nameResult.value)) {
    return {
      ok: false,
      error: `invalid name "${nameResult.value}": must match ${READ_ROOT_NAME_RE.source}`,
    }
  }
  if (RESERVED_READ_ROOT_NAMES.has(nameResult.value)) {
    return { ok: false, error: `name "${nameResult.value}" is reserved` }
  }

  const pathResult = validateString(path, 'path')
  if (!pathResult.ok) return { ok: false, error: pathResult.error }

  let cleanDescription: string | undefined
  if (description !== undefined) {
    const descResult = validateString(description, 'description')
    if (!descResult.ok) return { ok: false, error: descResult.error }
    cleanDescription = descResult.value
  }

  return {
    ok: true,
    declaration: {
      name: nameResult.value,
      path: pathResult.value,
      ...(cleanDescription !== undefined ? { description: cleanDescription } : {}),
    },
  }
}

/**
 * The filesystem half of validation, which {@link validateReadRootDeclaration}
 * deliberately cannot do: does this path resolve to a directory, and is it a
 * directory we are allowed to declare?
 *
 * It exists because the loader has failure modes the shape check cannot see,
 * and two of them are FATAL at boot. A user who picks the prototype's own
 * folder passes every shape rule, gets written to the config, and then cannot
 * open the project again until they hand-edit JSON, because `loadReadRoots`
 * rejects a self-reference outright. Every write path must run this first.
 *
 * Kept separate from the shape validator rather than folded into it so the
 * validator stays pure and usable from the browser bundle.
 */
export async function checkReadRootPath(
  repoRoot: string,
  candidatePath: string,
): Promise<{ ok: true; absolute: string } | { ok: false; reason: string }> {
  const lexical = isAbsolute(candidatePath)
    ? candidatePath
    : resolvePath(repoRoot, candidatePath)

  let absolute: string
  try {
    absolute = await realpath(lexical)
  } catch {
    return { ok: false, reason: `Not found: ${lexical}` }
  }

  let info: Awaited<ReturnType<typeof stat>>
  try {
    info = await stat(absolute)
  } catch {
    return { ok: false, reason: `Not accessible: ${absolute}` }
  }
  if (!info.isDirectory()) {
    return { ok: false, reason: `Not a directory: ${absolute}` }
  }

  // Compared after resolving BOTH sides, since either can be reached through
  // a symlink and a string compare would miss it.
  const repoReal = await realpath(repoRoot).catch(() => resolvePath(repoRoot))
  if (absolute === repoReal) {
    return {
      ok: false,
      reason:
        "That is this project's own folder. The agent can already read it, so it does not need to be added as a reference.",
    }
  }

  return { ok: true, absolute }
}

/**
 * Turn a folder basename into a valid root name, avoiding any name already
 * taken. Pure — the wizard calls it to prefill the field before anything is
 * written.
 *
 * `Billing Web (prod)` → `billing-web-prod`. A basename with nothing usable in
 * it (`___`) falls back to `ref`, because an empty name is not writable and
 * silently dropping the entry would be worse than an ugly default.
 */
export function suggestReadRootName(basename: string, taken: readonly string[] = []): string {
  const slug = basename
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^[^a-z]+/, '') // the rule requires a leading letter
    .slice(0, 31)

  const base = slug.length > 0 ? slug : 'ref'
  const takenSet = new Set([...taken, ...RESERVED_READ_ROOT_NAMES])
  if (!takenSet.has(base)) return base

  for (let i = 2; i < 1000; i += 1) {
    // Trim the stem so the suffix can never push the name past the length cap.
    const suffix = `-${i}`
    const candidate = `${base.slice(0, 31 - suffix.length)}${suffix}`
    if (!takenSet.has(candidate)) return candidate
  }
  return base
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

/** The raw block as stored: `{ "<name>": { path, description? } }`. */
function readRootsBlock(parsed: Record<string, unknown>): Record<string, unknown> {
  const block = parsed.readRoots
  if (typeof block !== 'object' || block === null || Array.isArray(block)) return {}
  return block as Record<string, unknown>
}

/**
 * Read the `readRoots` block. Missing file or missing block → `ok:true` with
 * `[]`, the unconfigured default. A malformed block fails the whole load with
 * one error per problem, matching `loadDesignSystemDeclarations`.
 */
export async function loadReadRootDeclarations(
  repoRoot: string,
): Promise<LoadReadRootDeclarationsResult> {
  const configPath = join(repoRoot, CONFIG_FILENAME)

  let parsed: Record<string, unknown> | null
  try {
    parsed = await readConfigFile(configPath)
  } catch (err) {
    return { ok: false, errors: [`${CONFIG_FILENAME}: ${(err as Error).message}`] }
  }

  if (!parsed || parsed.readRoots === undefined) {
    return { ok: true, declarations: [] }
  }
  if (typeof parsed.readRoots !== 'object' || parsed.readRoots === null || Array.isArray(parsed.readRoots)) {
    return { ok: false, errors: [`${CONFIG_FILENAME}: "readRoots" must be an object`] }
  }

  const declarations: ReadRootDeclaration[] = []
  const errors: string[] = []

  for (const [name, entry] of Object.entries(parsed.readRoots as Record<string, unknown>)) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      errors.push(`${CONFIG_FILENAME}: readRoots."${name}" must be an object`)
      continue
    }
    const { path, description } = entry as Record<string, unknown>
    const result = validateReadRootDeclaration({ name, path, description })
    if (!result.ok) {
      errors.push(`${CONFIG_FILENAME}: readRoots."${name}": ${result.error}`)
      continue
    }
    declarations.push(result.declaration)
  }

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, declarations }
}

/**
 * Add one reference directory, creating the file and block if absent, and
 * leaving every other key untouched — a read-modify-write of the parsed JSON,
 * 2-space indent, trailing newline.
 *
 * Refuses when the name is already taken. It does NOT refuse a duplicate
 * *path*: the loader already treats two names for one path as a warning rather
 * than an error, and there are real reasons to want it (two descriptions
 * pointing at different parts of one monorepo).
 */
export async function appendReadRoot(
  repoRoot: string,
  decl: ReadRootDeclaration,
): Promise<WriteReadRootResult> {
  const validated = validateReadRootDeclaration(decl)
  if (!validated.ok) return { ok: false, reason: validated.error }

  const configPath = join(repoRoot, CONFIG_FILENAME)

  let parsed: Record<string, unknown>
  try {
    parsed = (await readConfigFile(configPath)) ?? {}
  } catch (err) {
    return { ok: false, reason: `${CONFIG_FILENAME}: ${(err as Error).message}` }
  }

  const block = readRootsBlock(parsed)
  const { name, path, description } = validated.declaration
  if (Object.prototype.hasOwnProperty.call(block, name)) {
    return { ok: false, reason: `a reference directory named "${name}" already exists` }
  }

  const nextConfig: Record<string, unknown> = {
    ...parsed,
    readRoots: {
      ...block,
      [name]: { path, ...(description !== undefined ? { description } : {}) },
    },
  }

  await writeFile(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`, 'utf8')
  return { ok: true }
}

/**
 * Remove one reference directory by name. Refuses when the name is absent,
 * rather than reporting a no-op as success — the caller is a UI that should say
 * "that is already gone" instead of appearing to have done something.
 *
 * When the last entry is removed the `readRoots` key is dropped entirely, so
 * the file returns to its unconfigured shape rather than keeping an empty
 * object around.
 */
export async function removeReadRoot(
  repoRoot: string,
  name: string,
): Promise<WriteReadRootResult> {
  const configPath = join(repoRoot, CONFIG_FILENAME)

  let parsed: Record<string, unknown> | null
  try {
    parsed = await readConfigFile(configPath)
  } catch (err) {
    return { ok: false, reason: `${CONFIG_FILENAME}: ${(err as Error).message}` }
  }
  if (!parsed) return { ok: false, reason: `no reference directory named "${name}"` }

  const block = readRootsBlock(parsed)
  if (!Object.prototype.hasOwnProperty.call(block, name)) {
    return { ok: false, reason: `no reference directory named "${name}"` }
  }

  const nextBlock = { ...block }
  delete nextBlock[name]

  const nextConfig: Record<string, unknown> = { ...parsed }
  if (Object.keys(nextBlock).length === 0) {
    delete nextConfig.readRoots
  } else {
    nextConfig.readRoots = nextBlock
  }

  await writeFile(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`, 'utf8')
  return { ok: true }
}
