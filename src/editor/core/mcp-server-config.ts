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
 * permission gate finds the id again by reading up to the first `__` after
 * `mcp__`. An id containing `__` therefore splits in the wrong place: id
 * `editor__figma` reads as the built-in `editor` namespace and skips the
 * read-only policy, and id `a__b` inherits the policy of `a`. Letters, digits
 * and `-` cannot form `__`, and `.` is refused by model providers anyway.
 */
export const MCP_SERVER_ID_RULE = 'letters, digits and "-" only'

const MCP_SERVER_ID = /^[A-Za-z0-9-]+$/

/** Whether `id` meets {@link MCP_SERVER_ID_RULE}. Used at load AND at connect. */
export function isValidMcpServerId(id: string): boolean {
  return MCP_SERVER_ID.test(id)
}
