/**
 * The launcher's "Your viewer" status route — the machine-level half of what
 * the editor's `/api/editor/viewer-auth` already serves.
 *
 * Before this existed the request fell through to the bundle's SPA fallback:
 * a 200 carrying `index.html`, which the dialog's `res.json()` threw on.
 * Exactly the failure the LLM credentials route had in 2026-09, which is why
 * this follows the same boot-and-request setup as
 * `launcher-server.integration.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { startLauncher, type LauncherHandle } from "../launcher-server.js"
import type { FolderPickResult } from "../folder-picker.js"

let handle: LauncherHandle
let tmpHome: string
let realHome: string | undefined
let bundleRoot: string

async function pickFreePort(): Promise<number> {
  const net = await import("node:net")
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.unref()
    probe.once("error", reject)
    probe.listen(0, "127.0.0.1", () => {
      const addr = probe.address()
      const p = typeof addr === "object" && addr ? addr.port : 0
      probe.close(() => resolve(p))
    })
  })
}

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "launcher-viewer-auth-home-"))
  realHome = process.env.HOME
  process.env.HOME = tmpHome
  bundleRoot = await fs.mkdtemp(path.join(os.tmpdir(), "launcher-viewer-auth-bundle-"))
  // Stub UI bundle — the launcher serves whatever index.html is at the root;
  // its own content is irrelevant to these routes.
  await fs.writeFile(
    path.join(bundleRoot, "index.html"),
    '<!doctype html><html><head><title>Editor</title></head><body><div id="root"></div></body></html>',
  )
  const port = await pickFreePort()
  handle = await startLauncher({
    port,
    seedDemo: false,
    spawnEditor: async (repoPath: string) => ({
      url: `http://127.0.0.1:9999/?opened=${encodeURIComponent(repoPath)}`,
    }),
    pickFolder: async (): Promise<FolderPickResult> => ({ supported: true, path: "/picked" }),
    uiBundleRoot: bundleRoot,
  })
})

afterEach(async () => {
  await handle.close()
  if (realHome === undefined) delete process.env.HOME
  else process.env.HOME = realHome
  await fs.rm(tmpHome, { recursive: true, force: true })
  await fs.rm(bundleRoot, { recursive: true, force: true })
})

/** The bootstrap script carries the per-session token; pull it out. */
async function tokenFromBootstrap(): Promise<string> {
  const res = await fetch(handle.url + "/__desde/bootstrap.js")
  const js = await res.text()
  const m = js.match(/window\.__DESDE_LAUNCHER__=(\{.*\});/)
  if (!m) throw new Error("launcher bootstrap payload not found")
  return (JSON.parse(m[1]) as { token: string }).token
}

describe("launcher viewer-auth", () => {
  it("answers the status route instead of 404ing as an unknown endpoint", async () => {
    // Before this route existed, the launcher's catch-all for an unmatched
    // `/api/*` path answered with a plain JSON 404 ("Unknown endpoint"),
    // which the dialog's `useViewerAuthStatus` hook read as "viewer
    // unreachable" and silently kept the panel in local-comment mode.
    const token = await tokenFromBootstrap()
    const res = await fetch(handle.url + "/api/editor/viewer-auth", {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("application/json")
    expect(await res.json()).toMatchObject({ defaultOrigin: null, hasToken: false })
  })

  it("reports no repo-specific link, because the launcher has no repo", async () => {
    const token = await tokenFromBootstrap()
    const res = await fetch(handle.url + "/api/editor/viewer-auth", {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(await res.json()).toMatchObject({
      configured: false,
      projectId: null,
      source: null,
      link: { status: "no-viewer" },
    })
  })

  it("refuses a write with no bearer", async () => {
    const res = await fetch(handle.url + "/api/editor/viewer-auth", {
      method: "POST",
      headers: { "content-type": "application/json", origin: handle.url },
      body: JSON.stringify({
        baseUrl: "https://viewer.test",
        token: `dsv_${"0".repeat(16)}_${"a".repeat(43)}`,
      }),
    })
    expect(res.status).toBe(401)
  })
})
