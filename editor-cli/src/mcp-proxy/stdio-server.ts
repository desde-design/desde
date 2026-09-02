/**
 * `desde-mcp` — stdio MCP server.
 *
 * Spawned by the local `claude` CLI after the user runs
 * `claude mcp add editor desde-mcp`. Re-reads the
 * editor-cli session-info file on every tool call (so an editor
 * restart and its rotated token are invisible to long-running
 * `claude` sessions), then forwards the call to the editor's HTTP
 * endpoint.
 *
 * Three tools exposed:
 *   - `get_selection` (no input)
 *   - `get_page_info` (no input)
 *   - `pin_selections` ({ selectors: string[] })
 *
 * `propose_prop_edit` is deliberately omitted — see
 * `tasks/_archive/one-shot-tasks/composer-mcp-proxy.md` §"Non-goals". Claude's built-in
 * `Edit` tool against the worktree replaces it.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"

import { discoverEditorSession } from "./session-discover.js"
import { forwardMcpToolCall, type ForwardedToolResult } from "./tool-forwarder.js"

/**
 * Wrap a tool handler so each invocation re-reads the session file
 * (cheap; covers editor-cli restart) and forwards to its HTTP
 * endpoint. On discovery failure the MCP tool result is `isError:
 * true` with a human-readable explanation — claude shows this to the
 * user verbatim.
 */
function makeForwardingHandler(toolName: string) {
  return async (input: unknown): Promise<ForwardedToolResult> => {
    const discovered = discoverEditorSession()
    if (!discovered.ok) {
      return {
        content: [{ type: "text" as const, text: discovered.reason }],
        isError: true,
      }
    }
    const r = await forwardMcpToolCall(discovered.info, toolName, input)
    if (!r.ok) {
      return {
        content: [{ type: "text" as const, text: r.error }],
        isError: true,
      }
    }
    return r.result
  }
}

async function main(): Promise<void> {
  const server = new McpServer({
    name: "desde-mcp",
    version: "0.1.0",
  })

  // Tool descriptions mirror the in-process SDK server in
  // `src/editor/agent-chat-sdk/editor-tools.ts` so the model's
  // tool-selection prompt context is identical across runtimes.
  server.registerTool(
    "get_selection",
    {
      description:
        "Get the user's current selection in the editor: the selected component, the source file it lives in, its props, its position in the component tree, and the surrounding ancestry. Returns null when nothing is selected. Always check this first when the user refers to 'this', 'the button', 'this component', etc.",
    },
    () => makeForwardingHandler("get_selection")(undefined),
  )

  server.registerTool(
    "get_page_info",
    {
      description:
        "Get information about the page the user is currently viewing in the iframe: the URL, the route (pathname), the detected framework (e.g. 'vue3', 'react'), and the page title if available. Use this to understand which page the user is working on before reading source files.",
    },
    () => makeForwardingHandler("get_page_info")(undefined),
  )

  server.registerTool(
    "pin_selections",
    {
      description:
        "Pin multiple elements as a simultaneous selection (the chat header will show 'N selected'). Use when the user refers to 'these buttons' / 'the cards in this row' and you need to keep them all in scope across the turn. Subsequent get_selection calls will return all pinned selections.",
      inputSchema: {
        selectors: z
          .array(z.string())
          .describe(
            "CSS selectors to pin as a multi-selection. Each is resolved via the bridge; unresolvable selectors are silently skipped. Pass an empty array to clear multi-select.",
          ),
      },
    },
    (args) =>
      makeForwardingHandler("pin_selections")({ selectors: args.selectors }),
  )

  const transport = new StdioServerTransport()
  await server.connect(transport)

  // Stay alive until stdin closes. The MCP transport handles the
  // protocol; we just need to keep the event loop busy.
  process.stdin.resume()
}

main().catch((err) => {
  // Write to stderr — the MCP transport owns stdout for JSON-RPC, so
  // anything else there would break the protocol.
  process.stderr.write(
    `[desde-mcp] fatal: ${(err as Error).message}\n`,
  )
  process.exit(1)
})
