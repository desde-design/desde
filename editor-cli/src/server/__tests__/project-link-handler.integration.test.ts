/**
 * Integration coverage for `POST /api/editor/project/link` — boots a
 * real server, exercises the per-session bearer + Origin guard, and
 * asserts the merge-preserving `.desde/config.json` write + the
 * advisory git-remote check.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { startHttpServer, type HttpServerHandle } from "../http-server.js"
import { newSecurityContext } from "../auth.js"

const execFileAsync = promisify(execFile)

let handle: HttpServerHandle
let bundleDir: string
let repoDir: string
let token: string
let shellOrigin: string
// Redirect HOME so the link handler's best-effort recents-registry
// upsert (~/.desde/projects.json) writes to a throwaway dir, not
// the developer's real registry.
let tmpHome: string
let realHome: string | undefined

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

beforeEach(async () => {
  tmpHome = await mkdtemp(join(tmpdir(), "editor-link-home-"))
  realHome = process.env.HOME
  process.env.HOME = tmpHome
  bundleDir = await mkdtemp(join(tmpdir(), "editor-link-bundle-"))
  await writeFile(join(bundleDir, "index.html"), "<!doctype html><title>t</title>")
  repoDir = await mkdtemp(join(tmpdir(), "editor-link-repo-"))
  await execFileAsync("git", ["-C", repoDir, "init", "-q"])
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
  if (realHome === undefined) delete process.env.HOME
  else process.env.HOME = realHome
  await rm(tmpHome, { recursive: true, force: true })
  await rm(bundleDir, { recursive: true, force: true })
  await rm(repoDir, { recursive: true, force: true })
})

async function link(body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${shellOrigin}/api/editor/project/link`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      origin: shellOrigin,
      ...headers,
    },
    body: JSON.stringify(body),
  })
}

describe("POST /api/editor/project/link", () => {
  it("rejects an unauthenticated request", async () => {
    const res = await link({ projectId: "p", slug: "s" }, { authorization: "" })
    expect(res.status).toBe(401)
    // No config written.
    await expect(
      readFile(join(repoDir, ".desde/config.json"), "utf-8"),
    ).rejects.toThrow()
  })

  it("writes config.json and reports remote match", async () => {
    await execFileAsync("git", [
      "-C", repoDir, "remote", "add", "origin",
      "https://github.com/acme/app.git",
    ])
    const res = await link({
      projectId: "proj-1",
      slug: "my-app",
      repoFullName: "acme/app",
    })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.ok).toBe(true)
    expect(json.remote).toEqual({ status: "match" })

    const cfg = JSON.parse(
      await readFile(join(repoDir, ".desde/config.json"), "utf-8"),
    )
    expect(cfg).toMatchObject({
      version: 1,
      projectId: "proj-1",
      projectSlug: "my-app",
    })
  })

  it("still links but flags a remote mismatch", async () => {
    await execFileAsync("git", [
      "-C", repoDir, "remote", "add", "origin",
      "https://github.com/someone/else.git",
    ])
    const res = await link({
      projectId: "proj-2",
      slug: "my-app",
      repoFullName: "acme/app",
    })
    const json = await res.json()
    expect(json.ok).toBe(true)
    expect(json.remote).toEqual({ status: "mismatch", actual: "someone/else" })
  })

  it("rejects a malformed slug without writing", async () => {
    const res = await link({ projectId: "p", slug: "Bad Slug" })
    expect(res.status).toBe(400)
    await expect(
      readFile(join(repoDir, ".desde/config.json"), "utf-8"),
    ).rejects.toThrow()
  })

  it("rejects a non-http(s) platformBaseUrl without writing", async () => {
    for (const bad of ["not-a-url", "ftp://example.com", "/relative"]) {
      const res = await link({
        projectId: "p",
        slug: "my-app",
        platformBaseUrl: bad,
      })
      expect(res.status).toBe(400)
      await expect(
        readFile(join(repoDir, ".desde/config.json"), "utf-8"),
      ).rejects.toThrow()
    }
  })
})
