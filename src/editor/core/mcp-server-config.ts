/**
 * A stdio MCP server config, structurally identical to the SDK's own
 * `McpStdioServerConfig` (`@anthropic-ai/claude-agent-sdk`). Declared locally
 * so `src/editor/core/` (framework- and design-system-neutral, and SDK-free)
 * can describe the shape without importing the SDK package. Consumers that
 * hand these to the SDK's `mcpServers` map (`run-chat-turn-sdk.ts`) still
 * type-check against the real SDK type because the fields match exactly.
 *
 * `alwaysLoad` is included because `figma-config.ts` assigns it directly into
 * a variable typed as `McpStdioServerConfig` — omitting it would fail that
 * file's excess-property check. The SDK type also has a `timeout?: number`
 * field; it is left off here because nothing in core currently reads or
 * writes it. Add it the same way (widen, don't import the SDK) if a caller
 * needs it.
 */
export interface McpStdioServerConfig {
  type?: 'stdio'
  command: string
  args?: string[]
  env?: Record<string, string>
  alwaysLoad?: boolean
}

export function isMcpStdioServerConfig(v: unknown): v is McpStdioServerConfig {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return typeof o.command === 'string' && (o.args === undefined || Array.isArray(o.args))
}

/**
 * The rule an MCP server id must meet, stated for error messages.
 *
 * An id becomes the middle of every tool name, `mcp__<id>__<tool>`, and the
 * permission gate (`handleExtensionTool` in `edit-ack.ts`) finds the id again
 * by reading up to the FIRST `__` after `mcp__`. An id containing `__`
 * therefore splits in the wrong place: id `editor__figma` reads as the
 * built-in `editor` namespace and skips the read-only policy, and id `a__b`
 * inherits the policy of `a`. A trailing `_` does the same, because it joins
 * the separator: `x_` gives `mcp__x___tool`, read as id `x`. A leading `_` is
 * refused to keep the rule symmetric.
 *
 * Under this rule the first `__` after `mcp__` is always the separator: the id
 * holds no `__`, and its last character is never `_`. A single `_` inside the
 * id (`my_server`) is safe and allowed. `.` is refused, as model providers
 * refuse it in a tool name.
 */
export const MCP_SERVER_ID_RULE =
  'letters, digits, "-" and "_", with no "__" and no "_" at the start or end'

/** Each `_` sits between two non-`_` characters. */
const MCP_SERVER_ID = /^[A-Za-z0-9-]+(?:_[A-Za-z0-9-]+)*$/

/** Whether `id` meets {@link MCP_SERVER_ID_RULE}. Used at load AND at connect. */
export function isValidMcpServerId(id: string): boolean {
  return MCP_SERVER_ID.test(id)
}

/**
 * Ids we register ourselves. A customer server taking one of these would
 * shadow the Editor's own tools, so the collision is refused rather than
 * silently resolved. `editor` passes {@link MCP_SERVER_ID_RULE}, so this is a
 * separate check.
 *
 * Was `['composer', 'editor']` pre-rename, guarding both the legacy and
 * current names of the built-in tool namespace (`mcp__composer__*` /
 * `mcp__editor__*`). The 2026-08-08 Composer→Editor sweep (commit
 * a3177b0b) blindly replaced the remaining literal `'composer'` with
 * `'editor'`, collapsing this into a duplicate-valued set. Unlike
 * `LEGACY_CONFIG_FILENAME`, which that same commit deliberately protected
 * because old repos read it from disk, nothing on disk still depends on
 * `'composer'` being a reserved *extension id*: the built-in namespace is
 * `mcp__editor__*` only, so a customer's `.mcp.json` is free to name an
 * extension `composer` without colliding with anything.
 *
 * Lives here, next to the character rule, so the loader (`loadExtensions`)
 * and the runtime (`connectTurnMcpServers`) refuse the same ids.
 */
const RESERVED_IDS: ReadonlySet<string> = new Set(['editor'])

/** Whether `id` is one we register ourselves. Used at load AND at connect. */
export function isReservedMcpServerId(id: string): boolean {
  return RESERVED_IDS.has(id)
}
