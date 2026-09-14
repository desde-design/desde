import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startHttpServer, type HttpServerHandle, type HttpServerOptions } from "../http-server.js"
import { newSecurityContext } from "../auth.js"
import { invalidateViewerLink } from "../viewer-link-state.js"
import { isViewerMatchDismissed } from "../viewer-match-dismissal.js"
import { writeDefaultViewerOrigin, writeViewerToken } from "../viewer-token-store.js"

/**
 * `POST /api/editor/viewer-auth/dismiss-match`, asserted through the REAL
 * HTTP route — sibling in spirit to `http-server-dormant-lanes.integration.test.ts`:
 * `viewer-link-state.test.ts` already proves `effectiveViewerConfig` as a
 * pure function, but a pure-function assertion passes identically whether or
 * not the route actually calls it. This proves the route is wired to it.
 *
 * The guard under test (`http-server.ts`, the `dismiss-match` handler)
 * refuses (409) unless BOTH hold:
 *   - the resolved link status is `"ambiguous"`, AND
 *   - `effectiveViewerConfig(...)` reports `source === null` (no committed
 *     link in `.desde/config.json` has already answered the question).
 *
 * The second condition is the one this suite exists to pin down: it was
 * added after a live run found the route answering 200 for a repo whose
 * link was already committed, recording a dismissal that would have
 * suppressed the chooser later if that committed link were ever removed.
 *
 * `getViewerLink` caches per process (`viewer-link-state.ts`), so every test
 * calls `invalidateViewerLink()` after arranging its own HOME/fetch state and
 * before issuing the request — otherwise it would see whatever the previous
 * test resolved.
 */

let handle: HttpServerHandle
let bundleDir: string
let repoDir: string
let homeDir: string
let shellOrigin: string
let token: string

const VIEWER_ORIGIN = "https://viewer.test"

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

/** Starts the real HTTP server, optionally with a committed viewer link. */
async function boot(project?: HttpServerOptions["project"]): Promise<void> {
  bundleDir = await mkdtemp(join(tmpdir(), "editor-cli-bundle-"))
  await writeFile(join(bundleDir, "index.html"), "<!doctype html><title>t</title>")
  repoDir = await mkdtemp(join(tmpdir(), "editor-cli-dismiss-repo-"))

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
    ...(project ? { project } : {}),
  })
}

/**
 * Gives the repo an embedded identity, so `resolveViewerLink` has something
 * to send `/projects/resolve` instead of short-circuiting to `unlinked`
 * before any network call (see `viewer-resolve.ts`: no embedded id and no
 * git remote means unlinked, immediately).
 */
async function writeEmbeddedIdentity(root: string, id: string): Promise<void> {
  await mkdir(join(root, ".desde"), { recursive: true })
  await writeFile(
    join(root, ".desde", "config.json"),
    JSON.stringify({ version: 2, project: { id, name: "Checkout" } }),
    "utf8",
  )
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function urlOf(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url
}

/**
 * A fake viewer that accepts the stored token and reports the repo as
 * `ambiguous` with `candidateCount` matching prototypes — the shape
 * `resolveViewerLink` turns into `{ status: "ambiguous", ... }`. Two or more
 * candidates, because a single one collapses to `linked` and zero collapses
 * to `unlinked` (see `resolveViewerLink`).
 */
function ambiguousViewerFetch(candidateCount: number): typeof fetch {
  return (async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = urlOf(input)
    if (url.endsWith("/api/v1/me")) {
      return jsonResponse(200, { id: "u1" })
    }
    if (url.includes("/api/v1/projects/resolve")) {
      return jsonResponse(200, { decision: "ambiguous", count: candidateCount })
    }
    if (url.includes("/api/v1/projects?")) {
      return jsonResponse(200, {
        projects: Array.from({ length: candidateCount }, (_, i) => ({
          id: `proto-${i}`,
          slug: `proto-${i}`,
          name: `Prototype ${i}`,
          repoMatch: { branch: "main" },
        })),
      })
    }
    throw new Error(`unexpected fetch in test: ${url}`)
  }) as unknown as typeof fetch
}

/** A fetch stub that fails the test if the route reaches the network at all. */
function noNetworkFetch(): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    throw new Error(`expected no network call, got: ${urlOf(input)}`)
  }) as unknown as typeof fetch
}

let realFetch: typeof fetch

// Uses `realFetch`, not the (possibly stubbed) global one: the stubs below
// fake the OUTBOUND call `resolveViewerLink` makes to the viewer, and must
// not also swallow this test's own inbound call to the local server under
// test.
async function postDismiss(): Promise<{ status: number; json: { ok?: boolean; reason?: string } }> {
  const res = await realFetch(`${shellOrigin}/api/editor/viewer-auth/dismiss-match`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: shellOrigin,
      Authorization: `Bearer ${token}`,
    },
    body: "{}",
  })
  return { status: res.status, json: (await res.json()) as { ok?: boolean; reason?: string } }
}

beforeEach(() => {
  realFetch = globalThis.fetch
})

afterEach(async () => {
  globalThis.fetch = realFetch
  await handle?.close()
  await rm(bundleDir, { recursive: true, force: true })
  await rm(repoDir, { recursive: true, force: true })
  if (homeDir) await rm(homeDir, { recursive: true, force: true })
  vi.unstubAllEnvs()
  invalidateViewerLink()
})

describe("POST /api/editor/viewer-auth/dismiss-match", () => {
  it("ambiguous, no committed link -> 200, and records the dismissal", async () => {
    await boot()
    homeDir = await mkdtemp(join(tmpdir(), "editor-cli-dismiss-home-"))
    vi.stubEnv("HOME", homeDir)
    await writeEmbeddedIdentity(repoDir, "emb-1")
    await writeDefaultViewerOrigin(VIEWER_ORIGIN, homeDir)
    await writeViewerToken(VIEWER_ORIGIN, "dsv_test", homeDir)
    globalThis.fetch = ambiguousViewerFetch(2)
    invalidateViewerLink()

    const { status, json } = await postDismiss()

    expect(status).toBe(200)
    expect(json).toEqual({ ok: true })
    expect(await isViewerMatchDismissed(repoDir, VIEWER_ORIGIN)).toBe(true)
  })

  it("ambiguous, WITH a committed link -> 409, and records nothing", async () => {
    // The committed link is what the connect dialog writes into
    // `.desde/config.json`: `platformBaseUrl` + `projectId`. In this harness
    // it is threaded straight through `startHttpServer`'s `project` option,
    // which is what `ctx.project` resolves to (see `http-server.ts`'s
    // `routeRequest`, which spreads `opts` into the per-request context).
    await boot({
      projectId: "proj-committed",
      slug: "committed-slug",
      identity: null,
      platformBaseUrl: VIEWER_ORIGIN,
    })
    homeDir = await mkdtemp(join(tmpdir(), "editor-cli-dismiss-home-"))
    vi.stubEnv("HOME", homeDir)
    await writeEmbeddedIdentity(repoDir, "emb-1")
    await writeDefaultViewerOrigin(VIEWER_ORIGIN, homeDir)
    await writeViewerToken(VIEWER_ORIGIN, "dsv_test", homeDir)
    globalThis.fetch = ambiguousViewerFetch(2)
    invalidateViewerLink()

    const { status, json } = await postDismiss()

    expect(status).toBe(409)
    expect(json).toEqual({ ok: false, reason: "There is nothing to dismiss." })
    expect(await isViewerMatchDismissed(repoDir, VIEWER_ORIGIN)).toBe(false)
  })

  it("unlinked (no embedded id, no git remote) -> 409, records nothing", async () => {
    await boot()
    homeDir = await mkdtemp(join(tmpdir(), "editor-cli-dismiss-home-"))
    vi.stubEnv("HOME", homeDir)
    // A viewer IS configured, but the repo carries neither an embedded id
    // nor a git remote, so `resolveViewerLink` returns `unlinked` before any
    // network call (see `viewer-resolve.ts`).
    await writeDefaultViewerOrigin(VIEWER_ORIGIN, homeDir)
    await writeViewerToken(VIEWER_ORIGIN, "dsv_test", homeDir)
    globalThis.fetch = noNetworkFetch()
    invalidateViewerLink()

    const { status, json } = await postDismiss()

    expect(status).toBe(409)
    expect(json).toEqual({ ok: false, reason: "There is nothing to dismiss." })
    expect(await isViewerMatchDismissed(repoDir, VIEWER_ORIGIN)).toBe(false)
  })

  it("no-viewer (nothing configured on this machine) -> 409, records nothing", async () => {
    await boot()
    homeDir = await mkdtemp(join(tmpdir(), "editor-cli-dismiss-home-"))
    vi.stubEnv("HOME", homeDir)
    await writeEmbeddedIdentity(repoDir, "emb-1")
    // No default viewer origin written at all.
    globalThis.fetch = noNetworkFetch()
    invalidateViewerLink()

    const { status, json } = await postDismiss()

    expect(status).toBe(409)
    expect(json).toEqual({ ok: false, reason: "There is nothing to dismiss." })
    expect(await isViewerMatchDismissed(repoDir, VIEWER_ORIGIN)).toBe(false)
  })
})
