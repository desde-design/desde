import { promises as fs } from "node:fs"
import { createServer, type Server } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AddressInfo } from "node:net"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { handleViewerProbe } from "../viewer-probe"

let probeServer: Server
let probePort = 0
let viewerServer: Server | null = null

/**
 * Bind an EPHEMERAL port and report it.
 *
 * These servers used fixed ports (4711/4712). Under the full suite that is a
 * race: another file — or a leftover socket in TIME_WAIT — can hold the port,
 * and the failure surfaces as an unrelated assertion in whichever test drew
 * the short straw. Measured at 2 failures in 3 full runs once this file grew
 * more cases. Port 0 lets the OS pick a free one.
 */
async function listen(s: Server): Promise<number> {
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r))
  return (s.address() as AddressInfo).port
}

beforeEach(async () => {
  probeServer = createServer((req, res) => void handleViewerProbe(req, res))
  probePort = await listen(probeServer)
})

afterEach(async () => {
  await new Promise<void>((r) => probeServer.close(() => r()))
  if (viewerServer) await new Promise<void>((r) => viewerServer!.close(() => r()))
  viewerServer = null
})

/** Stands in for a viewer's `GET /api/v1/projects`. */
async function fakeViewer(status: number, body: unknown): Promise<string> {
  viewerServer = createServer((_req, res) => {
    res.writeHead(status, { "Content-Type": "application/json" })
    res.end(JSON.stringify(body))
  })
  const port = await listen(viewerServer)
  return `http://127.0.0.1:${port}`
}

const VALID_TOKEN = `dsv_${"a".repeat(16)}_${"b".repeat(43)}`

function probe(body: unknown) {
  return fetch(`http://127.0.0.1:${probePort}/api/editor/viewer-auth/probe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe("viewer probe", () => {
  it("lists the projects the token can reach", async () => {
    const baseUrl = await fakeViewer(200, {
      projects: [{ id: "p1", slug: "alpha", name: "Alpha" }],
    })
    const res = await probe({ baseUrl, token: VALID_TOKEN })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.projects).toEqual([{ id: "p1", slug: "alpha", name: "Alpha" }])
  })

  /**
   * The viewer's project objects carry fields this page has no business
   * seeing (repo config today; a member email tomorrow). Reconstructing
   * field-by-field means a widened upstream shape cannot start flowing to
   * the browser on its own.
   */
  it("returns only id/slug/name, never the viewer's raw object", async () => {
    const baseUrl = await fakeViewer(200, {
      projects: [
        { id: "p1", slug: "a", name: "A", repoConfig: { installationId: 7 }, secretish: "nope" },
      ],
    })
    const json = await (await probe({ baseUrl, token: VALID_TOKEN })).json()
    expect(Object.keys(json.projects[0]).sort()).toEqual(["id", "name", "slug"])
  })

  it("drops malformed entries rather than passing them through", async () => {
    const baseUrl = await fakeViewer(200, { projects: [{ id: "p1" }, { id: "p2", slug: "b", name: "B" }] })
    const json = await (await probe({ baseUrl, token: VALID_TOKEN })).json()
    expect(json.projects).toEqual([{ id: "p2", slug: "b", name: "B" }])
  })

  /**
   * Each failure has a DIFFERENT fix — retype the URL, make a new token,
   * start the server. Collapsing them into one message is how a connect
   * flow becomes guesswork.
   */
  it("distinguishes a rejected token from an unreachable server", async () => {
    const baseUrl = await fakeViewer(401, { error: "Invalid credentials" })
    const rejected = await probe({ baseUrl, token: VALID_TOKEN })
    expect(rejected.status).toBe(401)
    expect((await rejected.json()).reason).toMatch(/revoked|different viewer/i)

    const unreachable = await probe({ baseUrl: "http://127.0.0.1:59999", token: VALID_TOKEN })
    expect(unreachable.status).toBe(502)
    expect((await unreachable.json()).reason).toMatch(/could not reach/i)
  })

  it("rejects a malformed token before contacting anything", async () => {
    // The URL is deliberately a port nothing listens on: the point is that the
    // malformed token is rejected BEFORE any network call, so if this ever
    // starts depending on something answering, the test has stopped testing
    // what it claims.
    const res = await probe({ baseUrl: "http://127.0.0.1:1", token: "nope" })
    expect(res.status).toBe(400)
    expect((await res.json()).reason).toMatch(/dsv_/)
  })

  it("rejects a URL with no scheme, and a non-http scheme", async () => {
    expect((await probe({ baseUrl: "viewer.example.com", token: VALID_TOKEN })).status).toBe(400)
    expect((await probe({ baseUrl: "file:///etc/passwd", token: VALID_TOKEN })).status).toBe(400)
  })

  it("says the server is not a viewer when it answers something unexpected", async () => {
    const baseUrl = await fakeViewer(500, { oops: true })
    const json = await (await probe({ baseUrl, token: VALID_TOKEN })).json()
    expect(json.reason).toMatch(/really a Desde viewer/i)
  })
})

/**
 * Write-scope validation at connect time.
 *
 * The viewer's token UI creates READ-ONLY tokens by default (write is an
 * unticked box). Before this check, pasting one succeeded here, the token was
 * stored, and then every comment write 403'd from `requireProjectWrite` — the
 * connect flow reporting success for a connection that could not do the one
 * thing it exists for. Public-link projects were no escape: the proxy always
 * attaches the bearer, so the anonymous-write path is gone too.
 *
 * Found by codex review 2026-08-09.
 */
describe("viewer probe — token scope", () => {
  /** A viewer that answers /api/v1/me and /api/v1/projects differently. */
  async function fakeViewerWithScopes(scopes: unknown): Promise<string> {
    viewerServer = createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" })
      if ((req.url ?? "").startsWith("/api/v1/me")) {
        res.end(JSON.stringify(scopes === undefined ? { user: {} } : { user: {}, scopes }))
        return
      }
      res.end(JSON.stringify({ projects: [{ id: "p1", slug: "s1", name: "P1" }] }))
    })
    const port = await listen(viewerServer)
    return `http://127.0.0.1:${port}`
  }

  it("refuses a read-only token, naming the fix", async () => {
    const baseUrl = await fakeViewerWithScopes(["read"])
    const res = await probe({ baseUrl, token: VALID_TOKEN })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { ok: boolean; reason: string }
    expect(body.ok).toBe(false)
    expect(body.reason).toMatch(/read-only/i)
    // The message must say what to DO, not just what is wrong.
    expect(body.reason).toMatch(/write/i)
  })

  it("accepts a read+write token", async () => {
    const baseUrl = await fakeViewerWithScopes(["read", "write"])
    const res = await probe({ baseUrl, token: VALID_TOKEN })
    expect(res.status).toBe(200)
  })

  it("accepts when the viewer does not report scopes at all", async () => {
    // An older viewer predating `/me` scopes. Refusing would make it
    // impossible to connect to at all — a worse failure than the 403 this
    // check pre-empts — so absence must mean "cannot tell", not "no".
    const baseUrl = await fakeViewerWithScopes(undefined)
    const res = await probe({ baseUrl, token: VALID_TOKEN })
    expect(res.status).toBe(200)
  })
})

/**
 * Matching the open checkout to a project on the viewer.
 *
 * The dialog used to pre-select `projects[0]` — whichever row the viewer
 * happened to return first, with nothing to do with the repo in front of you.
 * The viewer has been able to answer "which project is this repo" since the
 * auto-link work (`POST /api/v1/projects/resolve`); the connect flow simply
 * never asked. These cover the asking, and every way it declines to answer.
 */
describe("viewer probe: matching this checkout to a project", () => {
  let repoRoot = ""

  beforeEach(async () => {
    repoRoot = await fs.mkdtemp(join(tmpdir(), "desde-probe-"))
  })

  afterEach(async () => {
    await fs.rm(repoRoot, { recursive: true, force: true })
  })

  /** Commits an identity into the checkout, the way a linked repo carries one. */
  async function writeEmbeddedId(id: string): Promise<void> {
    await fs.mkdir(join(repoRoot, ".desde"), { recursive: true })
    await fs.writeFile(
      join(repoRoot, ".desde", "config.json"),
      // `name` is required by `parseProjectIdentity`; an identity without one
      // reads as no identity at all, which would make this fixture silently
      // test the nothing-to-match-on path instead.
      JSON.stringify({ version: 2, project: { id, name: "Local checkout", slug: "local-checkout" } }),
    )
  }

  /**
   * A viewer that answers `/projects/resolve` differently from the list.
   * The single-body fake above cannot express that, and the whole question
   * here is what happens when the two disagree.
   */
  async function fakeViewerWithResolve(
    projects: unknown[],
    resolution: unknown,
    resolveStatus = 200,
  ): Promise<string> {
    viewerServer = createServer((req, res) => {
      if ((req.url ?? "").includes("/projects/resolve")) {
        res.writeHead(resolveStatus, { "Content-Type": "application/json" })
        res.end(JSON.stringify(resolution))
        return
      }
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ projects }))
    })
    const port = await listen(viewerServer)
    return `http://127.0.0.1:${port}`
  }

  /** Drives the probe WITH repo context, which the route supplies in production. */
  function probeWithRepo(body: unknown) {
    return fetch(`http://127.0.0.1:${withRepoPort}/api/editor/viewer-auth/probe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  }

  let withRepoServer: Server
  let withRepoPort = 0

  beforeEach(async () => {
    withRepoServer = createServer((req, res) => void handleViewerProbe(req, res, repoRoot))
    withRepoPort = await listen(withRepoServer)
  })

  afterEach(async () => {
    await new Promise<void>((r) => withRepoServer.close(() => r()))
  })

  it("reports the project the viewer adopts for this checkout", async () => {
    await writeEmbeddedId("id-42")
    const baseUrl = await fakeViewerWithResolve(
      [
        { id: "p1", slug: "alpha", name: "Alpha" },
        { id: "p2", slug: "beta", name: "Beta" },
      ],
      { decision: "adopt", project: { id: "p2", slug: "beta", name: "Beta" } },
    )
    const json = await (await probeWithRepo({ baseUrl, token: VALID_TOKEN })).json()
    // Not `p1`, which is what the old first-row default would have chosen.
    expect(json.match).toEqual({ projectId: "p2", by: "identity" })
  })

  /**
   * `/projects/resolve` is deliberately public-read, so it answers for
   * projects this token cannot open. Pre-selecting one of those would leave
   * the dialog on a row whose Connect fails, chosen by us rather than by the
   * user — strictly worse than not matching at all.
   */
  it("ignores a match the token cannot actually see", async () => {
    await writeEmbeddedId("id-42")
    const baseUrl = await fakeViewerWithResolve(
      [{ id: "p1", slug: "alpha", name: "Alpha" }],
      { decision: "adopt", project: { id: "invisible", slug: "x", name: "X" } },
    )
    const json = await (await probeWithRepo({ baseUrl, token: VALID_TOKEN })).json()
    expect(json.match).toBeUndefined()
    expect(json.projects).toEqual([{ id: "p1", slug: "alpha", name: "Alpha" }])
  })

  it("reports no match when the viewer has never seen this repo", async () => {
    await writeEmbeddedId("id-42")
    const baseUrl = await fakeViewerWithResolve(
      [{ id: "p1", slug: "alpha", name: "Alpha" }],
      { decision: "mint", suggestedSlug: "alpha" },
    )
    const json = await (await probeWithRepo({ baseUrl, token: VALID_TOKEN })).json()
    expect(json.match).toBeUndefined()
  })

  it("reports no match on a conflict, which is not an answer about THIS repo", async () => {
    await writeEmbeddedId("id-42")
    const baseUrl = await fakeViewerWithResolve(
      [{ id: "p1", slug: "alpha", name: "Alpha" }],
      { decision: "conflict", reason: "claimed elsewhere" },
    )
    const json = await (await probeWithRepo({ baseUrl, token: VALID_TOKEN })).json()
    expect(json.match).toBeUndefined()
  })

  /**
   * Matching is an enhancement on top of a flow that has to keep working.
   * An older viewer with no resolve route, or one that errors, must leave the
   * user with the plain list rather than a failed connect.
   */
  it("still lists the projects when the resolve route errors", async () => {
    await writeEmbeddedId("id-42")
    const baseUrl = await fakeViewerWithResolve(
      [{ id: "p1", slug: "alpha", name: "Alpha" }],
      { error: "not found" },
      404,
    )
    const res = await probeWithRepo({ baseUrl, token: VALID_TOKEN })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.projects).toEqual([{ id: "p1", slug: "alpha", name: "Alpha" }])
    expect(json.match).toBeUndefined()
  })

  /**
   * A checkout with no committed identity and no git remote has nothing to
   * match on. The resolve route 400s on an empty request, so this must not
   * even ask.
   */
  it("does not ask when the checkout has nothing to match on", async () => {
    let resolveCalls = 0
    viewerServer = createServer((req, res) => {
      if ((req.url ?? "").includes("/projects/resolve")) resolveCalls += 1
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ projects: [{ id: "p1", slug: "alpha", name: "Alpha" }] }))
    })
    const port = await listen(viewerServer)
    const json = await (
      await probeWithRepo({ baseUrl: `http://127.0.0.1:${port}`, token: VALID_TOKEN })
    ).json()
    expect(resolveCalls).toBe(0)
    expect(json.match).toBeUndefined()
  })

  /** The no-repo-context caller keeps its old behavior, match field and all. */
  it("reports no match when the probe is called without a checkout", async () => {
    await writeEmbeddedId("id-42")
    const baseUrl = await fakeViewerWithResolve(
      [{ id: "p1", slug: "alpha", name: "Alpha" }],
      { decision: "adopt", project: { id: "p1", slug: "alpha", name: "Alpha" } },
    )
    // `probe` (not `probeWithRepo`) is the server built with no repoRoot.
    const json = await (await probe({ baseUrl, token: VALID_TOKEN })).json()
    expect(json.match).toBeUndefined()
  })
})
