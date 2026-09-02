import {
  ME_SIGNED_IN,
  SAMPLE_MEMBERS,
  SAMPLE_PARTICIPANTS,
  SAMPLE_PROJECTS,
  SAMPLE_PROJECT,
  SAMPLE_REPO_CONFIG,
  SAMPLE_TOKENS,
  sampleDeployment,
} from "./fixture-data"

/**
 * The gallery's baseline backend.
 *
 * Every viewer panel loads itself from `/api/v1/*` on mount, so with nothing
 * installed the whole catalog would render its error state and nothing else.
 * This answers each endpoint with a plausible, populated default, which is the
 * backdrop a fixture starts from.
 *
 * Fixtures do NOT edit this table. They layer a `routeTable` over it through
 * `useFetchOverride` (`@/components/gallery/fetch-override`), which chains onto
 * whatever `window.fetch` already is — so a state that wants an empty list, a
 * 500, or a request that never settles overrides only the routes it cares
 * about and inherits the rest.
 *
 * Mirrors `editor-cli/self-host/src/mock-backend.ts` in shape: one `route`
 * matcher, one idempotent `window.fetch` patch, non-`/api` requests untouched.
 */

const DEFAULT_DEPLOYMENT = sampleDeployment()

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

/**
 * Answer one request, or return null to let it through to the network.
 *
 * Matching is on the path with the query string removed, longest-specific
 * first — `/projects/:id/members` is tested before `/projects/:id`, because
 * the latter is a prefix of the former and would otherwise swallow it.
 */
function route(path: string, method: string): Response | null {
  if (!path.startsWith("/api/")) return null

  // ---- identity -----------------------------------------------------------
  if (path === "/api/v1/me") return json(ME_SIGNED_IN)
  if (path === "/api/v1/auth/logout") return new Response(null, { status: 204 })

  // ---- projects -----------------------------------------------------------
  // `publicLinksEnabled: true` — the instance-wide default, and the value
  // every fixture that doesn't explicitly override this route should see.
  if (path === "/api/v1/projects") return json({ projects: SAMPLE_PROJECTS, publicLinksEnabled: true })

  const project = /^\/api\/v1\/projects\/([^/]+)(\/.*)?$/.exec(path)
  if (project) {
    const rest = project[2] ?? ""

    if (rest === "/members") {
      if (method === "POST") {
        return json(
          {
            userId: "user-new",
            createdAt: "2026-08-19T12:00:00.000Z",
            email: "new@example.com",
            displayName: "New Member",
            avatarUrl: "",
          },
          201,
        )
      }
      return json({ members: SAMPLE_MEMBERS })
    }
    if (rest.startsWith("/members/")) return new Response(null, { status: 204 })

    if (rest === "/participants") {
      if (method === "POST") {
        return json(
          { id: "user-new", email: "new@example.com", displayName: "new@example.com", status: "pending" },
          201,
        )
      }
      return json({ participants: SAMPLE_PARTICIPANTS })
    }

    // `{ comments: [...] }`, NOT a bare array. The store throws
    // "response missing 'comments' array" on anything else, and the rail then
    // renders its load-error state — which looks enough like a real state that
    // a fixture can be wrong here and still appear to work. See
    // `src/services/artifact-stores/viewer-http-comment-store.ts`.
    if (rest === "/comments") return json({ comments: [] })
    if (rest.startsWith("/comments/")) return json({})

    if (rest === "/deployments") return json({ deployments: [DEFAULT_DEPLOYMENT] })
    if (rest === "/deployments/build") return json({ deploymentId: "dep-500", status: "building" }, 202)

    if (rest === "/repo") {
      if (method === "DELETE") return new Response(null, { status: 204 })
      return json({ id: SAMPLE_PROJECT.id, repoConfig: SAMPLE_REPO_CONFIG })
    }

    if (rest === "") return json({ ...SAMPLE_PROJECT, repoConfig: SAMPLE_REPO_CONFIG })
  }

  // ---- tokens -------------------------------------------------------------
  if (path === "/api/v1/tokens") {
    if (method === "POST") return json({ ...SAMPLE_TOKENS[0], token: "dsv_new" }, 201)
    return json({ tokens: SAMPLE_TOKENS })
  }
  if (path.startsWith("/api/v1/tokens/")) return new Response(null, { status: 204 })

  // ---- github -------------------------------------------------------------
  if (path === "/api/v1/github/installations") {
    return json({
      configured: true,
      appSlug: "desde-viewer",
      installations: [],
      installationsSyncedAt: null,
      installationsStale: false,
    })
  }
  if (/^\/api\/v1\/github\/installations\/[^/]+\/repos$/.test(path)) {
    return json({ configured: true, repos: [] })
  }

  // Anything under /api that no fixture claimed. `{}` rather than a 404, so a
  // component reading `body.field` off it sees `undefined` (its own
  // not-configured branch) instead of a parse failure it has no branch for.
  return json({})
}

declare global {
  interface Window {
    __VIEWER_GALLERY_MOCK_BACKEND__?: true
  }
}

export function installMockBackend(): void {
  if (window.__VIEWER_GALLERY_MOCK_BACKEND__) return
  window.__VIEWER_GALLERY_MOCK_BACKEND__ = true

  const real = window.fetch.bind(window)
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    const path = url.startsWith("http") ? new URL(url).pathname : url.split("?")[0]
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase()
    const answer = route(path, method)
    return answer ?? real(input, init)
  }
}
