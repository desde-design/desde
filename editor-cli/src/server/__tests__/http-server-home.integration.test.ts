/**
 * Integration coverage for `GET /api/editor/home` — the breadcrumb
 * "home" affordance. Boots a real server, asserts the per-session bearer
 * guard, and that a call lazily starts a launcher and returns a URL whose
 * picker page is reachable. Closing the server tears the launcher down too.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startHttpServer, type HttpServerHandle } from "../http-server.js"
import { newSecurityContext } from "../auth.js"
import { pickFreePort } from "../launcher-server.js"

let handle: HttpServerHandle
let bundleDir: string
let repoDir: string
let token: string
let shellOrigin: string

beforeEach(async () => {
  bundleDir = await mkdtemp(join(tmpdir(), "editor-home-bundle-"))
  await writeFile(join(bundleDir, "index.html"), "<!doctype html><title>t</title>")
  repoDir = await mkdtemp(join(tmpdir(), "editor-home-repo-"))
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

describe("GET /api/editor/home", () => {
  it("rejects an unauthenticated request", async () => {
    const res = await fetch(`${shellOrigin}/api/editor/home`)
    expect(res.status).toBe(401)
  })

  it("lazily starts a launcher and returns a reachable picker URL", async () => {
    const res = await fetch(`${shellOrigin}/api/editor/home`, {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.ok).toBe(true)
    expect(json.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)

    // The launcher serves the same UI bundle as this editor, with the
    // launcher bootstrap script injected (main.tsx branches on it).
    const picker = await fetch(`${json.url}/`)
    expect(picker.status).toBe(200)
    const html = await picker.text()
    expect(html).toContain("<title>t</title>")
    expect(html).toContain('<script src="/__desde/bootstrap.js"></script>')
  })

  it("reuses the same launcher across calls (one per process)", async () => {
    const auth = { authorization: `Bearer ${token}` }
    const first = await (
      await fetch(`${shellOrigin}/api/editor/home`, { headers: auth })
    ).json()
    const second = await (
      await fetch(`${shellOrigin}/api/editor/home`, { headers: auth })
    ).json()
    expect(second.url).toBe(first.url)
  })
})
