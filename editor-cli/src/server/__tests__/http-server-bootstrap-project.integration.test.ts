import type { ProjectIdentity } from "../../../../src/core/project-identity.js"
import { afterEach, describe, expect, it } from "vitest"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startHttpServer, type HttpServerHandle } from "../http-server.js"
import { newSecurityContext } from "../auth.js"

/**
 * Boots a real server and asserts the CLI bootstrap script exposes the
 * viewer-project association at `window.__DESDE_CLI__.project` —
 * including `identity` (embedded in `.desde/config.json`, the source
 * `project-menu.tsx`'s breadcrumb renders — see the 2026-08-08 audit fix:
 * this field used to be silently dropped from the payload even though
 * `ProjectMenu` always read it, so an unlinked repo with no legacy `slug`
 * rendered the literal string "Project"). No Firestore involved — sync with
 * a linked viewer goes over its HTTP API.
 */

let handle: HttpServerHandle
let bundleDir: string
let repoDir: string
let shellOrigin: string

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

async function boot(
  project?: {
    projectId: string | null
    slug: string | null
    identity?: ProjectIdentity | null
    platformBaseUrl: string | null
  },
  extras?: { repoRootReal?: string },
): Promise<void> {
  bundleDir = await mkdtemp(join(tmpdir(), "editor-cli-bundle-"))
  await writeFile(join(bundleDir, "index.html"), "<!doctype html><title>t</title>")
  repoDir = await mkdtemp(join(tmpdir(), "editor-cli-repo-"))
  const port = await pickFreePort()
  shellOrigin = `http://127.0.0.1:${port}`
  handle = await startHttpServer({
    host: "127.0.0.1",
    port,
    repoRoot: repoDir,
    uiBundleRoot: bundleDir,
    viteUrl: "http://localhost:5173",
    security: newSecurityContext(shellOrigin),
    // `identity` defaults to null so existing cases keep exercising the
    // "un-migrated repo" shape without restating it.
    ...(project ? { project: { identity: null, ...project } } : {}),
    ...extras,
  })
}

afterEach(async () => {
  await handle?.close()
  await rm(bundleDir, { recursive: true, force: true })
  await rm(repoDir, { recursive: true, force: true })
})

/** Fetch the bootstrap script and parse the injected JSON payload. */
async function readBootstrapPayload(): Promise<Record<string, unknown>> {
  const res = await fetch(`${shellOrigin}/__desde/bootstrap.js`)
  const body = await res.text()
  // Body is `window.__DESDE_CLI__=<json>;\n` (single line). Strip the
  // known prefix/suffix rather than a dotAll regex (the root tsconfig
  // targets < es2018, where the `s` flag isn't allowed).
  const jsonText = body
    .trim()
    .replace(/^window\.__DESDE_CLI__=/, "")
    .replace(/;$/, "")
  return JSON.parse(jsonText) as Record<string, unknown>
}

describe("bootstrap script — project association", () => {
  it("emits the linked projectId + slug, with identity null when the repo predates the identity migration", async () => {
    await boot({ projectId: "proj-1", slug: "my-app", platformBaseUrl: null })
    const payload = await readBootstrapPayload()
    expect(payload.project).toEqual({
      projectId: "proj-1",
      slug: "my-app",
      identity: null,
      platformBaseUrl: null,
    })
  })

  it("emits a null projectId for an unlinked repo", async () => {
    await boot()
    const payload = await readBootstrapPayload()
    expect(payload.project).toEqual({
      projectId: null,
      slug: null,
      identity: null,
      platformBaseUrl: null,
    })
  })

  it("emits the embedded identity when the repo has migrated — the breadcrumb's actual source", async () => {
    const identity: ProjectIdentity = {
      id: "abc123def456",
      name: "AI Gateway",
      slug: "ai-gateway",
    }
    await boot({
      projectId: null,
      slug: "ai-gateway",
      identity,
      platformBaseUrl: null,
    })
    const payload = await readBootstrapPayload()
    expect(payload.project).toEqual({
      projectId: null,
      slug: "ai-gateway",
      identity,
      platformBaseUrl: null,
    })
  })
})

/**
 * A symlinked checkout has two valid absolute roots for the same repo, and the
 * shell (which has no filesystem access) must be able to try both when mapping a
 * stylesheet's bundler source hint to a token file. So the realpath is computed
 * CLI-side and forwarded here — and only here, when it actually differs.
 */
describe("bootstrap script — repoRootReal", () => {
  it("emits the resolved root when it differs from repoRoot", async () => {
    await boot(undefined, { repoRootReal: "/Volumes/work/real-proto" })
    const payload = await readBootstrapPayload()
    expect(payload.repoRoot).toBe(repoDir)
    expect(payload.repoRootReal).toBe("/Volumes/work/real-proto")
  })

  it("omits the key entirely when the CLI had nothing extra to say", async () => {
    await boot()
    const payload = await readBootstrapPayload()
    expect(payload.repoRoot).toBe(repoDir)
    expect("repoRootReal" in payload).toBe(false)
  })
})
