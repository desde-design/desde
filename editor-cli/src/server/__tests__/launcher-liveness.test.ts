/**
 * `isLauncherAlive` — the probe `GET /api/editor/home` runs before handing
 * the browser a parent launcher's URL.
 *
 * The edge cases live here, against stub servers. That a REAL launcher
 * answers this probe is asserted in `http-server-home.integration.test.ts`,
 * which boots one — the two halves together are what stop the launcher's
 * route and this probe drifting apart.
 */

import { afterEach, describe, expect, it } from "vitest"
import { createServer, type Server } from "node:http"
import { isLauncherAlive, LAUNCHER_ALIVE_PATH } from "../launcher-liveness.js"
import { pickFreePort } from "../launcher-server.js"

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((done) => {
          s.closeAllConnections()
          s.close(() => done())
        }),
    ),
  )
})

/** A stub on a free port. `handler` answers every request. */
async function stub(
  handler: (
    path: string,
  ) => { status: number; body: string } | { redirectTo: string } | "hang" | "hang-body",
): Promise<string> {
  const port = await pickFreePort()
  const server = createServer((req, res) => {
    const answer = handler(req.url ?? "")
    // Never answers at all — the socket is accepted and then nothing.
    if (answer === "hang") return
    // Answers the HEADERS, starts a JSON body, and never finishes it. A
    // timeout that only covered the response head would pass this and then
    // hang forever inside `res.json()`.
    if (answer === "hang-body") {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.write('{"ok":true,"role":"laun')
      return
    }
    if ("redirectTo" in answer) {
      res.writeHead(302, { Location: answer.redirectTo })
      res.end()
      return
    }
    res.writeHead(answer.status, { "Content-Type": "application/json" })
    res.end(answer.body)
  })
  servers.push(server)
  await new Promise<void>((done) => server.listen(port, "127.0.0.1", () => done()))
  return `http://127.0.0.1:${port}`
}

describe("isLauncherAlive", () => {
  it("is true for a server answering the probe as a launcher", async () => {
    const origin = await stub((path) =>
      path === LAUNCHER_ALIVE_PATH
        ? { status: 200, body: JSON.stringify({ ok: true, role: "launcher" }) }
        : { status: 404, body: "{}" },
    )
    expect(await isLauncherAlive(origin)).toBe(true)
  })

  it("is false when nothing is listening", async () => {
    const origin = `http://127.0.0.1:${await pickFreePort()}`
    expect(await isLauncherAlive(origin)).toBe(false)
  })

  it("is false when the port was reused by some other server", async () => {
    // The case the probe exists for: the launcher died and an unrelated dev
    // server took its port. A plain "did anything answer" check would send
    // the user's window to a stranger's page.
    const origin = await stub(() => ({ status: 200, body: "<!doctype html><title>not us</title>" }))
    expect(await isLauncherAlive(origin)).toBe(false)
  })

  it("is false for an editor on that port, not a launcher", async () => {
    // Both surfaces serve a bootstrap script, so "a Desde process answered"
    // is not the question — `role` is.
    const origin = await stub(() => ({ status: 200, body: JSON.stringify({ ok: true, role: "editor" }) }))
    expect(await isLauncherAlive(origin)).toBe(false)
  })

  it("is false when the port redirects to a real launcher elsewhere", async () => {
    // The probe answers a question about the origin the CALLER is about to
    // hand the browser. Following a redirect would answer it about some
    // other origin: a squatter on the reused port that 302s to a live
    // launcher would pass the role check on that launcher's behalf, and the
    // window would be sent to the squatter.
    const realLauncher = await stub((path) =>
      path === LAUNCHER_ALIVE_PATH
        ? { status: 200, body: JSON.stringify({ ok: true, role: "launcher" }) }
        : { status: 404, body: "{}" },
    )
    expect(await isLauncherAlive(realLauncher)).toBe(true)

    const squatter = await stub(() => ({ redirectTo: `${realLauncher}${LAUNCHER_ALIVE_PATH}` }))
    expect(await isLauncherAlive(squatter)).toBe(false)
  })

  it("is false when the server accepts but never answers", async () => {
    // Unbounded, this would wedge the Home click instead of failing it.
    const origin = await stub(() => "hang")
    expect(await isLauncherAlive(origin, { timeoutMs: 150 })).toBe(false)
  })

  it("is false when the server answers and then never finishes the body", async () => {
    // The probe's own comment claims the abort signal bounds the body read,
    // not just the response head. The test above does not show that — it
    // stalls before any headers — so this is the one that holds that claim
    // up. Without it the comment is an assertion about undici, untested.
    const origin = await stub(() => "hang-body")
    const startedAt = Date.now()
    expect(await isLauncherAlive(origin, { timeoutMs: 150 })).toBe(false)
    // Returned because it timed out, not because it read a whole body.
    expect(Date.now() - startedAt).toBeLessThan(2000)
  })
})
