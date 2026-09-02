/**
 * Direct unit tests for `mcp-tool-handler.ts` (Task 26 of the editor
 * audit-fixes plan — this module dispatches `POST
 * /api/editor/mcp/tool/:name` for the `desde-mcp` stdio
 * proxy and had zero direct unit tests before this file).
 *
 * `enqueueShellBridgeQuery` (`./shell-bridge.js`) is mocked — its own
 * long-poll queueing behavior is covered by the shell-bridge tests; here
 * we only need to prove the tool-dispatch routing and the request/response
 * shaping around it.
 *
 * AUTH POSTURE (pinned, not re-derived): `handleMcpToolRequest`'s
 * signature is `(toolName, body, signal)` — no request object, headers,
 * or security context reaches it, so this layer structurally cannot
 * re-check bearer/Origin. Auth for this endpoint is entirely the route
 * table's job — `http-server.ts`'s `ROUTE_TABLE` entry for `POST
 * /api/editor/mcp/tool/*` declares `authPolicy:
 * "bearer-origin-if-present"` and the shared `routeRequest` dispatcher
 * enforces it BEFORE `dispatchMcpToolHttp` is ever called. The test below
 * asserts that route-table declaration directly (rather than trying to
 * prove a negative inside this module) and a second test demonstrates
 * that `handleMcpToolRequest` dispatches successfully with no auth
 * context supplied at all, by design.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import { PassThrough } from "node:stream"
import type { IncomingMessage, ServerResponse } from "node:http"

vi.mock("../shell-bridge.js", () => ({
  enqueueShellBridgeQuery: vi.fn(),
}))

import { enqueueShellBridgeQuery } from "../shell-bridge.js"
import {
  handleMcpToolRequest,
  dispatchMcpToolHttp,
  MCP_PROXY_TOOL_NAMES,
} from "../mcp-tool-handler.js"
import { ROUTE_TABLE } from "../http-server.js"

const mockEnqueue = vi.mocked(enqueueShellBridgeQuery)

afterEach(() => {
  vi.clearAllMocks()
})

/** Minimal `ServerResponse` shim — status/headers/body capture only. */
class FakeRes {
  statusCode = 200
  headers: Record<string, string> = {}
  body = ""
  setHeader(name: string, value: string | number): void {
    this.headers[name.toLowerCase()] = String(value)
  }
  end(payload: string): void {
    this.body = payload
  }
}
function asRes(res: FakeRes): ServerResponse {
  return res as unknown as ServerResponse
}

/** A `PassThrough` fed with `body` and ended — enough for `dispatchMcpToolHttp`'s
 * `for await` body read + `req.on('close', ...)` abort wiring. */
function fakeRequest(body: string): IncomingMessage {
  const stream = new PassThrough()
  stream.end(body)
  return stream as unknown as IncomingMessage
}

describe("MCP_PROXY_TOOL_NAMES", () => {
  it("exposes exactly the three read/pin tools — propose_prop_edit is intentionally excluded", () => {
    expect(MCP_PROXY_TOOL_NAMES).toEqual(["get_selection", "get_page_info", "pin_selections"])
  })
})

describe("route table — auth posture for the MCP-proxy tool endpoint", () => {
  it("POST /api/editor/mcp/tool/* is gated bearer-origin-if-present at the route layer", () => {
    const entry = ROUTE_TABLE.find(
      (e) => e.method === "POST" && e.path === "/api/editor/mcp/tool/*",
    )
    expect(entry).toBeDefined()
    expect(entry?.authPolicy).toBe("bearer-origin-if-present")
  })
})

describe("handleMcpToolRequest — dispatch routing", () => {
  it("unknown tool name -> 404 listing the supported tools, without touching the bridge", async () => {
    const res = await handleMcpToolRequest(
      "nonexistent_tool",
      {},
      new AbortController().signal,
    )
    expect(res.status).toBe(404)
    expect(res.body.ok).toBe(false)
    if (!res.body.ok) {
      expect(res.body.reason).toMatch(/Unknown MCP tool 'nonexistent_tool'/)
      expect(res.body.reason).toMatch(/get_selection/)
    }
    expect(mockEnqueue).not.toHaveBeenCalled()
  })

  it("get_selection -> sends chat:get_selection over the bridge and returns 200", async () => {
    mockEnqueue.mockResolvedValue({ selector: ".foo" })
    const res = await handleMcpToolRequest("get_selection", {}, new AbortController().signal)
    expect(mockEnqueue).toHaveBeenCalledWith(
      "chat:get_selection",
      undefined,
      expect.objectContaining({ signal: expect.anything() }),
    )
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    if (res.body.ok) {
      expect(res.body.result.content[0].text).toBe(JSON.stringify({ selector: ".foo" }))
    }
  })

  it("get_page_info -> sends chat:get_page_info over the bridge", async () => {
    mockEnqueue.mockResolvedValue({ route: "/dashboard" })
    const res = await handleMcpToolRequest("get_page_info", {}, new AbortController().signal)
    expect(mockEnqueue).toHaveBeenCalledWith(
      "chat:get_page_info",
      undefined,
      expect.objectContaining({ signal: expect.anything() }),
    )
    expect(res.status).toBe(200)
  })

  it("pin_selections -> forwards the selectors array to chat:pin_selections", async () => {
    mockEnqueue.mockResolvedValue({ pinned: 2 })
    const res = await handleMcpToolRequest(
      "pin_selections",
      { input: { selectors: [".a", ".b"] } },
      new AbortController().signal,
    )
    expect(mockEnqueue).toHaveBeenCalledWith(
      "chat:pin_selections",
      { selectors: [".a", ".b"] },
      expect.objectContaining({ signal: expect.anything() }),
    )
    expect(res.status).toBe(200)
  })

  it("pin_selections -> 400 when input is missing entirely (selectors defaults to undefined, not an array)", async () => {
    // body.input is absent -> `body.input ?? {}` -> {selectors: undefined} ->
    // Array.isArray(undefined) is false -> 400, not a crash.
    const res = await handleMcpToolRequest("pin_selections", {}, new AbortController().signal)
    expect(res.status).toBe(400)
    expect(mockEnqueue).not.toHaveBeenCalled()
  })

  it("pin_selections -> 400 when selectors is not an array", async () => {
    const res = await handleMcpToolRequest(
      "pin_selections",
      { input: { selectors: "not-an-array" } },
      new AbortController().signal,
    )
    expect(res.status).toBe(400)
    if (!res.body.ok) expect(res.body.reason).toMatch(/selectors: string\[\]/)
  })

  it("pin_selections -> 400 when selectors contains a non-string element", async () => {
    const res = await handleMcpToolRequest(
      "pin_selections",
      { input: { selectors: [".a", 42] } },
      new AbortController().signal,
    )
    expect(res.status).toBe(400)
    if (!res.body.ok) expect(res.body.reason).toMatch(/array of strings/)
    expect(mockEnqueue).not.toHaveBeenCalled()
  })

  it(
    "a bridge rejection surfaces as HTTP 200 with an isError tool result, NOT a 500 — " +
      "getSelection/getPageInfo/pinSelections (editor-tool-handlers.ts) each catch their " +
      "own bridge.send() rejection internally and return { isError: true } rather than " +
      "throwing, so handleMcpToolRequest's outer try/catch (500 mapping) does NOT fire for a " +
      "bridge-level failure on any of the three tools — it's reserved for a different failure " +
      "class (malformed request body reaching pin_selections' inline validation; see the next " +
      "test). The caller (the MCP stdio proxy) sees a well-formed 200 response either way and " +
      "inspects `result.isError`.",
    async () => {
      mockEnqueue.mockRejectedValue(new Error("shell-bridge query timed out"))
      const res = await handleMcpToolRequest("get_selection", {}, new AbortController().signal)
      expect(res.status).toBe(200)
      expect(res.body.ok).toBe(true)
      if (res.body.ok) {
        expect(res.body.result.isError).toBe(true)
        expect(res.body.result.content[0].text).toMatch(/shell-bridge query timed out/)
      }
    },
  )

  it("handleMcpToolRequest's own 500 catch DOES fire for a malformed (non-object) body reaching pin_selections", async () => {
    // The three tool handlers (editor-tool-handlers.ts) each catch their own
    // bridge.send() rejection internally, so the outer try/catch in
    // handleMcpToolRequest is NOT dead code — it guards this different failure
    // mode: `pin_selections`'s inline validation does `body.input` before any
    // handler runs. A JSON body of literal `null` parses to `body === null`
    // (valid JSON, not an object), so `body.input` throws a TypeError that only
    // the outer catch observes. Reachable in practice via `dispatchMcpToolHttp`
    // when the proxy sends a POST body of `null`.
    const res = await handleMcpToolRequest(
      "pin_selections",
      null as unknown as { input?: unknown },
      new AbortController().signal,
    )
    expect(res.status).toBe(500)
    expect(res.body.ok).toBe(false)
    if (!res.body.ok) expect(res.body.reason).toMatch(/Cannot read propert/)
    expect(mockEnqueue).not.toHaveBeenCalled()
  })

  it(
    "dispatches successfully with no auth/Origin context supplied at all — pins the auth-posture " +
      "design: this layer performs no credential check of its own (see file-header note)",
    async () => {
      mockEnqueue.mockResolvedValue(null)
      const res = await handleMcpToolRequest("get_selection", {}, new AbortController().signal)
      expect(res.status).toBe(200)
    },
  )
})

describe("dispatchMcpToolHttp — HTTP body parsing", () => {
  it("malformed JSON body -> 400 with a structured error, not a crash", async () => {
    const req = fakeRequest("{not valid json")
    const res = new FakeRes()
    await expect(
      dispatchMcpToolHttp(req, asRes(res), "get_selection"),
    ).resolves.toBeUndefined()
    expect(res.statusCode).toBe(400)
    const body = JSON.parse(res.body) as { ok: boolean; reason: string }
    expect(body.ok).toBe(false)
    expect(body.reason).toMatch(/Invalid JSON body/)
    expect(mockEnqueue).not.toHaveBeenCalled()
  })

  it("an empty body parses as {} and dispatches a nullary tool normally", async () => {
    mockEnqueue.mockResolvedValue({ route: "/" })
    const req = fakeRequest("")
    const res = new FakeRes()
    await dispatchMcpToolHttp(req, asRes(res), "get_page_info")
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as { ok: boolean }
    expect(body.ok).toBe(true)
  })

  it("a well-formed JSON body naming an unknown tool -> 404 shape via the HTTP path", async () => {
    const req = fakeRequest("{}")
    const res = new FakeRes()
    await dispatchMcpToolHttp(req, asRes(res), "delete_everything")
    expect(res.statusCode).toBe(404)
    const body = JSON.parse(res.body) as { ok: boolean; reason: string }
    expect(body.ok).toBe(false)
    expect(body.reason).toMatch(/Unknown MCP tool/)
  })

  it("pin_selections validation failure round-trips through the HTTP layer as 400", async () => {
    const req = fakeRequest(JSON.stringify({ input: { selectors: [1, 2] } }))
    const res = new FakeRes()
    await dispatchMcpToolHttp(req, asRes(res), "pin_selections")
    expect(res.statusCode).toBe(400)
  })
})
