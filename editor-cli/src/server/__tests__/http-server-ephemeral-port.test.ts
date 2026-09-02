/**
 * `startHttpServer` must report the port it ACTUALLY bound.
 *
 * `listenOrigin` inside `startHttpServer` already read the real bound port,
 * but the returned `handle.url` was built from the REQUESTED one, so
 * `{ port: 0 }` produced `http://127.0.0.1:0` — an unusable URL, and the
 * reason `port: 0` was never adopted here.
 *
 * The workaround it forced is `pickFreePort`, copied into 48 files: bind 0,
 * read the assigned number, close, then let `startHttpServer` bind it again a
 * moment later. Closing a socket to learn its number leaves a window in which
 * another process can take that port. `port: 0` has no such window.
 *
 * HONEST SCOPE, because this file was written under a wrong hypothesis and
 * the comment should not outlive it. That window was hypothesised as the cause
 * of the `http-server-mini-turn-lock` flake ("green alone, red in the full
 * run") and MEASURED NOT to be: the real cause was a 26-second headless
 * browser launch on the mini-turn edit lane, fixed in `vitest.config.ts`. The
 * `ECONNREFUSED` in that failure arrived 918ms AFTER the 30s deadline, from a
 * request hitting a server `afterEach` had already closed.
 *
 * So this is a plain correctness bug with a plain test. It removes a hazard;
 * it is not credited with fixing anything that was observed failing.
 */
import { afterEach, describe, expect, it } from "vitest"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startHttpServer, type HttpServerHandle } from "../http-server.js"
import { newSecurityContext } from "../auth.js"

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c().catch(() => {})
})

async function startOnEphemeralPort(): Promise<HttpServerHandle> {
  const bundleDir = await mkdtemp(join(tmpdir(), "editor-cli-ephemeral-bundle-"))
  await writeFile(join(bundleDir, "index.html"), "<!doctype html><title>test</title>")
  const repoDir = await mkdtemp(join(tmpdir(), "editor-cli-ephemeral-repo-"))

  const handle = await startHttpServer({
    host: "127.0.0.1",
    // The whole point: no pre-picked port, so no window to lose.
    port: 0,
    repoRoot: repoDir,
    uiBundleRoot: bundleDir,
    viteUrl: "http://localhost:5173",
    security: newSecurityContext("http://127.0.0.1:1"),
  })

  cleanups.push(async () => {
    await handle.close()
    await rm(bundleDir, { recursive: true, force: true })
    await rm(repoDir, { recursive: true, force: true })
  })
  return handle
}

describe("startHttpServer — port 0", () => {
  it("reports the port it actually bound, not the one it was asked for", async () => {
    const handle = await startOnEphemeralPort()
    // The bug: this was `http://127.0.0.1:0`.
    expect(handle.url).not.toContain(":0")
    const port = Number(new URL(handle.url).port)
    expect(Number.isInteger(port)).toBe(true)
    expect(port).toBeGreaterThan(0)
  })

  it("serves on the URL it reports", async () => {
    const handle = await startOnEphemeralPort()
    // The assertion that matters. A handle whose `url` does not answer is
    // worse than one that throws, because every caller believes it.
    const res = await fetch(`${handle.url}/`)
    expect(res.status).toBeLessThan(500)
  })

  it("gives two concurrent servers different ports", async () => {
    // Two servers started at once is the situation that was breaking: with
    // `port: 0` the OS assigns while holding, so there is no gap in which a
    // second binder can be handed the same number.
    const [a, b] = await Promise.all([startOnEphemeralPort(), startOnEphemeralPort()])
    expect(a.url).not.toBe(b.url)
    for (const handle of [a, b]) {
      const res = await fetch(`${handle.url}/`)
      expect(res.status).toBeLessThan(500)
    }
  })
})
