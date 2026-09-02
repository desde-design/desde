/**
 * Unit tests for the per-project `/api/editor/read-roots*` routes.
 *
 * `handleReadRootsRoute` takes `(req, res, ctx, url)` directly, so — same
 * pattern as `design-systems-handler.test.ts` — we drive it with fake
 * `IncomingMessage`/`ServerResponse` objects instead of booting a real HTTP
 * server. Real temp dirs back the config file; the worktree root is git-init'd
 * because `loadReadRoots` (the reader behind both `handleList`'s no-holder
 * fallback and `reloadRegistry`) refuses a non-git worktree.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, mkdirSync, rmSync, readFileSync, realpathSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Readable } from "node:stream"
import { EventEmitter } from "node:events"
import type { IncomingMessage, ServerResponse } from "node:http"

import { handleReadRootsRoute, type ReadRootsHandlerContext, type ReadRootsHolder } from "../read-roots-handler.js"
import { appendReadRoot } from "../../../../src/editor/core/read-root-declarations.js"
import { loadReadRoots } from "../../../../src/editor/core/read-roots.js"
import type { FolderPickResult, PickFolder } from "../folder-picker.js"

let root: string
/** Scratch space for fixtures that must live OUTSIDE the worktree (e.g. a
 *  folder a "pick" stub returns) — separate from `root` so it isn't wiped
 *  by that dir's own cleanup mid-test. */
let scratch: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "read-roots-handler-"))
  // `loadReadRoots` refuses a worktree that is not itself a git repo — every
  // real caller boots from a git worktree, so the fixture must too.
  execFileSync("git", ["init", "-q"], { cwd: root })
  scratch = mkdtempSync(join(tmpdir(), "read-roots-handler-scratch-"))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(scratch, { recursive: true, force: true })
})

function mockReq(method: string, body?: unknown): IncomingMessage {
  const raw = body === undefined ? "" : JSON.stringify(body)
  const stream = Readable.from(raw ? [Buffer.from(raw)] : []) as unknown as IncomingMessage
  stream.method = method
  stream.headers = {}
  return stream
}

interface CapturedRes {
  res: ServerResponse
  status: () => number
  json: () => unknown
}

function mockRes(): CapturedRes {
  let statusCode = 200
  let body = ""
  const emitter = new EventEmitter()
  Object.defineProperty(emitter, "statusCode", {
    get: () => statusCode,
    set: (v: number) => {
      statusCode = v
    },
  })
  Object.assign(emitter, {
    setHeader: () => {},
    end: (chunk?: string) => {
      if (chunk) body = chunk
    },
  })
  const res = emitter as unknown as ServerResponse
  return {
    res,
    status: () => statusCode,
    json: () => (body ? JSON.parse(body) : undefined),
  }
}

function url(pathname: string): URL {
  return new URL(pathname, "http://127.0.0.1:4321")
}

function ctx(over: Partial<ReadRootsHandlerContext> = {}): ReadRootsHandlerContext {
  return {
    configRoot: root,
    ...over,
  }
}

function configPath(): string {
  return join(root, "desde.config.json")
}

describe("handleReadRootsRoute", () => {
  describe("GET /api/editor/read-roots", () => {
    it("lists roots including the implicit worktree, with isGit and path on each", async () => {
      // `loadReadRoots` resolves declared paths through `realpath` + `stat` —
      // a path that doesn't exist on disk is an environment problem and gets
      // silently skipped (see read-roots.ts's severity split), so this must
      // be a real directory, not a fictional path.
      const prodApp = join(scratch, "prod-app")
      mkdirSync(prodApp, { recursive: true })
      await appendReadRoot(root, { name: "prod-app", path: prodApp })

      const r = mockRes()
      await handleReadRootsRoute(mockReq("GET"), r.res, ctx(), url("/api/editor/read-roots"))
      expect(r.status()).toBe(200)
      const body = r.json() as {
        ok: boolean
        roots: Array<{ name: string; path: string; isWorktree: boolean; isGit: boolean }>
      }
      expect(body.ok).toBe(true)

      const worktree = body.roots.find((rt) => rt.name === "worktree")
      expect(worktree).toBeDefined()
      expect(worktree!.isWorktree).toBe(true)
      expect(worktree!.isGit).toBe(true)
      // realpath because `loadReadRoots` resolves symlinks (macOS temp dirs
      // are frequently one) — comparing the raw `root` string would be brittle.
      expect(worktree!.path).toBe(realpathSync(root))

      const declared = body.roots.find((rt) => rt.name === "prod-app")
      expect(declared).toBeDefined()
      expect(declared!.isWorktree).toBe(false)
      expect(declared!.path).toBe(realpathSync(prodApp))
      expect(declared!.isGit).toBe(false)
    })
  })

  it("adopts a recovered root into the live registry on list", async () => {
    // Boot-time state: the folder did not exist, so the holder omits it.
    const later = join(scratch, "comes-back")
    await appendReadRoot(root, { name: "comes-back", path: later })
    const holder = {
      current: { roots: [], resolve: () => undefined },
      warnings: [],
    } as unknown as Parameters<typeof handleReadRootsRoute>[2]["holder"]

    // The folder appears while the session is running.
    mkdirSync(later, { recursive: true })

    const r = mockRes()
    await handleReadRootsRoute(
      mockReq("GET"),
      r.res,
      ctx({ holder }),
      url("/api/editor/read-roots"),
    )
    expect(r.status()).toBe(200)

    // Listing it must also make it real for the agent, not just for the UI.
    expect(holder!.current.roots.map((rt) => rt.name)).toContain("comes-back")
  })

  describe("POST /api/editor/read-roots", () => {
    // A real directory, because the add route validates the filesystem before
    // writing: a path that does not resolve, is a file, or IS the project's own
    // folder is refused, since the loader treats those as fatal at next boot.
    it("adds a root, writes the config file, and returns the declaration", async () => {
      const prodApp = join(scratch, "prod-app")
      mkdirSync(prodApp, { recursive: true })

      const r = mockRes()
      await handleReadRootsRoute(
        mockReq("POST", { name: "prod-app", path: prodApp, description: "The prod app" }),
        r.res,
        ctx(),
        url("/api/editor/read-roots"),
      )
      expect(r.status()).toBe(200)
      const body = r.json() as { ok: boolean; declaration: { name: string; path: string } }
      expect(body.ok).toBe(true)
      expect(body.declaration).toEqual({
        name: "prod-app",
        path: prodApp,
        description: "The prod app",
      })

      const config = JSON.parse(readFileSync(configPath(), "utf8"))
      expect(config.readRoots["prod-app"]).toEqual({
        path: prodApp,
        description: "The prod app",
      })
    })

    it("refuses the project's own folder before writing anything", async () => {
      const r = mockRes()
      await handleReadRootsRoute(
        mockReq("POST", { name: "self", path: root }),
        r.res,
        ctx(),
        url("/api/editor/read-roots"),
      )
      expect(r.status()).toBe(400)
      const body = r.json() as { ok: boolean; reason: string }
      expect(body.ok).toBe(false)
      expect(body.reason).toMatch(/own folder/)
      // Nothing was written, so the next boot still works.
      expect(() => readFileSync(configPath(), "utf8")).toThrow()
    })

    it("refuses a path that does not resolve", async () => {
      const r = mockRes()
      await handleReadRootsRoute(
        mockReq("POST", { name: "ghost", path: join(scratch, "nope") }),
        r.res,
        ctx(),
        url("/api/editor/read-roots"),
      )
      expect(r.status()).toBe(400)
      expect((r.json() as { reason: string }).reason).toMatch(/Not found/)
    })

    it("returns 409 for a duplicate name", async () => {
      const prodApp = join(scratch, "prod-app")
      mkdirSync(prodApp, { recursive: true })
      const other = join(scratch, "prod-app-2")
      mkdirSync(other, { recursive: true })
      await appendReadRoot(root, { name: "prod-app", path: prodApp })

      const r = mockRes()
      await handleReadRootsRoute(
        mockReq("POST", { name: "prod-app", path: other }),
        r.res,
        ctx(),
        url("/api/editor/read-roots"),
      )
      expect(r.status()).toBe(409)
      const body = r.json() as { ok: boolean; reason: string }
      expect(body.ok).toBe(false)
      expect(body.reason).toMatch(/already exists/)
    })

    it("returns 400 for an invalid name (uppercase)", async () => {
      const r = mockRes()
      await handleReadRootsRoute(
        mockReq("POST", { name: "Prod-App", path: "/repos/prod-app" }),
        r.res,
        ctx(),
        url("/api/editor/read-roots"),
      )
      expect(r.status()).toBe(400)
      const body = r.json() as { ok: boolean; reason: string }
      expect(body.ok).toBe(false)
      expect(body.reason).toMatch(/invalid name/)
    })

    it("returns 400 for the reserved name \"worktree\"", async () => {
      const r = mockRes()
      await handleReadRootsRoute(
        mockReq("POST", { name: "worktree", path: "/repos/prod-app" }),
        r.res,
        ctx(),
        url("/api/editor/read-roots"),
      )
      expect(r.status()).toBe(400)
      const body = r.json() as { ok: boolean; reason: string }
      expect(body.ok).toBe(false)
      expect(body.reason).toMatch(/reserved/)
    })
  })

  describe("DELETE /api/editor/read-roots/<name>", () => {
    it("removes it and rewrites the file", async () => {
      await appendReadRoot(root, { name: "prod-app", path: "/repos/prod-app" })
      await appendReadRoot(root, { name: "docs-site", path: "/repos/docs-site" })

      const r = mockRes()
      await handleReadRootsRoute(
        mockReq("DELETE"),
        r.res,
        ctx(),
        url("/api/editor/read-roots/prod-app"),
      )
      expect(r.status()).toBe(200)
      expect(r.json()).toMatchObject({ ok: true, removed: "prod-app" })

      const config = JSON.parse(readFileSync(configPath(), "utf8"))
      expect(config.readRoots).toEqual({ "docs-site": { path: "/repos/docs-site" } })
    })

    it("returns 404 for an unknown name", async () => {
      const r = mockRes()
      await handleReadRootsRoute(
        mockReq("DELETE"),
        r.res,
        ctx(),
        url("/api/editor/read-roots/does-not-exist"),
      )
      expect(r.status()).toBe(404)
      const body = r.json() as { ok: boolean; reason: string }
      expect(body.ok).toBe(false)
    })

    it("decodes a percent-encoded name in the path", async () => {
      await appendReadRoot(root, { name: "prod-app", path: "/repos/prod-app" })

      const r = mockRes()
      // "-" percent-encoded as %2D — proves decodeURIComponent runs before
      // the name lookup, not just a literal string match.
      await handleReadRootsRoute(
        mockReq("DELETE"),
        r.res,
        ctx(),
        url("/api/editor/read-roots/prod%2Dapp"),
      )
      expect(r.status()).toBe(200)
      expect(r.json()).toMatchObject({ ok: true, removed: "prod-app" })

      const config = JSON.parse(readFileSync(configPath(), "utf8"))
      expect(config.readRoots).toBeUndefined()
    })
  })

  describe("POST /api/editor/read-roots/pick", () => {
    it("returns supported:false when no pickFolder is wired", async () => {
      const r = mockRes()
      await handleReadRootsRoute(
        mockReq("POST"),
        r.res,
        ctx(), // no pickFolder
        url("/api/editor/read-roots/pick"),
      )
      expect(r.status()).toBe(200)
      expect(r.json()).toEqual({ ok: true, supported: false })
    })

    it("with a stub that returns a path, returns suggestedName and isGit", async () => {
      const picked = join(scratch, "picked-ref-dir")
      mkdirSync(picked, { recursive: true })
      const pickFolder: PickFolder = async (): Promise<FolderPickResult> => ({
        supported: true,
        path: picked,
      })

      const r = mockRes()
      await handleReadRootsRoute(mockReq("POST"), r.res, ctx({ pickFolder }), url("/api/editor/read-roots/pick"))
      expect(r.status()).toBe(200)
      const body = r.json() as {
        ok: boolean
        supported: boolean
        path: string
        suggestedName: string
        isGit: boolean
      }
      expect(body.ok).toBe(true)
      expect(body.supported).toBe(true)
      expect(body.path).toBe(picked)
      expect(typeof body.suggestedName).toBe("string")
      expect(body.suggestedName.length).toBeGreaterThan(0)
      expect(body.isGit).toBe(false)
    })

    it("with a stub reporting canceled, passes that through", async () => {
      const pickFolder: PickFolder = async (): Promise<FolderPickResult> => ({
        supported: true,
        canceled: true,
      })

      const r = mockRes()
      await handleReadRootsRoute(mockReq("POST"), r.res, ctx({ pickFolder }), url("/api/editor/read-roots/pick"))
      expect(r.status()).toBe(200)
      expect(r.json()).toEqual({ ok: true, supported: true, canceled: true })
    })
  })

  it("returns 404 for an unknown sub-path", async () => {
    const r = mockRes()
    await handleReadRootsRoute(
      mockReq("GET"),
      r.res,
      ctx(),
      url("/api/editor/read-roots/nonexistent/thing"),
    )
    expect(r.status()).toBe(404)
    const body = r.json() as { ok: boolean; reason: string }
    expect(body.ok).toBe(false)
    expect(body.reason).toMatch(/Unknown read-roots endpoint/)
  })

  /**
   * The most important test in this file: `readRoots` is resolved once at
   * boot and handed to the chat handler's tools through a mutable holder box
   * (`ReadRootsHolder`). Without the reload, a user could add a reference
   * directory, see it listed, and the agent still couldn't read it until the
   * CLI restarted. See the "no restart needed" guarantee documented on
   * `ReadRootsHolder` in read-roots-handler.ts.
   */
  it("reloads the holder after a successful add — no restart needed", async () => {
    const initial = await loadReadRoots({ worktreeRoot: root })
    expect(initial.ok).toBe(true)
    if (!initial.ok) throw new Error("unreachable")
    const holder: ReadRootsHolder = { current: initial.registry, warnings: initial.warnings }
    expect(holder.current.roots.map((rt) => rt.name)).toEqual(["worktree"])

    // Real directory — see the note on the GET list test above for why a
    // fictional path would silently fail to resolve and never reach the
    // holder at all, which would make this test pass for the wrong reason.
    const prodApp = join(scratch, "prod-app")
    mkdirSync(prodApp, { recursive: true })

    const r = mockRes()
    await handleReadRootsRoute(
      mockReq("POST", { name: "prod-app", path: prodApp }),
      r.res,
      ctx({ holder }),
      url("/api/editor/read-roots"),
    )
    expect(r.status()).toBe(200)

    expect(holder.current.roots.map((rt) => rt.name).sort()).toEqual(["prod-app", "worktree"])
    expect(holder.current.resolve("prod-app")).toMatchObject({
      name: "prod-app",
      path: realpathSync(prodApp),
    })
  })
})
