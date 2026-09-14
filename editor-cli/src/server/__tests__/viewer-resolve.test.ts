import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { writeFile, mkdir } from "node:fs/promises"
import { afterEach, describe, expect, it, vi } from "vitest"
import { resolveViewerLink } from "../viewer-resolve"
import { writeDefaultViewerOrigin, writeViewerToken } from "../viewer-token-store"

const dirs: string[] = []
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))

async function repoWithIdentity(id: string): Promise<string> {
  const root = tmp("vr-repo-")
  await mkdir(join(root, ".desde"), { recursive: true })
  await writeFile(
    join(root, ".desde", "config.json"),
    JSON.stringify({ version: 2, project: { id, name: "Checkout" } }),
    "utf8",
  )
  return root
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

/**
 * A viewer that accepts the token and answers `/projects/resolve` with
 * `decision`.
 *
 * Two endpoints, because `resolveViewerLink` checks the credential against
 * `/api/v1/me` before trusting a resolution: `/projects/resolve` is
 * public-read on a real viewer, so it answers a revoked token perfectly and
 * "linked" would otherwise mean "linked, and every comment fetch 401s".
 */
function viewerServing(
  decision: unknown,
  opts: { meStatus?: number; onResolveBody?: (body: Record<string, unknown>) => void } = {},
): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url)
    if (href.endsWith("/api/v1/me")) {
      return jsonResponse(opts.meStatus ?? 200, { id: "u1" })
    }
    opts.onResolveBody?.(JSON.parse(String(init?.body)) as Record<string, unknown>)
    return jsonResponse(200, decision)
  }) as unknown as typeof fetch
}

describe("resolveViewerLink", () => {
  it("reports no-viewer before anything is configured", async () => {
    const home = tmp("vr-home-")
    const root = await repoWithIdentity("emb-1")
    expect(await resolveViewerLink(root, { home })).toEqual({ status: "no-viewer" })
  })

  it("reports no-token when a viewer is set but its credential is missing", async () => {
    const home = tmp("vr-home-")
    await writeDefaultViewerOrigin("https://v.example.com", home)
    const root = await repoWithIdentity("emb-1")
    expect(await resolveViewerLink(root, { home })).toEqual({
      status: "no-token",
      origin: "https://v.example.com",
    })
  })

  it("links on `adopt`, sending the repo's embedded id", async () => {
    const home = tmp("vr-home-")
    await writeDefaultViewerOrigin("https://v.example.com", home)
    await writeViewerToken("https://v.example.com", "dsv_x", home)
    const root = await repoWithIdentity("emb-1")

    let sentEmbeddedId: unknown
    const fetchImpl = viewerServing(
      { decision: "adopt", project: { id: "proj-9", slug: "checkout", name: "Checkout" } },
      { onResolveBody: (body) => (sentEmbeddedId = body.embeddedId) },
    )

    expect(await resolveViewerLink(root, { home, fetchImpl })).toEqual({
      status: "linked",
      origin: "https://v.example.com",
      projectId: "proj-9",
      slug: "checkout",
      name: "Checkout",
    })
    expect(sentEmbeddedId).toBe("emb-1")
  })

  it("refuses to report `linked` when the viewer rejects the token", async () => {
    // `/projects/resolve` is public-read, so it answers a dead token happily.
    // Trusting that would produce a link whose every comment fetch 401s.
    // MEASURED against a live viewer 2026-08-26.
    const home = tmp("vr-home-")
    await writeDefaultViewerOrigin("https://v.example.com", home)
    await writeViewerToken("https://v.example.com", "dsv_revoked", home)
    const root = await repoWithIdentity("emb-1")

    const fetchImpl = viewerServing(
      { decision: "adopt", project: { id: "proj-9", slug: "checkout", name: "Checkout" } },
      { meStatus: 401 },
    )

    expect(await resolveViewerLink(root, { home, fetchImpl })).toEqual({
      status: "no-token",
      origin: "https://v.example.com",
    })
  })

  it("treats `mint` as simply not linked — it never creates anything", async () => {
    const home = tmp("vr-home-")
    await writeDefaultViewerOrigin("https://v.example.com", home)
    await writeViewerToken("https://v.example.com", "dsv_x", home)
    const root = await repoWithIdentity("emb-1")

    const fetchImpl = viewerServing({ decision: "mint", suggestedSlug: "checkout" })

    expect(await resolveViewerLink(root, { home, fetchImpl })).toEqual({
      status: "unlinked",
      origin: "https://v.example.com",
    })
  })

  it("passes a conflict through verbatim", async () => {
    const home = tmp("vr-home-")
    await writeDefaultViewerOrigin("https://v.example.com", home)
    await writeViewerToken("https://v.example.com", "dsv_x", home)
    const root = await repoWithIdentity("emb-1")

    const fetchImpl = viewerServing({
      decision: "conflict",
      reason: "That id belongs to another prototype.",
    })

    expect(await resolveViewerLink(root, { home, fetchImpl })).toEqual({
      status: "conflict",
      origin: "https://v.example.com",
      reason: "That id belongs to another prototype.",
    })
  })

  it("maps a rejected token to no-token, not to an error", async () => {
    // The remedy differs: "your token was revoked" is a credential problem the
    // user can fix, where "the viewer is down" is one they can only wait out.
    const home = tmp("vr-home-")
    await writeDefaultViewerOrigin("https://v.example.com", home)
    await writeViewerToken("https://v.example.com", "dsv_x", home)
    const root = await repoWithIdentity("emb-1")

    const fetchImpl = viewerServing({ decision: "mint", suggestedSlug: "x" }, { meStatus: 401 })

    expect(await resolveViewerLink(root, { home, fetchImpl })).toEqual({
      status: "no-token",
      origin: "https://v.example.com",
    })
  })

  it("never throws when the viewer is unreachable", async () => {
    // Booting the Editor must not depend on a viewer being up.
    const home = tmp("vr-home-")
    await writeDefaultViewerOrigin("https://v.example.com", home)
    await writeViewerToken("https://v.example.com", "dsv_x", home)
    const root = await repoWithIdentity("emb-1")

    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED")
    }) as unknown as typeof fetch

    const result = await resolveViewerLink(root, { home, fetchImpl })
    expect(result.status).toBe("error")
  })

  it("writes nothing to the repo, whatever the answer", async () => {
    const home = tmp("vr-home-")
    await writeDefaultViewerOrigin("https://v.example.com", home)
    await writeViewerToken("https://v.example.com", "dsv_x", home)
    const root = await repoWithIdentity("emb-1")
    const configPath = join(root, ".desde", "config.json")
    const before = await import("node:fs/promises").then((fs) => fs.readFile(configPath, "utf8"))

    const fetchImpl = viewerServing({
      decision: "adopt",
      project: { id: "proj-9", slug: "checkout", name: "Checkout" },
    })
    await resolveViewerLink(root, { home, fetchImpl })

    const after = await import("node:fs/promises").then((fs) => fs.readFile(configPath, "utf8"))
    // The link is runtime state. Persisting it would put a second copy in a
    // COMMITTED file, which is how everyone's comments get re-pointed.
    expect(after).toBe(before)
  })
})

/**
 * A viewer that answers `ambiguous` and serves `candidates` from the
 * authenticated list route.
 */
function viewerServingAmbiguous(count: number, candidates: unknown[]): typeof fetch {
  return (async (url: string | URL | Request) => {
    const href = String(url)
    if (href.endsWith("/api/v1/me")) return jsonResponse(200, { scopes: ["read", "write"] })
    if (href.includes("/api/v1/projects/resolve")) {
      return jsonResponse(200, { decision: "ambiguous", count })
    }
    if (href.includes("/api/v1/projects?")) {
      return jsonResponse(200, { projects: candidates })
    }
    return jsonResponse(404, {})
  }) as unknown as typeof fetch
}

/**
 * A viewer that answers `ambiguous`, but whose authenticated candidate list
 * route (`/api/v1/projects?remoteUrl=`) fails instead of answering — either
 * with an HTTP error status, or with a 200 whose body is not valid JSON.
 *
 * Sibling to `viewerServingAmbiguous` above: that one always answers the list
 * route successfully, so it cannot exercise "could not ask" at all.
 */
function viewerServingCandidatesFailure(opts: {
  status?: number
  malformedBody?: boolean
}): typeof fetch {
  return (async (url: string | URL | Request) => {
    const href = String(url)
    if (href.endsWith("/api/v1/me")) return jsonResponse(200, { scopes: ["read", "write"] })
    if (href.includes("/api/v1/projects/resolve")) {
      return jsonResponse(200, { decision: "ambiguous", count: 2 })
    }
    if (href.includes("/api/v1/projects?")) {
      if (opts.malformedBody) {
        return new Response("not json", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }
      return jsonResponse(opts.status ?? 500, { error: "boom" })
    }
    return jsonResponse(404, {})
  }) as unknown as typeof fetch
}

function candidate(id: string, branch: string) {
  return {
    id,
    slug: id,
    name: `Prototype ${id}`,
    repoMatch: { branch },
    activeDeployment: { status: "deployed", createdAt: "2026-09-13T09:00:00.000Z" },
  }
}

describe("resolveViewerLink — several prototypes on one repo", () => {
  it("reports ambiguous with the readable candidates", async () => {
    const home = tmp("vr-home-")
    const root = await repoWithIdentity("emb-1")
    await writeDefaultViewerOrigin("https://viewer.test", home)
    await writeViewerToken("https://viewer.test", `dsv_${"0".repeat(16)}_${"a".repeat(43)}`, home)

    const link = await resolveViewerLink(root, {
      home,
      fetchImpl: viewerServingAmbiguous(2, [candidate("a", "main"), candidate("b", "design-review")]),
    })

    expect(link).toEqual({
      status: "ambiguous",
      origin: "https://viewer.test",
      candidates: [
        {
          projectId: "a",
          slug: "a",
          name: "Prototype a",
          branch: "main",
          lastBuiltAt: "2026-09-13T09:00:00.000Z",
        },
        {
          projectId: "b",
          slug: "b",
          name: "Prototype b",
          branch: "design-review",
          lastBuiltAt: "2026-09-13T09:00:00.000Z",
        },
      ],
    })
  })

  it("links silently when the caller can only read one of them", async () => {
    // The resolve route is public-read, so it counts projects this token may
    // not be able to open. One readable candidate is not an ambiguous
    // question for this user, so it follows the one-match rule.
    const home = tmp("vr-home-")
    const root = await repoWithIdentity("emb-1")
    await writeDefaultViewerOrigin("https://viewer.test", home)
    await writeViewerToken("https://viewer.test", `dsv_${"0".repeat(16)}_${"a".repeat(43)}`, home)

    const link = await resolveViewerLink(root, {
      home,
      fetchImpl: viewerServingAmbiguous(2, [candidate("a", "main")]),
    })

    expect(link).toMatchObject({ status: "linked", projectId: "a", slug: "a" })
  })

  it("reports unlinked when none of them are readable", async () => {
    const home = tmp("vr-home-")
    const root = await repoWithIdentity("emb-1")
    await writeDefaultViewerOrigin("https://viewer.test", home)
    await writeViewerToken("https://viewer.test", `dsv_${"0".repeat(16)}_${"a".repeat(43)}`, home)

    const link = await resolveViewerLink(root, {
      home,
      fetchImpl: viewerServingAmbiguous(2, []),
    })

    expect(link).toEqual({ status: "unlinked", origin: "https://viewer.test" })
  })

  /**
   * The 0-candidate case above is a SUCCESSFUL empty list: the viewer was
   * asked and it honestly has no readable prototype for this repo, so
   * `unlinked` is correct and must stay cached-safe.
   *
   * This is different: the viewer could not be asked at all. Before the fix,
   * `fetchRepoCandidates` collapsed a failed fetch to `[]`, which read
   * exactly like the successful-empty-list case above and reported
   * `unlinked` — a verdict the caller then caches for the life of the
   * process. A transient 500 would have looked identical to "this repo has
   * no prototypes" until the Editor restarted.
   */
  it("reports an error, not unlinked, when the candidate list fetch 500s", async () => {
    const home = tmp("vr-home-")
    const root = await repoWithIdentity("emb-1")
    await writeDefaultViewerOrigin("https://viewer.test", home)
    await writeViewerToken("https://viewer.test", `dsv_${"0".repeat(16)}_${"a".repeat(43)}`, home)

    const link = await resolveViewerLink(root, {
      home,
      fetchImpl: viewerServingCandidatesFailure({ status: 500 }),
    })

    expect(link).toEqual({
      status: "error",
      origin: "https://viewer.test",
      reason: "Could not reach the viewer.",
    })
  })

  it("reports an error, not unlinked, when the candidate list body is not valid JSON", async () => {
    const home = tmp("vr-home-")
    const root = await repoWithIdentity("emb-1")
    await writeDefaultViewerOrigin("https://viewer.test", home)
    await writeViewerToken("https://viewer.test", `dsv_${"0".repeat(16)}_${"a".repeat(43)}`, home)

    const link = await resolveViewerLink(root, {
      home,
      fetchImpl: viewerServingCandidatesFailure({ malformedBody: true }),
    })

    expect(link).toEqual({
      status: "error",
      origin: "https://viewer.test",
      reason: "Could not reach the viewer.",
    })
  })
})
