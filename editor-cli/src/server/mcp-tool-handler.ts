/**
 * Dispatch for `POST /api/editor/mcp/tool/:name`.
 *
 * Backs the `desde-mcp` stdio proxy that the local
 * `claude` CLI spawns. Each call translates an MCP-style tool request
 * into a shell-bridge query via `enqueueShellBridgeQuery`, then runs
 * the shared editor-tool handler with a one-shot BridgeClient.
 *
 * Three tools are exposed:
 *   - `get_selection` (no input)
 *   - `get_page_info` (no input)
 *   - `pin_selections` ({ selectors: string[] })
 *
 * `propose_prop_edit` is intentionally not exposed — it needs the
 * orchestrator-supplied `emitEdit` callback (which writes to the chat
 * SSE buffer for the save-gated UX), and the proxy path has no such
 * orchestrator. The local `claude` CLI uses its built-in `Edit` tool
 * against the worktree instead.
 *
 * The verification / vision suite (`verify_edit`, `verify_goal`,
 * `capture_screenshot`, `run_verification`) is likewise NOT exposed here — it
 * is a Editor-chat-runtime feature (registered in
 * `agent-chat-sdk/editor-tools.ts`). External `claude` CLI sessions inspect
 * with the read tools above and verify with their own tooling. If we ever want
 * the verification loop in the external proxy, add the whole suite together —
 * not one tool — so the behavior stays coherent.
 */
import type { IncomingMessage, ServerResponse } from "node:http"

import type { BridgeClient } from "../../../src/editor/agent-tools/types.js"
import {
  getPageInfo,
  getSelection,
  pinSelections,
  type EditorToolResult,
} from "../../../src/editor/agent-chat-sdk/editor-tool-handlers.js"
import { enqueueShellBridgeQuery } from "./shell-bridge.js"
import { readRawBody, BodyTooLargeError } from "./http-body.js"

/** Tool names handled by this endpoint. Exported for the stdio proxy. */
export const MCP_PROXY_TOOL_NAMES = [
  "get_selection",
  "get_page_info",
  "pin_selections",
] as const

export type McpProxyToolName = (typeof MCP_PROXY_TOOL_NAMES)[number]

export interface McpToolRequestBody {
  /** Tool input as JSON. Empty `{}` for nullary tools. */
  input?: unknown
}

export interface McpToolResponse {
  status: number
  body:
    | { ok: true; result: EditorToolResult }
    | { ok: false; reason: string }
}

/**
 * Build a BridgeClient that forwards each `send()` to the long-poll
 * shell-bridge queue. Each invocation creates its own one-shot client
 * — no shared state, no need to tear it down between calls.
 */
function makeProxyBridge(): BridgeClient {
  return {
    send(messageType, payload, options) {
      return enqueueShellBridgeQuery(messageType, payload, {
        signal: options?.signal,
      })
    },
  }
}

export async function handleMcpToolRequest(
  toolName: string,
  body: McpToolRequestBody,
  signal: AbortSignal,
): Promise<McpToolResponse> {
  if (!isProxyToolName(toolName)) {
    return {
      status: 404,
      body: {
        ok: false,
        reason: `Unknown MCP tool '${toolName}'. Supported: ${MCP_PROXY_TOOL_NAMES.join(", ")}.`,
      },
    }
  }

  const bridge = makeProxyBridge()
  const ctx = { bridge, signal }

  try {
    let result: EditorToolResult
    switch (toolName) {
      case "get_selection":
        result = await getSelection(ctx)
        break
      case "get_page_info":
        result = await getPageInfo(ctx)
        break
      case "pin_selections": {
        const input = (body.input ?? {}) as { selectors?: unknown }
        if (!Array.isArray(input.selectors)) {
          return {
            status: 400,
            body: {
              ok: false,
              reason: "pin_selections requires input.selectors: string[]",
            },
          }
        }
        if (input.selectors.some((s) => typeof s !== "string")) {
          return {
            status: 400,
            body: {
              ok: false,
              reason: "pin_selections.selectors must be an array of strings",
            },
          }
        }
        result = await pinSelections(ctx, {
          selectors: input.selectors as string[],
        })
        break
      }
    }
    return { status: 200, body: { ok: true, result } }
  } catch (err) {
    return {
      status: 500,
      body: { ok: false, reason: (err as Error).message },
    }
  }
}

function isProxyToolName(name: string): name is McpProxyToolName {
  return (MCP_PROXY_TOOL_NAMES as readonly string[]).includes(name)
}

/** Convenience for the HTTP router: parse body + run + write response. */
export async function dispatchMcpToolHttp(
  req: IncomingMessage,
  res: ServerResponse,
  toolName: string,
): Promise<void> {
  let raw: string
  try {
    raw = await readRawBody(req)
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      res.statusCode = 413
      res.setHeader("Content-Type", "application/json")
      res.end(JSON.stringify({ ok: false, reason: err.message }))
      return
    }
    throw err
  }
  let body: McpToolRequestBody
  try {
    body = raw.length === 0 ? {} : (JSON.parse(raw) as McpToolRequestBody)
  } catch {
    res.statusCode = 400
    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify({ ok: false, reason: "Invalid JSON body" }))
    return
  }
  // Pipe HTTP close into an AbortSignal so the long-poll query gets
  // aborted if the proxy disconnects.
  const ac = new AbortController()
  req.on("close", () => ac.abort())
  const result = await handleMcpToolRequest(toolName, body, ac.signal)
  res.statusCode = result.status
  res.setHeader("Content-Type", "application/json")
  res.end(JSON.stringify(result.body))
}
