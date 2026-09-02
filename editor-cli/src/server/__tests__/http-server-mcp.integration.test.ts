import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startHttpServer, type HttpServerHandle } from "../http-server.js"
import { newSecurityContext } from "../auth.js"
import {
  SCHEMA_VERSION,
  SCHEMA_VERSION_HEADER,
  validateStatusResponse,
} from "../../../../src/editor/mcp/status-schema.js"

/**
 * End-to-end integration coverage for the /mcp/* routing layer.
 *
 * Unit tests cover the handler in isolation (mcp-handler.test.ts) and
 * the auth layer in isolation (auth.test.ts). This test proves the
 * routing wires them together — the right auth policy applies to the
 * right path prefix, the right handler runs, and the response carries
 * the contract-mandated headers.
 *
 * We boot a real `http.Server`, hit it with `fetch`, and tear down.
 * Slower than a unit test but the routing layer is the seam most
 * likely to bit-rot under refactors.
 */

let handle: HttpServerHandle
let bundleDir: string
let repoDir: string
let token: string
let shellOrigin: string

beforeEach(async () => {
  bundleDir = await mkdtemp(join(tmpdir(), "editor-cli-bundle-"))
  await writeFile(join(bundleDir, "index.html"), "<!doctype html><title>test</title>")

  // Create a temp directory that's NOT a git repo. The handler will
  // surface a `git: ...` warning but still return a valid payload —
  // that's the graceful-degrade contract we're verifying.
  repoDir = await mkdtemp(join(tmpdir(), "editor-cli-repo-"))
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

describe("HTTP /mcp/status — auth matrix", () => {
  it("returns 200 + valid StatusResponse with no Origin + valid bearer (if-present policy)", async () => {
    const res = await fetch(`${handle.url}/mcp/status`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get(SCHEMA_VERSION_HEADER)).toBe(String(SCHEMA_VERSION))
    expect(res.headers.get("cache-control")).toBe("no-store")
    const body = await res.json()
    expect(validateStatusResponse(body).ok).toBe(true)
  })

  it("returns 200 with matching Origin + valid bearer", async () => {
    const res = await fetch(`${handle.url}/mcp/status`, {
      headers: {
        Origin: shellOrigin,
        Authorization: `Bearer ${token}`,
      },
    })
    expect(res.status).toBe(200)
    expect(validateStatusResponse(await res.json()).ok).toBe(true)
  })

  it("returns 403 when Origin is present but mismatched (defense-in-depth)", async () => {
    const res = await fetch(`${handle.url}/mcp/status`, {
      headers: {
        Origin: "https://evil.example",
        Authorization: `Bearer ${token}`,
      },
    })
    expect(res.status).toBe(403)
  })

  it("returns 401 with no bearer regardless of Origin presence", async () => {
    const noOrigin = await fetch(`${handle.url}/mcp/status`)
    expect(noOrigin.status).toBe(401)
    const withOrigin = await fetch(`${handle.url}/mcp/status`, {
      headers: { Origin: shellOrigin },
    })
    expect(withOrigin.status).toBe(401)
  })

  it("returns 401 with wrong bearer", async () => {
    const res = await fetch(`${handle.url}/mcp/status`, {
      headers: { Authorization: "Bearer wrong-token" },
    })
    expect(res.status).toBe(401)
  })
})

describe("HTTP /api/* — preserved strict-Origin policy", () => {
  // The invariant is unchanged — /api/* STATE-CHANGING requests still demand
  // an exact Origin, which is what separates them from /mcp/*. Only the
  // example moved: this used to assert it against GET /api/health, and a GET
  // cannot carry that requirement. Browsers omit `Origin` on same-origin GETs
  // and page JS cannot add it, so a GET pinned to `required` 403s the
  // Editor's own UI forever (measured 2026-08-09 — it is why the viewer-auth
  // status probe silently never worked). A write is the honest example.
  it("returns 403 for a WRITE with no Origin, even with a valid bearer", async () => {
    const res = await fetch(`${handle.url}/api/editor/viewer-auth`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(403)
  })

  it("lets that same write through with a matching Origin", async () => {
    // Any non-403 proves the Origin gate opened; the handler's own 400 for an
    // empty body is not this test's business.
    const res = await fetch(`${handle.url}/api/editor/viewer-auth`, {
      method: "POST",
      headers: {
        Origin: shellOrigin,
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    })
    expect(res.status).not.toBe(403)
  })

  it("returns 200 for a READ with no Origin — deliberate, not a weakening", async () => {
    // GET /api/health is `bearer-origin-if-present`. The bearer is still
    // required (see the next case); a mismatched Origin is still rejected.
    const res = await fetch(`${handle.url}/api/health`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
  })

  it("still refuses that READ without a bearer", async () => {
    const res = await fetch(`${handle.url}/api/health`)
    expect(res.status).toBe(401)
  })

  it("still refuses that READ with a MISMATCHED Origin", async () => {
    const res = await fetch(`${handle.url}/api/health`, {
      headers: { Origin: "http://evil.example", Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(403)
  })
})

describe("HTTP /mcp/* — unknown endpoints", () => {
  it("returns 404 with structured body for unknown MCP route", async () => {
    const res = await fetch(`${handle.url}/mcp/does-not-exist`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { ok: boolean; reason?: string }
    expect(body.ok).toBe(false)
    expect(body.reason).toMatch(/Unknown MCP/i)
  })
})
