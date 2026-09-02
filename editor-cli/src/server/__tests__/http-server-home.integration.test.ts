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

/**
 * An editor spawned by a launcher must send Home back to THAT launcher, not
 * start a second one. The desktop shell has only ever been told about the
 * launcher it booted, so a fresh random-port launcher was handed to the
 * system browser (MEASURED 2026-09-01). The url is whatever the parent set,
 * echoed verbatim, and no launcher is started: nothing listens on it.
 */
describe("GET /api/editor/home with a parent launcher (homeUrl)", () => {
  let parented: HttpServerHandle
  let parentedOrigin: string
  let parentedToken: string
  // A port nothing listens on, picked fresh so the assertion below cannot be
  // satisfied by whatever happens to be running on this machine (the first
  // draft hard-coded 4321 and passed against a live desktop launcher).
  let parentLauncher: string

  beforeEach(async () => {
    parentLauncher = `http://127.0.0.1:${await pickFreePort()}`
    const port = await pickFreePort()
    parentedOrigin = `http://127.0.0.1:${port}`
    const security = newSecurityContext(parentedOrigin)
    parentedToken = security.token
    parented = await startHttpServer({
      host: "127.0.0.1",
      port,
      repoRoot: repoDir,
      uiBundleRoot: bundleDir,
      viteUrl: "http://localhost:5173",
      security,
      homeUrl: parentLauncher,
    })
  })
  afterEach(async () => {
    await parented.close()
  })

  it("answers with the parent launcher's url and starts nothing", async () => {
    const res = await fetch(`${parentedOrigin}/api/editor/home`, {
      headers: { authorization: `Bearer ${parentedToken}` },
    })
    expect(res.status).toBe(200)
    const json = (await res.json()) as { ok: boolean; url: string }
    expect(json).toEqual({ ok: true, url: parentLauncher })
    // Nothing was started on the parent's port by this process: the handle
    // owns no launcher, so closing it has nothing extra to tear down, and
    // the url is not something this test made reachable.
    await expect(fetch(`${parentLauncher}/`)).rejects.toThrow()
  })
})
