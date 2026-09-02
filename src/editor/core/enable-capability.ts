/**
 * Turning a curated capability on — the only writer of `.mcp.json`.
 *
 * The agent is denied write access to this file (see `PROTECTED_CONFIG_FILES`
 * in `edit-ack.ts`), because it decides which subprocesses run. This module is
 * the user's path instead: it takes a catalog **id**, looks the spec up in
 * source, and merges it in. Nothing about the spawned command ever comes from
 * a request body.
 *
 * Writes preserve every key they don't understand, so a hand-written
 * `.mcp.json` — or one written by Claude Code, which reads the same file —
 * survives untouched.
 */

import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { findCapability, type CapabilityDescriptor } from './capability-catalog'

const MCP_FILENAME = '.mcp.json'

export type EnableResult =
  | { ok: true; capability: CapabilityDescriptor; envMissing: string | null }
  | { ok: false; reason: string; code: EnableFailureCode }

export type EnableFailureCode =
  /** No such id in the catalog. Never write a spec that didn't come from source. */
  | 'unknown-capability'
  /** Already present — enabling twice is a no-op worth reporting, not an error to bury. */
  | 'already-enabled'
  /** The file exists but isn't parseable; overwriting would destroy the user's work. */
  | 'unparseable'
  | 'write-failed'

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Read `.mcp.json`, returning `{}` when absent.
 *
 * A present-but-unparseable file is an ERROR, never an empty object: silently
 * treating it as `{}` and writing would delete whatever the user had.
 */
async function readMcpJson(
  path: string,
): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; reason: string }> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, value: {} }
    return { ok: false, reason: (err as Error).message }
  }
  if (text.trim() === '') return { ok: true, value: {} }
  try {
    const parsed: unknown = JSON.parse(text)
    if (!isRecord(parsed)) return { ok: false, reason: `${MCP_FILENAME} is not a JSON object` }
    return { ok: true, value: parsed }
  } catch (err) {
    return { ok: false, reason: `${MCP_FILENAME} is not valid JSON: ${(err as Error).message}` }
  }
}

/**
 * Enable a catalog capability by writing its server entry into `.mcp.json`.
 *
 * `repoRoot` must be the SAME root the loader reads — the git root the chat
 * handler passes as `verificationRoot`, not a canonicalised subdirectory, or
 * we write a file nothing opens.
 *
 * Reports `envMissing` rather than refusing when a required variable is unset:
 * the entry is valid and will work the moment it is exported, and the loader
 * now skips just that entry instead of failing. The caller shows the export
 * line. We never accept the VALUE of a secret.
 */
export async function enableCapability(opts: {
  repoRoot: string
  capabilityId: string
  /** Env to check `requiresEnv` against. Defaults to the CLI's own. */
  env?: Record<string, string | undefined>
}): Promise<EnableResult> {
  const capability = findCapability(opts.capabilityId)
  if (!capability) {
    return {
      ok: false,
      code: 'unknown-capability',
      reason: `Unknown capability '${opts.capabilityId}'.`,
    }
  }
  if (capability.target !== 'mcp-extension' || !capability.mcpServer) {
    return {
      ok: false,
      code: 'unknown-capability',
      reason: `'${capability.id}' is not an MCP extension and cannot be enabled this way.`,
    }
  }

  const configPath = join(opts.repoRoot, MCP_FILENAME)
  const read = await readMcpJson(configPath)
  if (!read.ok) return { ok: false, code: 'unparseable', reason: read.reason }

  const root = read.value
  // A malformed `mcpServers` (an array, a string) must not be silently
  // replaced — the loader reports that same shape as a config error, and
  // overwriting it would destroy whatever the user meant to write.
  if ('mcpServers' in root && !isRecord(root.mcpServers)) {
    return {
      ok: false,
      code: 'unparseable',
      reason: `${MCP_FILENAME}: 'mcpServers' is not an object. Fix it before enabling a capability.`,
    }
  }
  const servers = isRecord(root.mcpServers) ? root.mcpServers : {}
  if (capability.id in servers) {
    return {
      ok: false,
      code: 'already-enabled',
      reason: `'${capability.id}' is already declared in ${MCP_FILENAME}.`,
    }
  }

  // `${VAR}` references are written UNinterpolated on purpose — resolving them
  // here would bake a live secret into a file the user commits.
  const entry: Record<string, unknown> = { command: capability.mcpServer.command }
  if (capability.mcpServer.args?.length) entry.args = [...capability.mcpServer.args]
  if (capability.mcpServer.env) entry.env = { ...capability.mcpServer.env }

  const next = { ...root, mcpServers: { ...servers, [capability.id]: entry } }

  try {
    // Temp + rename so a reader (us, or Claude Code, which reads this same
    // file) can never observe a half-written config.
    const temp = `${configPath}.tmp-${process.pid}`
    await writeFile(temp, JSON.stringify(next, null, 2) + '\n', 'utf8')
    await rename(temp, configPath)
  } catch (err) {
    return { ok: false, code: 'write-failed', reason: (err as Error).message }
  }

  const env = opts.env ?? process.env
  const envMissing =
    capability.requiresEnv && env[capability.requiresEnv] === undefined
      ? capability.requiresEnv
      : null

  return { ok: true, capability, envMissing }
}

/**
 * Ids declared in `.mcp.json`, whether or not the loader could use them.
 *
 * An entry whose `${VAR}` is unset is written but skipped, so "declared" and
 * "live" genuinely differ. The panel needs the former to show
 * enabled-but-blocked rather than offering to enable something that is already
 * in the file. Returns [] for any unreadable or malformed config — the panel
 * surfaces that separately via the loader's own error.
 */
export async function declaredExtensionIds(repoRoot: string): Promise<string[]> {
  const read = await readMcpJson(join(repoRoot, MCP_FILENAME))
  if (!read.ok) return []
  const servers = read.value.mcpServers
  return isRecord(servers) ? Object.keys(servers) : []
}
