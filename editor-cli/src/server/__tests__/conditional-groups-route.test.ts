/**
 * Integration coverage for GET /api/editor/conditional-groups
 * (http-server.ts ~1248).
 *
 * Boots a real http.Server (same pattern as
 * artifact-routes.integration.test.ts) and hits the route with `fetch`
 * so the routing seam — auth gate, path-traversal guard via
 * readPrototypeFile, the .vue vs. non-.vue branch, and the
 * listConditionalGroups wiring — is proven end to end rather than unit
 * tested in isolation.
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
  bundleDir = await mkdtemp(join(tmpdir(), "editor-cli-cgroups-bundle-"))
  await writeFile(join(bundleDir, "index.html"), "<!doctype html><title>test</title>")

  repoDir = await mkdtemp(join(tmpdir(), "editor-cli-cgroups-repo-"))
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

function authedFetch(input: string, init: RequestInit = {}): Promise<Response> {
  return fetch(input, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Origin: shellOrigin,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  })
}

const VUE_IF_ELSE_CHAIN = `<template>
  <section>
    <template v-if="multi">
      <div class="cards">many</div>
    </template>
    <template v-else-if="one">
      <div class="card">one</div>
    </template>
    <template v-else>
      <div class="empty">none</div>
    </template>
  </section>
</template>
`

describe("GET /api/editor/conditional-groups", () => {
  it("returns 200 with one group of three branches for a v-if/v-else chain", async () => {
    await mkdir(join(repoDir, "src"), { recursive: true })
    await writeFile(join(repoDir, "src/App.vue"), VUE_IF_ELSE_CHAIN, "utf8")

    const res = await authedFetch(
      `${handle.url}/api/editor/conditional-groups?file=src/App.vue`,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      ok: boolean
      groups: { branches: unknown[] }[]
      fileHash: string
    }
    expect(body.ok).toBe(true)
    expect(body.groups).toHaveLength(1)
    expect(body.groups[0].branches).toHaveLength(3)
    expect(body.fileHash).toMatch(/^[0-9a-f]{12}$/)
  })

  it("rejects path traversal outside the repo root (400)", async () => {
    const res = await authedFetch(
      `${handle.url}/api/editor/conditional-groups?file=../outside.vue`,
    )
    expect(res.status).toBe(400)
  })

  it("rejects a missing file param (400)", async () => {
    const res = await authedFetch(`${handle.url}/api/editor/conditional-groups`)
    expect(res.status).toBe(400)
  })

  it("returns 200 with empty groups for a non-.vue file", async () => {
    await mkdir(join(repoDir, "src"), { recursive: true })
    await writeFile(
      join(repoDir, "src/App.tsx"),
      "export default function App() { return null }\n",
      "utf8",
    )

    const res = await authedFetch(
      `${handle.url}/api/editor/conditional-groups?file=src/App.tsx`,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      ok: boolean
      groups: unknown[]
      fileHash: string
    }
    expect(body.ok).toBe(true)
    expect(body.groups).toEqual([])
    expect(body.fileHash).toMatch(/^[0-9a-f]{12}$/)
  })

  it("rejects a request without a bearer token (401)", async () => {
    const res = await fetch(
      `${handle.url}/api/editor/conditional-groups?file=src/App.vue`,
    )
    expect(res.status).toBe(401)
  })
})
