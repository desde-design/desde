/**
 * The MCP servers one neutral turn starts, and their teardown.
 *
 * Split out of `run-chat-turn-neutral.ts` so the loop keeps to the loop. The
 * per-server client is `mcp-client-tools.ts`; this file decides WHICH servers
 * a turn starts and what a failure to start does to the turn (nothing but a
 * notice).
 */

import type { RunChatTurnOpts } from '../agent-chat/run-chat-turn'
import type { ToolSpec } from '../agent-chat/tool-spec'
import {
  isReservedMcpServerId,
  isValidMcpServerId,
  MCP_SERVER_ID_RULE,
  type McpStdioServerConfig,
} from '../core/mcp-server-config'
import { connectMcpClientTools, type McpClientTools } from './mcp-client-tools'

export interface TurnMcpServers {
  /** Every tool of every server that started, named `mcp__<id>__<tool>`. */
  specs: ToolSpec[]
  /** The ids that started. */
  connectedIds: Set<string>
  /** One system-prompt sentence per server that did not start. */
  startupNotices: string[]
}

/**
 * Start this turn's MCP servers: the legacy `figma` block (id `figma`) and
 * every `.mcp.json` extension (its own id). An extension with the id `figma`
 * replaces the legacy block, the same precedence the SDK lane's `mcpServers`
 * map gives it.
 *
 * All start at once. A server that fails to start or to list its tools does
 * NOT end the turn: chat has to keep working when an optional capability is
 * broken. It is logged once with its error, left out, and named in one
 * sentence of the system prompt so the model can tell the user rather than
 * fail with no idea why. Each server that did start is pushed onto
 * `sessions` for the caller to close.
 *
 * An id that fails `isValidMcpServerId`, or that is reserved
 * (`isReservedMcpServerId`: `editor`), is never started. `loadExtensions`
 * already refuses both, so this is the guard for a config that reached the
 * runtime some other way. A bad id splits in the wrong place inside
 * `mcp__<id>__<tool>`, and the permission gate would apply another id's
 * policy to its tools, or none. A reserved id lands in the built-in
 * `mcp__editor__*` namespace, which the gate treats as first-party and never
 * applies the server's read-only policy to.
 */
export async function connectTurnMcpServers(
  opts: RunChatTurnOpts,
  sessions: McpClientTools[],
): Promise<TurnMcpServers> {
  const servers = new Map<string, McpStdioServerConfig>()
  if (opts.figmaConfig) servers.set('figma', opts.figmaConfig.mcpServer)
  for (const e of opts.extensions ?? []) servers.set(e.id, e.mcpServer)

  const entries = [...servers]
  const settled = await Promise.allSettled(
    entries.map(([id, server]) => {
      if (!isValidMcpServerId(id)) {
        return Promise.reject(
          new Error(
            `MCP server ${JSON.stringify(id)}: its id is not allowed. An id may use ${MCP_SERVER_ID_RULE}.`,
          ),
        )
      }
      if (isReservedMcpServerId(id)) {
        return Promise.reject(
          new Error(
            `MCP server ${JSON.stringify(id)}: its id is reserved for the Editor's own tools.`,
          ),
        )
      }
      return connectMcpClientTools({
        id,
        server,
        ...(opts.signal ? { signal: opts.signal } : {}),
      })
    }),
  )
  const specs: ToolSpec[] = []
  const connectedIds = new Set<string>()
  const startupNotices: string[] = []
  settled.forEach((outcome, i) => {
    const id = entries[i]![0]
    if (outcome.status === 'fulfilled') {
      sessions.push(outcome.value)
      connectedIds.add(id)
      specs.push(...outcome.value.specs)
    } else {
      // The client's error already names the server.
      const reason =
        outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)
      console.warn(`[runChatTurnNeutral] could not start ${reason}`)
      // JSON-quoted rather than wrapped in bare quotes: an id refused above
      // may hold characters that should not reach the prompt raw. A valid id
      // reads exactly as `"<id>"` either way.
      startupNotices.push(
        `The MCP server ${JSON.stringify(id)} could not be started this turn, so its tools are unavailable.`,
      )
    }
  })
  return { specs, connectedIds, startupNotices }
}

/** Close every session. Each `close()` is bounded, so this is too. */
export async function closeMcpSessions(sessions: readonly McpClientTools[]): Promise<void> {
  await Promise.all(sessions.map((s) => s.close()))
}
