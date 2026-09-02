/**
 * Integration coverage for Task 7 of the editor audit-fixes plan:
 * the 11 inline `for await (const chunk of req) raw += chunk`
 * body-readers in `http-server.ts` (no size cap at all) were replaced
 * with the shared, byte-capped `readRawBody` (`http-body.ts`). This
 * proves the per-route wiring end-to-end over a real HTTP server:
 *
 *   - under the cap: the request reaches JSON.parse (proven by
 *     sending deliberately-invalid-but-small JSON and getting each
 *     route's normal 400 "Invalid JSON body" — NOT a 413).
 *   - over the cap: the route responds 413 in its own `{ ok: false,
 *     reason }` shape rather than accumulating the body.
 *   - the two source-carrying routes (`/api/editor/edit`,
 *     `/api/editor/llm-fallback`) get the wider 1 MiB cap; a
 *     branch-mutation route gets the 256 KiB default.
 *
 * Same boot pattern as `http-server-lock-events.integration.test.ts` /
 * `artifact-routes.integration.test.ts`: real `http.Server`, real
 * `fetch`.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startHttpServer, type HttpServerHandle } from "../http-server.js"
import { newSecurityContext } from "../auth.js"

let handle: HttpServerHandle
let bundleDir: string
let repoDir: string
let token: string
let shellOrigin: string

beforeEach(async () => {
  bundleDir = await mkdtemp(join(tmpdir(), "editor-cli-bodycap-bundle-"))
  await writeFile(join(bundleDir, "index.html"), "<!doctype html><title>test</title>")

  repoDir = await mkdtemp(join(tmpdir(), "editor-cli-bodycap-repo-"))
  await mkdir(repoDir, { recursive: true })

  const port = await pickFreePort()
  shellOrigin = `http://127.0.0.1:${port}`
  const security = newSecurityContext(shellOrigin)
  token = security.token

  handle = await startHttpServer({
    host: "127.0.0.1",
    port,
    repoRoot: repoDir,
    uiBundleRoot: bundleDir,
    viteUrl: "http://localhost:5173",
    security,
  })
})

afterEach(async () => {
  await handle.close()
  await rm(bundleDir, { recursive: true, force: true })
  await rm(repoDir, { recursive: true, force: true })
})

async function pickFreePort(): Promise<number> {
  const net = await import("node:net")
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address()
      const port = typeof addr === "object" && addr ? addr.port : 0
      server.close(() => resolve(port))
    })
  })
}

function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${handle.url}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Origin: shellOrigin,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  })
}

const DEFAULT_CAP = 256 * 1024
const EDIT_CAP = 1024 * 1024

describe("/api/editor/branches/switch — 256 KiB default cap", () => {
  it("under the cap: reaches JSON.parse (invalid JSON -> 400, not 413)", async () => {
    const res = await authedFetch("/api/editor/branches/switch", {
      method: "POST",
      body: "{not valid json",
    })
    expect(res.status).toBe(400)
    const json = (await res.json()) as { ok: false; reason: string }
    expect(json.ok).toBe(false)
    expect(json.reason).toMatch(/Invalid JSON body/)
  })

  it("under the cap: missing 'name' still gets a normal 400 (body was read)", async () => {
    const res = await authedFetch("/api/editor/branches/switch", {
      method: "POST",
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
    const json = (await res.json()) as { ok: false; reason: string }
    expect(json.reason).toMatch(/name/i)
  })

  it("over the cap (300 KiB): 413 in the route's { ok, reason } shape", async () => {
    const huge = "x".repeat(300 * 1024)
    const res = await authedFetch("/api/editor/branches/switch", {
      method: "POST",
      body: JSON.stringify({ name: huge }),
    })
    expect(res.status).toBe(413)
    const json = (await res.json()) as { ok: false; reason: string }
    expect(json.ok).toBe(false)
    expect(json.reason).toMatch(new RegExp(`${DEFAULT_CAP} bytes`))
  })
})

describe("/api/editor/edit — 1 MiB cap (source-carrying payloads)", () => {
  it("under the cap: reaches JSON.parse (invalid JSON -> 400, not 413)", async () => {
    const res = await authedFetch("/api/editor/edit", {
      method: "POST",
      body: "{not valid json",
    })
    expect(res.status).toBe(400)
    const json = (await res.json()) as { ok: false; reason: string }
    expect(json.reason).toMatch(/Invalid JSON body/)
  })

  it("a 300 KiB body (over the artifact-route default, under 1 MiB) is NOT rejected as too large", async () => {
    // Proves the edit route got the wider 1 MiB cap, not the 256 KiB
    // default — a payload that would 413 on /branches/switch should
    // sail through the body-read stage here (it may still 400 later
    // on business-rule validation, but never 413).
    const big = "x".repeat(300 * 1024)
    const res = await authedFetch("/api/editor/edit", {
      method: "POST",
      body: JSON.stringify({ probe: big }),
    })
    expect(res.status).not.toBe(413)
  })

  it("over the cap (1.2 MiB): 413 in the route's { ok, reason } shape", async () => {
    const huge = "x".repeat(EDIT_CAP + 200 * 1024)
    const res = await authedFetch("/api/editor/edit", {
      method: "POST",
      body: JSON.stringify({ probe: huge }),
    })
    expect(res.status).toBe(413)
    const json = (await res.json()) as { ok: false; reason: string }
    expect(json.ok).toBe(false)
    expect(json.reason).toMatch(new RegExp(`${EDIT_CAP} bytes`))
  })
})

describe("/api/editor/chat/sessions/:id/apply-merge-resolution — 1 MiB cap (source-carrying payloads)", () => {
  const route = "/api/editor/chat/sessions/test-session-1/apply-merge-resolution"

  it("under the cap: reaches JSON.parse (invalid JSON -> 400, not 413)", async () => {
    const res = await authedFetch(route, {
      method: "POST",
      body: "{not valid json",
    })
    expect(res.status).toBe(400)
    const json = (await res.json()) as { ok: false; reason: string }
    expect(json.reason).toMatch(/valid JSON/)
  })

  it("a 300 KiB body (over the artifact-route default, under 1 MiB) is NOT rejected as too large", async () => {
    // Proves the route got the wider 1 MiB cap, not the 256 KiB default —
    // a payload that would 413 on /branches/switch should sail through the
    // body-read stage here (the session won't exist so it 404s deeper in
    // the handler, but it must never be a 413).
    const big = "x".repeat(300 * 1024)
    const res = await authedFetch(route, {
      method: "POST",
      body: JSON.stringify({ file: "src/App.vue", resolvedContent: big }),
    })
    expect(res.status).not.toBe(413)
  })

  it("over the cap (1.2 MiB): 413 in the route's { ok, reason } shape", async () => {
    const huge = "x".repeat(EDIT_CAP + 200 * 1024)
    const res = await authedFetch(route, {
      method: "POST",
      body: JSON.stringify({ file: "src/App.vue", resolvedContent: huge }),
    })
    expect(res.status).toBe(413)
    const json = (await res.json()) as { ok: false; reason: string }
    expect(json.ok).toBe(false)
    expect(json.reason).toMatch(new RegExp(`${EDIT_CAP} bytes`))
  })
})

describe("/api/editor/llm-fallback — 1 MiB cap (source-carrying payloads)", () => {
  it("under the cap: reaches JSON.parse (invalid JSON -> 400, not 413)", async () => {
    const res = await authedFetch("/api/editor/llm-fallback", {
      method: "POST",
      body: "{not valid json",
    })
    expect(res.status).toBe(400)
    const json = (await res.json()) as { ok: false; reason: string }
    expect(json.reason).toMatch(/Invalid JSON body/)
  })

  it("over the cap (1.2 MiB): 413 in the route's { ok, reason } shape", async () => {
    const huge = "x".repeat(EDIT_CAP + 200 * 1024)
    const res = await authedFetch("/api/editor/llm-fallback", {
      method: "POST",
      body: JSON.stringify({ probe: huge }),
    })
    expect(res.status).toBe(413)
    const json = (await res.json()) as { ok: false; reason: string }
    expect(json.ok).toBe(false)
    expect(json.reason).toMatch(new RegExp(`${EDIT_CAP} bytes`))
  })
})

// Task: wave item 2 of the final editor audit-fixes wave (2026-08-05) —
// three body readers that were still using the uncapped inline
// `for await (const chunk of req) raw += chunk` accumulator were migrated
// onto the shared `readRawBody` here: `mcp-tool-handler.ts`,
// `edit-iteration-handler.ts` (source-carrying — gets the 1 MiB EDIT cap),
// and `smoke-test-handler.ts`. This block covers the source-carrying one;
// the other two are exercised indirectly by their own route/handler tests
// but didn't have a dedicated cap assertion before this wave either.
describe("/api/editor/edit-iteration — 1 MiB cap (source-carrying payloads)", () => {
  it("under the cap: reaches JSON.parse (invalid JSON -> 400, not 413)", async () => {
    const res = await authedFetch("/api/editor/edit-iteration", {
      method: "POST",
      body: "{not valid json",
    })
    expect(res.status).toBe(400)
    const json = (await res.json()) as { ok: false; reason: string }
    expect(json.reason).toMatch(/Invalid JSON body/)
  })

  it("a 300 KiB body (over the artifact-route default, under 1 MiB) is NOT rejected as too large", async () => {
    // Proves the route got the wider 1 MiB cap, not the 256 KiB default —
    // a payload that would 413 on /branches/switch should sail through the
    // body-read stage here (it will still 400 on business-rule validation
    // for a made-up file/location, but never 413).
    const big = "x".repeat(300 * 1024)
    const res = await authedFetch("/api/editor/edit-iteration", {
      method: "POST",
      body: JSON.stringify({
        file: "src/App.vue",
        templateLocation: { line: 1, column: 1 },
        iterationContext: { key: big, index: 0, siblingCount: 1 },
        payload: { operation: "remove" },
      }),
    })
    expect(res.status).not.toBe(413)
  })

  it("over the cap (1.2 MiB): 413 in the route's { ok, reason } shape", async () => {
    const huge = "x".repeat(EDIT_CAP + 200 * 1024)
    const res = await authedFetch("/api/editor/edit-iteration", {
      method: "POST",
      body: JSON.stringify({ probe: huge }),
    })
    expect(res.status).toBe(413)
    const json = (await res.json()) as { ok: false; reason: string }
    expect(json.ok).toBe(false)
    expect(json.reason).toMatch(new RegExp(`${EDIT_CAP} bytes`))
  })
})

describe("/api/editor/mcp/tool/:name — 256 KiB default cap", () => {
  it("under the cap: reaches JSON.parse (invalid JSON -> 400, not 413)", async () => {
    const res = await authedFetch("/api/editor/mcp/tool/get_selection", {
      method: "POST",
      body: "{not valid json",
    })
    expect(res.status).toBe(400)
    const json = (await res.json()) as { ok: false; reason: string }
    expect(json.reason).toMatch(/Invalid JSON body/)
  })

  it("over the cap (300 KiB): 413 in the route's { ok, reason } shape", async () => {
    const huge = "x".repeat(300 * 1024)
    const res = await authedFetch("/api/editor/mcp/tool/get_selection", {
      method: "POST",
      body: JSON.stringify({ input: { probe: huge } }),
    })
    expect(res.status).toBe(413)
    const json = (await res.json()) as { ok: false; reason: string }
    expect(json.ok).toBe(false)
    expect(json.reason).toMatch(new RegExp(`${DEFAULT_CAP} bytes`))
  })
})

describe("/api/editor/smoke-test — 256 KiB default cap", () => {
  it("under the cap: reaches JSON.parse (invalid JSON -> 400, not 413)", async () => {
    // A non-empty, invalid-JSON body 400s before `runSmoke` is ever
    // invoked — proves the body was read to completion (not truncated
    // by a false-positive cap) without actually launching a browser.
    const res = await authedFetch("/api/editor/smoke-test", {
      method: "POST",
      body: "{not valid json",
    })
    expect(res.status).toBe(400)
    const json = (await res.json()) as { ok: false; reason: string }
    expect(json.reason).toMatch(/Invalid JSON body/)
  })

  it("over the cap (300 KiB): 413 in the route's { ok, reason } shape", async () => {
    const huge = "x".repeat(300 * 1024)
    const res = await authedFetch("/api/editor/smoke-test", {
      method: "POST",
      body: JSON.stringify({ routes: [huge] }),
    })
    expect(res.status).toBe(413)
    const json = (await res.json()) as { ok: false; reason: string }
    expect(json.ok).toBe(false)
    expect(json.reason).toMatch(new RegExp(`${DEFAULT_CAP} bytes`))
  })
})
