/**
 * Editor extensions — MCP servers the agent can reach, declared per prototype.
 *
 * Replaces the bespoke single-purpose `figma` block with a generic seam, so
 * adding a capability (a Figma server, a browser driver, a ticketing system)
 * is a config entry rather than a code change.
 *
 * **Claude-native format.** The primary source is `.mcp.json` at the prototype
 * root — the same file Claude Code itself reads, with the same
 * `{ "mcpServers": { … } }` shape. Users already have these files, existing
 * tooling already writes them, and nothing has to learn a Desde-specific
 * schema. The legacy `figma` block in `desde.config.json` keeps
 * working so existing setups don't break.
 *
 * **Why we read it ourselves** rather than leaning on the SDK's
 * `settingSources`: the runtime deliberately scopes settings to `['project']`
 * to keep host-machine state out of the model's context, and we need the
 * parsed list anyway — to enforce per-extension read-only policy, and to tell
 * the user which extensions are active. Reading it explicitly makes both
 * deterministic and testable.
 *
 * **Trust boundary.** Both files are TRUSTED customer-authored config, same as
 * `package.json`. They can spec any command and reference any `${ENV_VAR}`.
 * We validate shape and reject control characters, but do not sandbox the
 * spawned child: whoever wrote the config controls the resulting subprocess.
 * Content the servers RETURN is untrusted.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { McpStdioServerConfig } from '@anthropic-ai/claude-agent-sdk'

const MCP_FILENAME = '.mcp.json'
const LEGACY_CONFIG_FILENAME = 'desde.config.json'

/**
 * Ids we register ourselves. A customer server taking one of these would
 * shadow the Editor's own tools, so the collision is refused rather than
 * silently resolved.
 *
 * Was `['composer', 'editor']` pre-rename, guarding both the legacy and
 * current names of the built-in tool namespace (`mcp__composer__*` /
 * `mcp__editor__*`). The 2026-08-08 Composer→Editor sweep (commit
 * a3177b0b) blindly replaced the remaining literal `'composer'` with
 * `'editor'`, collapsing this into a duplicate-valued set — unlike
 * `LEGACY_CONFIG_FILENAME`, which that same commit deliberately protected
 * because old repos read it from disk, nothing on disk still depends on
 * `'composer'` being a reserved *extension id*: the built-in namespace is
 * `mcp__editor__*` only, so a customer's `.mcp.json` is free to name an
 * extension `composer` without colliding with anything.
 */
const RESERVED_IDS = new Set(['editor'])

/**
 * Bare tool-name prefixes treated as read-only. Convention by community
 * naming, not something MCP enforces — a misnamed write tool can still slip
 * through. The point is that the cost of doing so goes up.
 */
export const READ_VERB_PREFIXES: ReadonlyArray<string> = [
  'get_',
  'list_',
  'read_',
  'search_',
  'fetch_',
  'find_',
]

/** Refused in a command: the SDK spawns directly, so these signal confusion. */
const CONTROL_OR_SHELL = /[;|&<>$`\n\s]/
const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/

/** Env keys whose values look like real secrets rather than a `${VAR}` ref. */
const SECRET_KEY_HINT = /(KEY|TOKEN|SECRET|PASSWORD)$/i

export interface EditorExtension {
  /** MCP namespace this registers under (`mcp__<id>__<tool>`). */
  id: string
  /** Ready to hand to the SDK's `mcpServers` map; env already interpolated. */
  mcpServer: McpStdioServerConfig
  /**
   * Read-verb prefixes `canUseTool` will accept for this extension, or **null**
   * when the user has explicitly opted the server out of read-only.
   *
   * Read-only is the DEFAULT because an extension is reached by an agent
   * acting on a prompt, and prompt-injected content inside whatever the
   * server returns must not be able to reach a write. Opting out is a
   * deliberate, visible choice for servers the user genuinely wants written to.
   */
  allowedToolPrefixes: ReadonlyArray<string> | null
}

export type LoadExtensionsResult =
  | { ok: true; extensions: EditorExtension[]; warnings: string[] }
  | { ok: false; errors: string[] }

/**
 * Pure helper: interpolate `${VAR}` references against the given env.
 *
 * Only the explicit `${VAR}` form — bare `$VAR` is left alone, so paths and
 * URLs containing `$` don't surprise anyone. An empty env value counts as
 * PRESENT; only `undefined` is missing.
 */
export function interpolateEnv(
  value: string,
  env: Record<string, string | undefined>,
): { ok: true; value: string } | { ok: false; missing: string[] } {
  const missing = new Set<string>()
  const result = value.replace(/\$\{([A-Z0-9_]+)\}/gi, (match, name: string) => {
    const v = env[name]
    if (v === undefined) {
      missing.add(name)
      return match
    }
    return v
  })
  if (missing.size > 0) return { ok: false, missing: [...missing].sort() }
  return { ok: true, value: result }
}

interface RawServer {
  command?: unknown
  args?: unknown
  env?: unknown
  allowedToolPrefixes?: unknown
  readOnly?: unknown
}

function parseServer(
  id: string,
  raw: RawServer,
  env: Record<string, string | undefined>,
  errors: string[],
  warnings: string[],
): EditorExtension | null {
  if (RESERVED_IDS.has(id)) {
    errors.push(`${id}: "${id}" is a reserved extension id`)
    return null
  }
  if (typeof raw.command !== 'string' || raw.command.trim() === '') {
    errors.push(`${id}: 'command' must be a non-empty string`)
    return null
  }
  const command = raw.command.trim()
  if (CONTROL_OR_SHELL.test(command) || CONTROL_CHARS.test(command)) {
    // Not a security boundary (args reach a shell-capable child anyway) —
    // this is intent-clarification, so a mistake surfaces here rather than as
    // an opaque ENOENT at spawn time.
    errors.push(`${id}: 'command' must be a bare executable name or path`)
    return null
  }

  const args: string[] = []
  if (raw.args !== undefined) {
    if (!Array.isArray(raw.args)) {
      errors.push(`${id}: 'args' must be an array of strings`)
      return null
    }
    for (const a of raw.args) {
      if (typeof a !== 'string' || CONTROL_CHARS.test(a)) {
        errors.push(`${id}: every entry in 'args' must be a plain string`)
        return null
      }
      const interp = interpolateEnv(a, env)
      if (!interp.ok) {
        errors.push(`${id}: unresolved ${interp.missing.map((m) => `\${${m}}`).join(', ')} in 'args'`)
        return null
      }
      args.push(interp.value)
    }
  }

  const envOut: Record<string, string> = {}
  if (raw.env !== undefined) {
    if (typeof raw.env !== 'object' || raw.env === null || Array.isArray(raw.env)) {
      errors.push(`${id}: 'env' must be a flat object of strings`)
      return null
    }
    for (const [k, v] of Object.entries(raw.env as Record<string, unknown>)) {
      if (typeof v !== 'string' || CONTROL_CHARS.test(v)) {
        errors.push(`${id}: env.${k} must be a plain string`)
        return null
      }
      const interp = interpolateEnv(v, env)
      if (!interp.ok) {
        // SKIP this one extension rather than failing the whole load.
        //
        // An unresolved `${VAR}` is a statement about the SHELL, not a mistake
        // in the config: the entry is well-formed and will work the moment the
        // variable is exported. Treating it as a config error meant enabling
        // Figma without FIGMA_API_KEY set would disable every OTHER extension
        // too -- one missing env var silently taking out a working setup.
        //
        // Shape errors still fail the load; environment state is not a shape
        // error. We do not spawn with the literal `${VAR}` text either, which
        // would authenticate as nobody and fail confusingly at first use.
        warnings.push(
          `${id}: skipped, ${interp.missing.map((m) => `\${${m}}`).join(', ')} is not set in this shell. Export it and restart to enable it.`,
        )
        return null
      }
      if (interp.value === v && SECRET_KEY_HINT.test(k) && v.trim() !== '') {
        // A literal secret works, so this is a warning rather than an error —
        // but it will end up committed, which is worth saying out loud.
        warnings.push(
          `${id}: env.${k} looks like a literal secret. Prefer \${${k}} and set it in your shell so it never lands in a committed file.`,
        )
      }
      envOut[k] = interp.value
    }
  }

  let allowedToolPrefixes: ReadonlyArray<string> | null = READ_VERB_PREFIXES
  if (raw.readOnly === false) {
    allowedToolPrefixes = null
  } else if (raw.allowedToolPrefixes !== undefined) {
    if (
      !Array.isArray(raw.allowedToolPrefixes) ||
      raw.allowedToolPrefixes.some((p) => typeof p !== 'string' || p.trim() === '')
    ) {
      errors.push(`${id}: 'allowedToolPrefixes' must be an array of non-empty strings`)
      return null
    }
    if (raw.allowedToolPrefixes.length === 0) {
      // An empty list would deny every tool, which reads as "broken" rather
      // than "off". Removing the entry is how you turn an extension off.
      errors.push(
        `${id}: 'allowedToolPrefixes' must not be empty. Remove the extension to disable it, or set readOnly:false to allow writes`,
      )
      return null
    }
    allowedToolPrefixes = raw.allowedToolPrefixes as string[]
  }

  return {
    id,
    mcpServer: {
      type: 'stdio',
      command,
      ...(args.length > 0 ? { args } : {}),
      ...(Object.keys(envOut).length > 0 ? { env: envOut } : {}),
    } as McpStdioServerConfig,
    allowedToolPrefixes,
  }
}

async function readJson(
  path: string,
  errors: string[],
): Promise<Record<string, unknown> | null> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (err) {
    // Absent is the ordinary case — most prototypes declare no extensions.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    errors.push(`${path}: ${(err as Error).message}`)
    return null
  }
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      errors.push(`${path}: expected a JSON object`)
      return null
    }
    return parsed as Record<string, unknown>
  } catch (err) {
    errors.push(`${path}: ${(err as Error).message}`)
    return null
  }
}

/**
 * Load every extension declared for a prototype, from `.mcp.json` first and
 * the legacy `figma` block second.
 *
 * A parse or validation failure fails the WHOLE load rather than silently
 * dropping one entry: a user who wrote a broken config wants to hear about it,
 * and quietly running with a subset would look like the extension simply
 * didn't work.
 */
export async function loadExtensions(opts: {
  worktreeRoot: string
  /** Env source for `${VAR}` interpolation. Defaults to `process.env`. */
  env?: Record<string, string | undefined>
}): Promise<LoadExtensionsResult> {
  const env = opts.env ?? process.env
  const errors: string[] = []
  const warnings: string[] = []
  const byId = new Map<string, EditorExtension>()

  // Legacy first, so `.mcp.json` overwrites it below.
  const legacy = await readJson(join(opts.worktreeRoot, LEGACY_CONFIG_FILENAME), errors)
  const figma = legacy?.figma as
    | { enabled?: unknown; mcpServer?: RawServer; allowedToolPrefixes?: unknown }
    | undefined
  if (figma && figma.enabled === true && figma.mcpServer) {
    const parsed = parseServer(
      'figma',
      { ...figma.mcpServer, allowedToolPrefixes: figma.allowedToolPrefixes },
      env,
      errors,
      warnings,
    )
    if (parsed) byId.set(parsed.id, parsed)
  }

  const mcp = await readJson(join(opts.worktreeRoot, MCP_FILENAME), errors)
  const servers = mcp?.mcpServers
  if (servers !== undefined) {
    if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) {
      errors.push(`${MCP_FILENAME}: 'mcpServers' must be an object`)
    } else {
      for (const [id, raw] of Object.entries(servers as Record<string, RawServer>)) {
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
          errors.push(`${id}: expected an object`)
          continue
        }
        const parsed = parseServer(id, raw, env, errors, warnings)
        if (!parsed) continue
        if (byId.has(id)) {
          warnings.push(
            `${id}: declared in both ${MCP_FILENAME} and ${LEGACY_CONFIG_FILENAME}; using ${MCP_FILENAME}.`,
          )
        }
        byId.set(id, parsed)
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors }

  // Sorted so registration order — and anything derived from it — is stable
  // across runs regardless of key order in the file.
  const extensions = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))
  return { ok: true, extensions, warnings }
}
