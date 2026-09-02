/**
 * Figma MCP integration config. Loaded from the same
 * `desde.config.json` as the read-roots registry and
 * the web policy. Used by `runChatTurnSdk` to conditionally register
 * a customer-supplied Figma MCP server alongside the in-process
 * `editor` server.
 *
 * Default: **absent ⇒ disabled.** Customers opt in by adding a
 * `figma` block with `enabled: true` and a stdio MCP server config.
 * Without config, no Figma tools are visible to the agent.
 *
 * Why first-class config instead of inheriting `~/.claude/`: the SDK
 * runtime sets `settingSources: ['project']` to keep host-machine
 * state out of the model's context. Figma access is per-prototype
 * (different prototypes point at different files / tokens), so the
 * config naturally lives at the prototype root.
 *
 * Scope (v1): registration only. The Figma file URL/id is provided by
 * the user per turn — no first-party files catalog. The agent uses the
 * MCP server's own discovery tools to read frames.
 */


import { readEditorConfigFile } from './config-filename'

import type { McpStdioServerConfig } from '@anthropic-ai/claude-agent-sdk'

/**
 * Resolved Figma config passed to `runChatTurnSdk`. Optional — when
 * absent, no Figma MCP server is registered.
 */
export interface FigmaConfig {
  /**
   * stdio MCP server config, ready to hand to the SDK's `mcpServers`
   * map. Env values have already been interpolated.
   */
  mcpServer: McpStdioServerConfig
  /**
   * Read-tool name prefixes that the SDK's `canUseTool` will accept
   * for `mcp__figma__*` calls. Defaults to {@link DEFAULT_FIGMA_READ_PREFIXES}.
   * Customers override this by setting `figma.allowedToolPrefixes` in
   * `desde.config.json` — useful when the Figma MCP
   * server they chose uses non-standard read-verb naming.
   */
  allowedToolPrefixes: ReadonlyArray<string>
}

/**
 * Default allowlist of bare tool-name prefixes treated as read-only.
 * Covers the verbs every Figma MCP server I've seen uses for read
 * tools. Customers can override via `figma.allowedToolPrefixes`.
 *
 * Note: this is convention by community-naming, not a contract the
 * MCP protocol enforces. A malicious or misnamed tool can still slip
 * through — but the cost of attack goes up: the attacker has to
 * (a) control the Figma MCP server the customer picked, or (b)
 * inject a write call into the Figma content that hits a tool the
 * customer's server actually exposes under a read-verb name.
 */
export const DEFAULT_FIGMA_READ_PREFIXES: ReadonlyArray<string> = [
  'get_',
  'list_',
  'read_',
  'search_',
  'fetch_',
  'find_',
]

const CONFIG_FILENAME = 'desde.config.json'

/**
 * Characters we refuse in `mcpServer.command`. The SDK's stdio
 * transport spawns directly (not via shell), so the parent never
 * shell-interprets these — they ARE benign at spawn time. This
 * check is intent-clarification, not a security boundary: a
 * customer-authored config with `command: "sh"` and
 * `args: ["-c", "evil"]` would still work because args go to the
 * shell-via-execve path. We treat `desde.config.json`
 * as TRUSTED customer-authored config, same as `package.json`.
 *
 * Also rejected: NUL and control chars in any string field below,
 * because `spawn` would otherwise surface an opaque ENOENT later.
 */
const SHELL_METACHARACTERS = /[;|&<>$`\n]/
const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/

interface RawFigmaConfig {
  enabled?: boolean
  mcpServer?: {
    type?: string
    command?: unknown
    args?: unknown
    env?: unknown
    alwaysLoad?: unknown
  } | null
  allowedToolPrefixes?: unknown
}

export type LoadFigmaConfigResult =
  | { ok: true; config: FigmaConfig | null; warnings: string[] }
  | { ok: false; errors: string[] }

/**
 * Load the Figma config block from `desde.config.json`.
 *
 * Returns `config: null` when:
 *   - the config file doesn't exist
 *   - the file exists but has no `figma` block
 *   - the block has `enabled: false`
 *
 * Returns errors for:
 *   - malformed JSON
 *   - structurally invalid block (missing required fields, wrong types)
 *   - `${ENV_VAR}` interpolations that can't be resolved from
 *     `process.env`
 *   - shell metacharacters in `mcpServer.command`
 *
 * The same JSON file feeds `loadReadRoots` and `loadWebPolicy`; failure
 * here doesn't block those loaders — callers should handle each
 * loader's errors independently.
 */
export async function loadFigmaConfig(opts: {
  worktreeRoot: string
  /**
   * Optional env source for `${VAR}` interpolation. Defaults to
   * `process.env`. Tests pass a stub here. Modelled as a plain
   * string-keyed map rather than `NodeJS.ProcessEnv` so test fixtures
   * don't have to provide every TS-augmented env-var (NODE_ENV etc.).
   */
  env?: Record<string, string | undefined>
}): Promise<LoadFigmaConfigResult> {
  const env = opts.env ?? process.env
  // Reads the current filename, falling back to the pre-rename one so a
  // repo written before the Composer -> Editor rename keeps working.
  const found = await readEditorConfigFile(opts.worktreeRoot)
  // Report whichever file we actually read, so an error about a legacy
  // config names the legacy file rather than one that isn't there.
  const configName = found?.filename ?? CONFIG_FILENAME

  let raw: string
  try {
    if (found === null) throw Object.assign(new Error('absent'), { code: 'ENOENT' })
    raw = found.text
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: true, config: null, warnings: [] }
    }
    return { ok: false, errors: [`${configName}: ${(err as Error).message}`] }
  }

  let parsed: { figma?: RawFigmaConfig }
  try {
    parsed = JSON.parse(raw) as { figma?: RawFigmaConfig }
  } catch (err) {
    return { ok: false, errors: [`${configName}: ${(err as Error).message}`] }
  }

  if (parsed.figma === undefined) {
    return { ok: true, config: null, warnings: [] }
  }
  if (typeof parsed.figma !== 'object' || parsed.figma === null) {
    return { ok: false, errors: [`${configName}: "figma" must be an object`] }
  }

  const block = parsed.figma
  if (block.enabled === undefined) {
    return {
      ok: false,
      errors: [`${configName}: "figma.enabled" is required (boolean)`],
    }
  }
  if (typeof block.enabled !== 'boolean') {
    return {
      ok: false,
      errors: [`${configName}: "figma.enabled" must be a boolean`],
    }
  }
  if (block.enabled === false) {
    return { ok: true, config: null, warnings: [] }
  }

  // enabled === true ⇒ mcpServer is required
  const errors: string[] = []
  const warnings: string[] = []

  if (block.mcpServer === undefined || block.mcpServer === null) {
    return {
      ok: false,
      errors: [`${configName}: "figma.mcpServer" is required when "figma.enabled" is true`],
    }
  }
  if (typeof block.mcpServer !== 'object') {
    return {
      ok: false,
      errors: [`${configName}: "figma.mcpServer" must be an object`],
    }
  }
  const server = block.mcpServer

  // command — required, non-empty string, no shell metacharacters, no control chars
  let command = ''
  if (typeof server.command !== 'string' || server.command.length === 0) {
    errors.push(`${configName}: "figma.mcpServer.command" must be a non-empty string`)
  } else if (CONTROL_CHARS.test(server.command)) {
    errors.push(
      `${configName}: "figma.mcpServer.command" contains control characters (NUL/CR/etc.)`,
    )
  } else if (SHELL_METACHARACTERS.test(server.command)) {
    errors.push(
      `${configName}: "figma.mcpServer.command" contains shell metacharacters; pass arguments via "args" instead`,
    )
  } else {
    command = server.command
  }

  // type — optional, must be "stdio" when present (only mode we support)
  if (server.type !== undefined && server.type !== 'stdio') {
    errors.push(`${configName}: "figma.mcpServer.type" must be "stdio" (only stdio is supported)`)
  }

  // args — optional, array of strings (interpolated)
  let args: string[] | undefined
  if (server.args !== undefined) {
    if (!Array.isArray(server.args)) {
      errors.push(`${configName}: "figma.mcpServer.args" must be an array of strings`)
    } else {
      const out: string[] = []
      for (let i = 0; i < server.args.length; i++) {
        const a = server.args[i]
        if (typeof a !== 'string') {
          errors.push(`${configName}: "figma.mcpServer.args[${i}]" must be a string`)
          continue
        }
        const interp = interpolateEnv(a, env)
        if (!interp.ok) {
          errors.push(
            `${configName}: "figma.mcpServer.args[${i}]" references unset environment variables: ${interp.missing
              .map((m) => `$${m}`)
              .join(', ')}`,
          )
          continue
        }
        if (CONTROL_CHARS.test(interp.value)) {
          errors.push(
            `${configName}: "figma.mcpServer.args[${i}]" contains control characters after interpolation`,
          )
          continue
        }
        out.push(interp.value)
      }
      args = out
    }
  }

  // env — optional, flat string→string map (interpolated); reject other shapes
  let envOut: Record<string, string> | undefined
  if (server.env !== undefined) {
    if (typeof server.env !== 'object' || server.env === null || Array.isArray(server.env)) {
      errors.push(`${configName}: "figma.mcpServer.env" must be an object mapping string to string`)
    } else {
      const out: Record<string, string> = {}
      for (const [k, v] of Object.entries(server.env as Record<string, unknown>)) {
        if (typeof v !== 'string') {
          errors.push(`${configName}: "figma.mcpServer.env.${k}" must be a string`)
          continue
        }
        // Warn if the value doesn't look like an env-var reference —
        // raw secrets on disk are the most common configuration
        // mistake. We still accept the value (some legitimate uses
        // have non-secret literals) but make the foot-gun visible.
        if (!ENV_VAR_PATTERN.test(v)) {
          warnings.push(
            `${configName}: "figma.mcpServer.env.${k}" is a literal string; prefer "\${${k}}" and set the env var in your shell so secrets don't land in the config file`,
          )
        }
        const interp = interpolateEnv(v, env)
        if (!interp.ok) {
          errors.push(
            `${configName}: "figma.mcpServer.env.${k}" references unset environment variables: ${interp.missing
              .map((m) => `$${m}`)
              .join(', ')}`,
          )
          continue
        }
        if (CONTROL_CHARS.test(interp.value)) {
          errors.push(
            `${configName}: "figma.mcpServer.env.${k}" contains control characters after interpolation`,
          )
          continue
        }
        out[k] = interp.value
      }
      envOut = out
    }
  }

  // alwaysLoad — optional boolean. We don't recommend it (the SDK
  // blocks startup up to 5s waiting for the server to connect; an
  // always-on Figma flow eats that on every turn), but accept it
  // transparently and surface a perf warning so the foot-gun is
  // visible.
  let alwaysLoad: boolean | undefined
  if (server.alwaysLoad !== undefined) {
    if (typeof server.alwaysLoad !== 'boolean') {
      errors.push(`${configName}: "figma.mcpServer.alwaysLoad" must be a boolean`)
    } else {
      alwaysLoad = server.alwaysLoad
      if (alwaysLoad) {
        warnings.push(
          `${configName}: "figma.mcpServer.alwaysLoad" is true — every chat turn will block up to 5s waiting for the Figma MCP server to connect. Set false (default) unless your prototype always-on uses Figma.`,
        )
      }
    }
  }

  // allowedToolPrefixes — optional override of DEFAULT_FIGMA_READ_PREFIXES.
  // Used by canUseTool to enforce the read-only contract. Empty array
  // is rejected — would deny all Figma tools, which is equivalent to
  // disabling Figma; force the customer to either disable or pick
  // prefixes.
  let allowedToolPrefixes: ReadonlyArray<string> = DEFAULT_FIGMA_READ_PREFIXES
  if (block.allowedToolPrefixes !== undefined) {
    if (!Array.isArray(block.allowedToolPrefixes)) {
      errors.push(
        `${configName}: "figma.allowedToolPrefixes" must be an array of strings`,
      )
    } else {
      const out: string[] = []
      for (let i = 0; i < block.allowedToolPrefixes.length; i++) {
        const p = block.allowedToolPrefixes[i]
        if (typeof p !== 'string' || p.length === 0) {
          errors.push(
            `${configName}: "figma.allowedToolPrefixes[${i}]" must be a non-empty string`,
          )
          continue
        }
        out.push(p)
      }
      if (out.length === 0 && errors.length === 0) {
        errors.push(
          `${configName}: "figma.allowedToolPrefixes" cannot be empty. Set "figma.enabled" to false to disable Figma entirely.`,
        )
      }
      allowedToolPrefixes = out
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors }
  }

  const mcpServer: McpStdioServerConfig = {
    type: 'stdio',
    command,
    ...(args !== undefined ? { args } : {}),
    ...(envOut !== undefined ? { env: envOut } : {}),
    ...(alwaysLoad !== undefined ? { alwaysLoad } : {}),
  }

  return {
    ok: true,
    config: { mcpServer, allowedToolPrefixes },
    warnings,
  }
}

/**
 * `${VAR}` looks like an env-var reference. Used to decide whether to
 * warn about a literal value in `env`. Intentionally permissive — we
 * just want to catch the obvious "I forgot to use ${}" case.
 */
const ENV_VAR_PATTERN = /\$\{[A-Z0-9_]+\}/i

/**
 * Pure helper: interpolate `${VAR}` references against the given env.
 * Returns the resolved string OR a list of unresolved variable names.
 *
 * Recognized only the explicit `${VAR}` form — bare `$VAR` is not
 * substituted (avoids surprises with paths/URLs that contain `$`).
 *
 * Empty values from env are treated as PRESENT — only undefined values
 * are reported as missing. This matches `process.env` semantics where
 * `FOO=` and unset `FOO` are usually distinguished (some shells, not
 * all, but the principle holds).
 *
 * Exported so tests can drive interpolation with a stub env.
 */
export function interpolateEnv(
  value: string,
  env: Record<string, string | undefined>,
): { ok: true; value: string } | { ok: false; missing: string[] } {
  const missing = new Set<string>()
  const result = value.replace(/\$\{([A-Z0-9_]+)\}/gi, (_match, name: string) => {
    const v = env[name]
    if (v === undefined) {
      missing.add(name)
      return _match
    }
    return v
  })
  if (missing.size > 0) {
    return { ok: false, missing: [...missing].sort() }
  }
  return { ok: true, value: result }
}
