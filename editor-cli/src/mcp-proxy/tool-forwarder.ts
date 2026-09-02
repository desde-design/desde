/**
 * `fetch` wrapper that forwards an MCP tool call from the stdio
 * proxy to editor-cli's `POST /api/editor/mcp/tool/:name`.
 *
 * Returns the editor-cli `result` shape (content + isError) verbatim
 * so the proxy can pass it back to the MCP client unchanged.
 */
import type { SessionInfo } from "../server/session-info.js"

/**
 * Mirror of editor-cli's `EditorToolResult` (shape returned from
 * `POST /api/editor/mcp/tool/:name`). Index signature is required
 * because the SDK's `CallToolResult` type — which this forwards into
 * — uses one for forward-compatibility with future content fields.
 */
export interface ForwardedToolResult {
  [k: string]: unknown
  content: Array<{ type: "text"; text: string }>
  isError?: boolean
}

export type ForwardResult =
  | { ok: true; result: ForwardedToolResult }
  | { ok: false; error: string }

export async function forwardMcpToolCall(
  session: SessionInfo,
  toolName: string,
  input: unknown,
  signal?: AbortSignal,
): Promise<ForwardResult> {
  const url = `${session.url}/api/editor/mcp/tool/${encodeURIComponent(toolName)}`
  let res: Response
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.token}`,
      },
      body: JSON.stringify({ input }),
      signal,
    })
  } catch (err) {
    return {
      ok: false,
      error: `editor-cli appears to have stopped: ${(err as Error).message}. Restart it and try again.`,
    }
  }

  let body: unknown
  try {
    body = await res.json()
  } catch (err) {
    return {
      ok: false,
      error: `editor-cli returned non-JSON (status ${res.status}): ${(err as Error).message}`,
    }
  }

  if (!res.ok) {
    const reason =
      isReasonShape(body) && body.reason ? body.reason : `HTTP ${res.status}`
    return {
      ok: false,
      error: `editor-cli rejected '${toolName}': ${reason}`,
    }
  }

  if (!isSuccessShape(body)) {
    return {
      ok: false,
      error: `editor-cli returned unexpected payload for '${toolName}': ${JSON.stringify(body)}`,
    }
  }

  return { ok: true, result: body.result }
}

function isSuccessShape(
  body: unknown,
): body is { ok: true; result: ForwardedToolResult } {
  if (typeof body !== "object" || body === null) return false
  const b = body as { ok?: unknown; result?: unknown }
  if (b.ok !== true) return false
  if (typeof b.result !== "object" || b.result === null) return false
  const r = b.result as { content?: unknown }
  return Array.isArray(r.content)
}

function isReasonShape(body: unknown): body is { reason?: string } {
  return typeof body === "object" && body !== null
}
