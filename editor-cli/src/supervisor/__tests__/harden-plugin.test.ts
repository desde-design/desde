/**
 * Regression test for the plugin-hook bypass of `hardenServerConfig`.
 *
 * `hardenServerConfig` pins its security keys on the InlineConfig handed to
 * `createServer`. EVERY plugin hook runs after that, so until `hardenPlugin`
 * existed a plugin in the repo's own `vite.config` could undo all of them from
 * a six-line `configResolved`. MEASURED on this checkout with the plugin
 * removed — all three of these serve:
 *
 *   RESOLVED fs.strict=false  fs.deny=[]  fs.allow=["/"]  allowedHosts=true
 *   GET /@fs<root>/.env                  -> 200   SECRET_TOKEN=hunter2
 *   GET /@fs<root>/.desde/…/s1.json -> 200   the chat transcript
 *   GET / with Host: evil.test           -> 200   host validation skipped
 *
 * With it, 403 / 403 / 403. The counterfactual was run both ways; this file is
 * the standing version of that check.
 *
 * Scope, stated honestly: a `vite.config` is arbitrary Node run in our process,
 * so an author who WANTS the developer's disk can read it directly and never
 * touch Vite's config. This does not sandbox a hostile config and must not be
 * sold as doing so. It closes ACCIDENTAL widening — the `fs.allow: ['/']` or
 * `allowedHosts: true` a real plugin leaves behind — and `allowedHosts` is the
 * key that carries the weight, because host validation is the only thing
 * standing between a DNS-rebound page and a loopback-bound dev server.
 *
 * Note `fs.allow` is deliberately NOT pinned, matching `hardenServerConfig`:
 * widening the allow LIST is the supported escape hatch. The invariants are
 * `fs.deny`, `fs.strict`, `cors` and `allowedHosts`.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { connect as netConnect } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { bootSupervisor, type SupervisorHandle } from "../vite-supervisor.js"

/** Distinctive and fixed: the supervisor pins `strictPort`, so `0` is not an option. */
const PORT = 43977

let root: string
let handle: SupervisorHandle | null = null

/** Re-widens every pinned key from `configResolved` — i.e. after our pinning. */
const HOSTILE_CONFIG = `
import type { Plugin } from "vite"

const rewiden = (): Plugin => ({
  name: "rewiden-after-harden",
  enforce: "post",
  configResolved(resolved: any) {
    resolved.server.fs.strict = false
    resolved.server.fs.deny = []
    resolved.server.fs.allow = ["/"]
    resolved.server.allowedHosts = true
    resolved.server.cors = true
  },
})

export default { plugins: [rewiden()] }
`

/** Raw socket: `Host` is a forbidden header in undici, so `fetch` cannot test it. */
function getWithHost(host: string): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const socket = netConnect(PORT, "127.0.0.1", () => {
      socket.write(`GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`)
    })
    let buf = ""
    socket.on("data", (chunk) => {
      buf += chunk.toString()
    })
    socket.on("end", () => {
      const match = /^HTTP\/1\.\d (\d{3})/.exec(buf)
      resolvePromise(match ? Number(match[1]) : -1)
    })
    socket.on("error", reject)
  })
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "pt-harden-plugin-"))
  writeFileSync(join(root, "vite.config.ts"), HOSTILE_CONFIG)
  writeFileSync(join(root, "index.html"), "<!doctype html><html><body>hi</body></html>")
  writeFileSync(join(root, ".env"), "SECRET_TOKEN=hunter2\n")
  mkdirSync(join(root, ".desde", "chat-sessions"), { recursive: true })
  writeFileSync(
    join(root, ".desde", "chat-sessions", "s1.json"),
    JSON.stringify({ transcript: "PRIVATE_CHAT_CONTENT" }),
  )

  handle = await bootSupervisor({
    repoRoot: root,
    prototypeRoot: root,
    plugins: [],
    host: "127.0.0.1",
    port: PORT,
  })
}, 60_000)

afterAll(async () => {
  await handle?.close().catch(() => {})
  if (root) rmSync(root, { recursive: true, force: true })
})

describe("hardenPlugin — a repo plugin cannot re-widen from configResolved", () => {
  it("re-pins fs.strict and allowedHosts in the resolved config", () => {
    const resolved = handle!.vite.server.config
    expect(resolved.server.fs?.strict).toBe(true)
    expect(resolved.server.allowedHosts).toEqual([])
  })

  it("refuses .env even though the plugin cleared fs.deny", async () => {
    const res = await fetch(`${handle!.url}/@fs${root}/.env`)
    expect(res.status).toBe(403)
  })

  it("refuses .desde chat transcripts", async () => {
    const res = await fetch(`${handle!.url}/@fs${root}/.desde/chat-sessions/s1.json`)
    expect(res.status).toBe(403)
    expect(await res.text()).not.toContain("PRIVATE_CHAT_CONTENT")
  })

  it("refuses a foreign Host header", async () => {
    expect(await getWithHost("evil.test")).toBe(403)
  })

  it("still answers on the real authority", async () => {
    expect(await getWithHost(`127.0.0.1:${PORT}`)).toBe(200)
  })

  it("keeps the deny matcher live even though the resolved array reads empty", () => {
    // Documents WHY the `config` hook is load-bearing and cannot be folded
    // into `configResolved`: Vite compiles `fs.deny` into a picomatch matcher
    // during `resolveConfig`, and `isFileLoadingAllowed` consults the matcher,
    // not the array. So the hostile plugin's later `deny = []` is inert — the
    // array below genuinely IS empty while the 403s above still hold.
    expect(handle!.vite.server.config.server.fs?.deny).toEqual([])
  })
})
