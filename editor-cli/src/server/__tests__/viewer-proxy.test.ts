import { describe, expect, it } from "vitest"
import { handleViewerProxy, isAllowedProjectPath, proxyTargetPath } from "../viewer-proxy"

describe("proxyTargetPath", () => {
  it("extracts the API path from a proxied URL", () => {
    expect(proxyTargetPath("/api/editor/viewer/api/v1/projects/p1/comments")).toBe("/api/v1/projects/p1/comments")
  })

  it("ignores the query string when deciding, but leaves it to the caller", () => {
    expect(proxyTargetPath("/api/editor/viewer/api/v1/projects/p1/comments?after=3")).toBe(
      "/api/v1/projects/p1/comments",
    )
  })

  it("refuses anything that is not an /api/v1 path", () => {
    // A prototype asset, the shell, or an auth route has no business being
    // fetched with this token.
    expect(proxyTargetPath("/api/editor/viewer/p/slug/index.html")).toBeNull()
    expect(proxyTargetPath("/api/editor/viewer/api/v1")).toBeNull()
    expect(proxyTargetPath("/api/editor/viewer/")).toBeNull()
  })

  it("is not the proxy for unrelated editor routes", () => {
    expect(proxyTargetPath("/api/editor/edit")).toBeNull()
    expect(proxyTargetPath("/api/editor/viewerish/api/v1/x")).toBeNull()
  })

  it("refuses a traversal that would climb out of /api/v1", () => {
    expect(proxyTargetPath("/api/editor/viewer/api/v1/../../admin")).toBeNull()
    expect(proxyTargetPath("/api/editor/viewer/api/v1/projects/../../x")).toBeNull()
  })
})

describe("isAllowedProjectPath", () => {
  it("allows the configured project", () => {
    expect(isAllowedProjectPath("/api/v1/projects/p1/comments", "p1")).toBe(true)
    expect(isAllowedProjectPath("/api/v1/projects/p1/comments/c1/replies", "p1")).toBe(true)
  })

  /**
   * The token would have permission to read other projects. The proxy must
   * not — its authority has to be a strict SUBSET of the token's, so a bug
   * here cannot escalate beyond this repo's project.
   */
  it("refuses a different project on the same viewer", () => {
    expect(isAllowedProjectPath("/api/v1/projects/p2/comments", "p1")).toBe(false)
  })

  it("refuses paths that name no project", () => {
    // Permissive defaults are how a narrow credential path becomes a
    // general-purpose one.
    expect(isAllowedProjectPath("/api/v1/me", "p1")).toBe(false)
    expect(isAllowedProjectPath("/api/v1/tokens", "p1")).toBe(false)
    expect(isAllowedProjectPath("/api/v1/projects", "p1")).toBe(false)
  })

  it("does not allow a project id that merely starts with the configured one", () => {
    expect(isAllowedProjectPath("/api/v1/projects/p1-evil/comments", "p1")).toBe(false)
  })
})

/**
 * The contract between `handleViewerProxy` and its route.
 *
 * `proxyTargetPath` returning null is only half the refusal — the other half
 * is the route writing a response. On 2026-08-09 a live run of the seam found
 * that the route discarded the boolean, so a non-proxyable path under the
 * proxy prefix produced NO response at all and the request hung until the
 * client timed out. Every existing test in this file exercises the pure
 * helpers; none touched the handler, which is exactly where the gap was.
 */
describe("handleViewerProxy refusal contract", () => {
  function fakeRes() {
    const state = { head: null as number | null, body: "", ended: false }
    return {
      state,
      res: {
        writeHead(code: number) {
          state.head = code
          return this
        },
        end(chunk?: string) {
          state.body = chunk ?? ""
          state.ended = true
        },
      } as unknown as import("node:http").ServerResponse,
    }
  }

  const cfg = { baseUrl: "http://localhost:3100", projectId: "proj-1" }

  it("returns false AND writes nothing for a path it does not own", async () => {
    // The route relies on both halves: `false` tells it to answer, and the
    // untouched response is what makes answering safe (no double-write).
    for (const url of [
      "/api/editor/viewer/p/some-slug/",
      "/api/editor/viewer/api/v1/../../etc/passwd",
      "/api/editor/viewer/not-an-api-path",
    ]) {
      const { res, state } = fakeRes()
      const handled = await handleViewerProxy(
        { url, method: "GET", headers: {} } as unknown as import("node:http").IncomingMessage,
        res,
        cfg,
      )
      expect(handled, url).toBe(false)
      expect(state.ended, `${url} must not write a response`).toBe(false)
    }
  })

  it("returns true and answers 403 for a proxyable path addressing another project", async () => {
    // Contrast case: here the proxy DOES own the path, so it must answer
    // itself and the route must not add a second response.
    const { res, state } = fakeRes()
    const handled = await handleViewerProxy(
      {
        url: "/api/editor/viewer/api/v1/projects/other-project/comments",
        method: "GET",
        headers: {},
      } as unknown as import("node:http").IncomingMessage,
      res,
      cfg,
    )
    expect(handled).toBe(true)
    expect(state.head).toBe(403)
  })
})

/**
 * Percent-encoded dot segments.
 *
 * Found by codex review on 2026-08-09 and reproduced before fixing. The
 * original guard tested `rest.split("/").includes("..")` — literal only. But
 * `new URL` DECODES `%2e%2e` and then normalizes it, so
 *
 *   /api/v1/projects/<configured>/%2e%2e/<other>/comments
 *
 * carried no literal `..`, passed `isAllowedProjectPath` as the configured
 * project, and was then rewritten to `/api/v1/projects/<other>/comments`
 * before the fetch — spending the stored viewer PAT on a project this proxy
 * has no authority over. That is the exact boundary the proxy exists to hold.
 */
describe("proxyTargetPath rejects encoded dot segments", () => {
  const CONFIGURED = "proj-configured"

  it("refuses every spelling of a dot segment", () => {
    for (const encoded of ["%2e%2e", "%2E%2E", "..", "%2e", "."]) {
      const url = `/api/editor/viewer/api/v1/projects/${CONFIGURED}/${encoded}/other/comments`
      expect(proxyTargetPath(url), `must refuse ${encoded}`).toBeNull()
    }
  })

  it("refuses malformed percent-encoding rather than guessing", () => {
    // `new URL` tolerates a stray `%`; an input we cannot decode is one we
    // cannot claim to have validated.
    expect(proxyTargetPath(`/api/editor/viewer/api/v1/projects/${CONFIGURED}/%zz/comments`)).toBeNull()
  })

  it("still allows ordinary paths, including legitimate percent-encoding", () => {
    expect(proxyTargetPath(`/api/editor/viewer/api/v1/projects/${CONFIGURED}/comments`)).toBe(
      `/api/v1/projects/${CONFIGURED}/comments`,
    )
    // %20 decodes to a space, not a dot segment — must survive.
    expect(proxyTargetPath(`/api/editor/viewer/api/v1/projects/${CONFIGURED}/a%20b`)).toBe(
      `/api/v1/projects/${CONFIGURED}/a%20b`,
    )
  })

  it("the escape, end to end: the normalized target must not leave the project", () => {
    // Guards the property rather than the implementation — if a future change
    // reintroduces a decode/normalize gap, this fails even if the unit checks
    // above are refactored away.
    const url = `/api/editor/viewer/api/v1/projects/${CONFIGURED}/%2e%2e/proj-other/comments`
    const apiPath = proxyTargetPath(url)
    expect(apiPath).toBeNull()
    // And had it not been refused, this is what would have been requested:
    const wouldHaveBeen = new URL(`http://viewer.example${`/api/v1/projects/${CONFIGURED}/%2e%2e/proj-other/comments`}`)
    expect(wouldHaveBeen.pathname).toBe("/api/v1/projects/proj-other/comments")
    expect(isAllowedProjectPath(wouldHaveBeen.pathname, CONFIGURED)).toBe(false)
  })
})
