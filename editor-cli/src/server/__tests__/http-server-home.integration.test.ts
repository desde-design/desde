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
import { pickFreePort, startLauncher, type LauncherHandle } from "../launcher-server.js"

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
 * system browser (MEASURED 2026-09-01).
 *
 * But only while that launcher is actually there. The url arrives in an env
 * var at spawn time and the launcher is a separate process: it can die with
 * this editor still running, which is what a desktop update path did on
 * 2026-09-17. Home answered 200 with a dead port and the click did nothing
 * at all. So the url is probed, and a dead parent falls back to the lazy
 * start — the two cases below.
 */
describe("GET /api/editor/home with a parent launcher (homeUrl)", () => {
  let parented: HttpServerHandle
  let parentedOrigin: string
  let parentedToken: string
  let parentLauncher: string
  let liveParent: LauncherHandle | null

  async function bootParented(homeUrl: string): Promise<void> {
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
      homeUrl,
    })
  }

  function callHome(): Promise<Response> {
    return fetch(`${parentedOrigin}/api/editor/home`, {
      headers: { authorization: `Bearer ${parentedToken}` },
    })
  }

  beforeEach(() => {
    liveParent = null
  })

  afterEach(async () => {
    await parented.close()
    if (liveParent) await liveParent.close()
  })

  it("answers with a LIVE parent launcher's url and starts nothing", async () => {
    // A real launcher, so the probe runs against the route the launcher
    // actually serves. That pairing is what stops `launcher-liveness.ts` and
    // `launcher-server.ts` drifting apart — the probe's own unit tests use
    // stubs and could agree with themselves forever.
    liveParent = await startLauncher({
      host: "127.0.0.1",
      port: await pickFreePort(),
      uiBundleRoot: bundleDir,
      seedDemo: false,
    })
    parentLauncher = liveParent.url
    await bootParented(parentLauncher)

    const res = await callHome()
    expect(res.status).toBe(200)
    const json = (await res.json()) as { ok: boolean; url: string }
    // The parent's own url, unchanged: nothing else was started to answer.
    expect(json).toEqual({ ok: true, url: parentLauncher })
  })

  it("falls back once a parent launcher that WAS alive dies", async () => {
    // The real shape of the 2026-09-17 report: the launcher was there when
    // this editor was spawned and went away underneath it. The url in the
    // env var never changes, so only a probe at click time can tell.
    liveParent = await startLauncher({
      host: "127.0.0.1",
      port: await pickFreePort(),
      uiBundleRoot: bundleDir,
      seedDemo: false,
    })
    parentLauncher = liveParent.url
    await bootParented(parentLauncher)

    const whileAlive = (await (await callHome()).json()) as { url: string }
    expect(whileAlive.url).toBe(parentLauncher)

    await liveParent.close()
    liveParent = null

    const afterDeath = (await (await callHome()).json()) as { ok: boolean; url: string }
    expect(afterDeath.ok).toBe(true)
    expect(afterDeath.url).not.toBe(parentLauncher)
    expect((await fetch(`${afterDeath.url}/`)).status).toBe(200)
  })

  it("falls back to a lazy start when the parent launcher is gone", async () => {
    // A port picked fresh and left empty, so this cannot pass by accident
    // against whatever else is running on the machine.
    parentLauncher = `http://127.0.0.1:${await pickFreePort()}`
    await bootParented(parentLauncher)
    await expect(fetch(`${parentLauncher}/`)).rejects.toThrow()

    const res = await callHome()
    expect(res.status).toBe(200)
    const json = (await res.json()) as { ok: boolean; url: string }
    expect(json.ok).toBe(true)
    // The dead url is the one answer that must not come back — handing it to
    // the window is the defect this probe closes.
    expect(json.url).not.toBe(parentLauncher)

    // And what did come back is a launcher serving the picker.
    const picker = await fetch(`${json.url}/`)
    expect(picker.status).toBe(200)
    expect(await picker.text()).toContain('<script src="/__desde/bootstrap.js"></script>')
  })
})
