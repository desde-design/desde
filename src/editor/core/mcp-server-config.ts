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
