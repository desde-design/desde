import { headers } from "next/headers"
import { notFound } from "next/navigation"
import type { ViewerConfig } from "../../../server/config"
import { loadConfig } from "../../../server/config"
import { buildHostAllowlist, isAllowedHost } from "../../../server/serve/host-allowlist"
import { mintPrototypeCapability } from "../../../server/serve/prototype-capability"
import {
  resolveOrigins,
  SHELL_ORIGIN_HEADER,
  type OriginMode,
} from "../../../server/serve/prototype-origin-resolve"
import { prototypeAnonymouslyReadable } from "../../prototype-origin"
import { NeverDeployed } from "./never-deployed"
import { ReviewShell } from "./review-shell"

export interface ProjectSummary {
  id: string
  slug: string
  name: string
  activeDeploymentId: string | null
  access: "all-members" | "invited" | "public-link"
}

/** The two fields of the prototype-origin answer this page acts on. */
export interface ReviewEmbedOrigin {
  mode: OriginMode
  origin: string | null
}

/** What every unusable answer resolves to. See `readPrototypeOrigin`. */
const FALLBACK_EMBED_ORIGIN: ReviewEmbedOrigin = { mode: "fallback", origin: null }

/**
 * Base URL for the internal `GET /api/v1/projects` fetch below: loopback,
 * on the SAME port `server/index.ts` already binds the shared Express+Next
 * process to (one `app.listen(config.port, ...)` serves both). Fix round 1
 * (Phase 3b-1 Task 3 review): this used to be built from the inbound
 * `Host`/`X-Forwarded-Proto` headers, which are attacker-controlled — that
 * was already a latent SSRF-shaped bug (an unauthenticated request could be
 * pointed at an attacker-named host), but forwarding the session cookie
 * (below) upgraded it to credential exfiltration: a poisoned `Host` header
 * would have sent the reviewer's `viewer_session` cookie to wherever the
 * attacker named. The target here is always this same process, so it is
 * derived from config instead. Pulled out as a pure function purely for
 * testability (`loadConfig` itself just reads `process.env`, so this needs no
 * request context).
 *
 * "Never trust the request Host" is NOT the general rule this comment used to
 * state, and `reviewShellOrigin` below is the case that distinguishes it. A
 * fetch TARGET built from the Host is unbounded — the attacker names the
 * string, and the cookie goes there. The shell origin is bounded: the request
 * Host is only consulted after `isAllowedHost` has already reduced it to a
 * closed set built from config, so the output is one of at most four fixed
 * strings and a request cannot invent a fifth. The dangerous thing was never
 * reading the Host; it was emitting a value derived from an unchecked one.
 */
export function internalApiBaseUrl(port: number): string {
  return `http://127.0.0.1:${port}`
}

/**
 * `RequestInit` for the internal `GET /api/v1/projects` fetch below,
 * pulled out as a pure function so the cookie-forwarding behavior is
 * testable without a Next.js request context (`headers()` only works
 * inside an actual server-component render). `cookie` is whatever
 * `hdrs.get("cookie")` returned — `null` when the inbound request carried
 * no `Cookie` header at all (an anonymous visitor, or `public-link`
 * access), in which case `headers` is omitted rather than sent as `{
 * cookie: null }`, which `fetch` would stringify into the literal header
 * value `"null"`.
 */
export function internalProjectsFetchInit(cookie: string | null): RequestInit {
  return {
    cache: "no-store",
    ...(cookie ? { headers: { cookie } } : {}),
  }
}

/**
 * `RequestInit` for the internal `GET /api/v1/projects/:id/prototype-origin`
 * fetch below.
 *
 * Two headers, both load-bearing:
 *
 * - `cookie`, for the same reason the projects hop forwards it: the route runs
 *   the caller's own read check, so an unforwarded cookie makes every
 *   signed-in reviewer look anonymous and a private project 404s for its own
 *   members. Omitted entirely when there is none, because `fetch` stringifies
 *   a `null` value into the literal header value `"null"`.
 * - `SHELL_ORIGIN_HEADER`, ALWAYS. This hop's own `Host` is
 *   `127.0.0.1:<config.port>` — never the spelling the reviewer typed — and
 *   the route pairs the prototype's loopback host against the shell's. Pairing
 *   off the hop's Host would put the prototype on `[::1]` for a reviewer on
 *   `localhost`, or hand back the shell's OWN origin for a reviewer on
 *   `127.0.0.1`, which is the single outcome the host flip exists to prevent.
 *   The route refuses any value outside a closed set built from config, so
 *   stating it is a request, not an assertion.
 */
export function internalPrototypeOriginFetchInit(
  cookie: string | null,
  shellOrigin: string,
): RequestInit {
  return {
    cache: "no-store",
    headers: {
      ...(cookie ? { cookie } : {}),
      [SHELL_ORIGIN_HEADER]: shellOrigin,
    },
  }
}

/**
 * The origin THIS shell is on for this request.
 *
 * The reviewer's loopback spelling is not knowable at boot — they may type
 * `localhost`, `127.0.0.1` or `[::1]`, and all three reach this process — so
 * it has to come from the request. Trusting the request Host is safe here for
 * a reason that does not generalize: `isAllowedHost` has already compared it
 * against a closed set built from config, and `resolveOrigins` only uses it
 * when that check passed AND `publicUrl` is itself loopback. The output is
 * always one of that closed, config-derived set; a request can only select
 * among it, never add to it. (Not literally "four fixed strings" in every
 * configuration: a loopback `publicUrl` with no explicit port accepts more
 * than one port suffix, so the set can hold more than four entries. See
 * `create-app.ts`'s `resolveShellOriginForRequest` comment.) See
 * `internalApiBaseUrl`'s comment for the case where the same reasoning does
 * NOT hold.
 *
 * `hostIsPrototype` is `false` by construction, not by inspection: a prototype
 * host never reaches this page. `create-app.ts` mounts the prototype-host
 * scope and its API fence ahead of every shell router, and the loopback
 * listener app mounts the same fence, so a request on a prototype origin is
 * refused before it can be routed to a Next page at all.
 */
export function reviewShellOrigin(
  config: Pick<ViewerConfig, "publicUrl" | "port" | "serveDomain" | "loopbackAvailable" | "prototypeOrigin">,
  requestHost: string | undefined,
): string {
  const allowlist = buildHostAllowlist(config)
  return resolveOrigins({
    requestHost,
    hostAllowed: isAllowedHost(allowlist, requestHost, config.serveDomain),
    hostIsPrototype: false,
    publicUrl: config.publicUrl,
    serveDomain: config.serveDomain,
    loopbackAvailable: config.loopbackAvailable,
    prototypeOrigin: config.prototypeOrigin,
  }).shellOrigin
}

/**
 * The prototype-origin route's body, reduced to the two fields this page acts
 * on, with every shape it does not recognise collapsed to fallback.
 *
 * Failing closed is the point. Fallback is today's behaviour — the sandboxed
 * same-host embed — which works. The other direction, inventing an isolated
 * origin out of a shape nobody vouched for, is what would hand
 * `allow-same-origin` to a frame the server never named. `capabilityRequired`
 * is deliberately ignored: this page mints a capability by its own rule
 * (`prototypeAnonymouslyReadable`), and it must keep minting one even in an
 * isolated mode, because `resolvePrototypeEmbed` can still fall back to the
 * path prefix, where the capability is what makes the sandbox affordable.
 */
export function readPrototypeOrigin(value: unknown): ReviewEmbedOrigin {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return FALLBACK_EMBED_ORIGIN
  }
  const { mode, origin } = value as { mode?: unknown; origin?: unknown }
  if (
    mode !== "loopback" &&
    mode !== "subdomain" &&
    mode !== "fallback" &&
    mode !== "prototype-origin"
  ) {
    return FALLBACK_EMBED_ORIGIN
  }
  if (origin !== null && typeof origin !== "string") return FALLBACK_EMBED_ORIGIN
  return { mode, origin }
}

/**
 * What a slug resolves to on the review route.
 *
 * Three outcomes, not two, and the split matters. `not-found` and
 * `no-deployment` used to be the same `null`, which meant a project you were
 * perfectly entitled to see 404'd because nobody had built it yet. The
 * dashboard then had to render its card as a disabled control, and a disabled
 * control reads as "you are not allowed" when the truth is "there is nothing
 * here yet" (Mo, 2026-09-01).
 */
export type ReviewProjectResolution =
  | { kind: "not-found" }
  | { kind: "no-deployment"; project: ProjectSummary }
  | { kind: "ok"; project: ProjectSummary }

/**
 * Finds the project matching `slug` in an already-filtered project list.
 *
 * **Why telling `not-found` from `no-deployment` here leaks nothing.**
 * `GET /api/v1/projects` builds its list by calling `canReadProject` per
 * project and pushing only the ones that pass (see
 * `../../../server/api/projects-routes.ts`, the `readable` loop). Read
 * authority is therefore settled BEFORE deployment status is ever consulted,
 * and a caller who may not know this project exists never appears in the same
 * branch as one who may: they fail `projects.find` and get `not-found`, byte
 * for byte as before.
 *
 * That is the whole argument, and it is why this split is safe while the same
 * split on a by-id lookup would not be. Keep the ORDER: absence from the list
 * is checked first, and nothing about a project may be returned before it.
 */
export function resolveReviewProject(
  projects: ProjectSummary[],
  slug: string,
): ReviewProjectResolution {
  const project = projects.find((p) => p.slug === slug)
  if (!project) return { kind: "not-found" }
  if (!project.activeDeploymentId) return { kind: "no-deployment", project }
  return { kind: "ok", project }
}

/**
 * Server component: resolves the project by slug and renders the
 * interactive review shell. There's no `GET /api/v1/projects/:slug` route
 * (only by id) — same as `ProjectsList`, this fetches the list and finds
 * by slug.
 *
 * Fetching same-origin from a Server Component needs an absolute URL (this
 * app is mounted inside a plain Express `next(...).getRequestHandler()`
 * process, not `next start`, so there's no implicit base URL) — built from
 * trusted `server/config.ts` state (`internalApiBaseUrl`, see its doc
 * comment), NOT from the inbound request.
 *
 * The inbound session cookie is forwarded on this internal fetch (Phase
 * 3b-1 Task 3) — `GET /api/v1/projects` filters to only readable projects
 * (see `../../server/api/projects-routes.ts`), keyed off `getCurrentUser`
 * reading the `Cookie` header. Without forwarding it, EVERY signed-in
 * reviewer would look anonymous to that filter and a `members`-visibility
 * project would 404 here even for its own members. `public-link` projects
 * are unaffected either way — they're always in the filtered list.
 *
 * There are TWO such hops now (Milestone 2). The second asks
 * `GET /api/v1/projects/:id/prototype-origin` where this prototype should be
 * embedded from, which cannot be answered in-process: the loopback listener
 * registry it consults lives in `server/index.ts`'s module graph, and `app/**`
 * is compiled by Next into a different one, so the singleton imported here
 * would be a different instance. Unlike the first hop, a failure on the second
 * is never fatal — it degrades to the same-host embed the viewer has always
 * used.
 */
export default async function ReviewPage({
  params,
}: {
  params: Promise<{ slug: string }>
}) {
  const { slug } = await params
  const hdrs = await headers()
  const cookie = hdrs.get("cookie")

  // Hoisted out of the try below because it is needed on the render path,
  // not just for the internal fetches: `publicUrl` and `port` are what
  // `reviewShellOrigin` resolves the shell's own origin from, and that origin
  // is what proves the prototype's is not the same one before the iframe can
  // be granted `allow-same-origin` (security audit finding S8 — see
  // `../../prototype-origin.ts`). `sessionSecret` mints the capability below.
  //
  // NOT wrapped in the try below, even though `loadConfig` is no longer a
  // pure read of `process.env` — it does disk I/O now (`loadRuntimeConfig`
  // reads, and on first call creates, `<dataDir>/config.json`), so a boot
  // that succeeded no longer proves every later call will too: the data
  // dir can vanish or go read-only while the server is running. Left
  // unwrapped anyway, deliberately: a throw here is a genuine server
  // fault — a broken deployment, not the "couldn't resolve the project"
  // case the catch below folds into 404 — and is worth a 500 rather than
  // being silently absorbed into that 404.
  const config = loadConfig()

  // Resolved once, here, and used twice below: it is stated to the
  // prototype-origin route (which pairs the prototype's loopback host against
  // it) and handed to `ReviewShell` (which needs it to prove the prototype's
  // origin is not its own before granting `allow-same-origin`). One
  // computation, so the two can never disagree.
  const shellOrigin = reviewShellOrigin(config, hdrs.get("host") ?? undefined)

  // A network-level throw (connection refused, DNS hiccup) is folded into
  // the same not-found path as a non-OK response — both mean "couldn't
  // resolve the project" from this page's perspective, and a bare fetch
  // rejection left uncaught would otherwise crash the render with an
  // unhandled error instead of the app's normal not-found boundary.
  let data: { projects: ProjectSummary[]; publicLinksEnabled?: boolean } | null = null
  try {
    const res = await fetch(
      `${internalApiBaseUrl(config.port)}/api/v1/projects`,
      internalProjectsFetchInit(cookie),
    )
    if (res.ok) {
      data = (await res.json()) as { projects: ProjectSummary[]; publicLinksEnabled?: boolean }
    }
  } catch {
    data = null
  }
  if (!data) notFound()

  const resolution = resolveReviewProject(data.projects, slug)
  // Unreadable or nonexistent: the byte-identical 404, exactly as before.
  if (resolution.kind === "not-found") notFound()
  // Readable, just never built. Nothing below this line applies: there is no
  // deployment to embed, so no capability to mint and no origin to resolve.
  if (resolution.kind === "no-deployment") {
    return <NeverDeployed project={resolution.project} />
  }
  const project = resolution.project

  // Defaults to `false` (not `true`) on an older/malformed response — the
  // safe direction. Treating a genuinely-off kill switch as on would skip
  // minting the capability below and, in subdomain mode, sandbox the iframe
  // as if its assets needed no cookie when they still do — a signed-in
  // member's iframe 404s. The reverse mistake (treating "on" as "off") only
  // mints a capability nothing needed; harmless. See
  // `prototypeAnonymouslyReadable`'s doc comment.
  const publicLinksEnabled = data.publicLinksEnabled === true

  // THE authorization point for the capability below: everything above this
  // line is the gate. `GET /api/v1/projects` returned only projects this
  // caller may read (it ran with the caller's forwarded session cookie), and
  // `resolveReviewProject` additionally required an active deployment — so
  // by here the caller has already been admitted to exactly this project by
  // the ordinary rule. Minting cannot widen that; it re-expresses it as a
  // credential the browser will still send from an opaque origin, which the
  // `SameSite=Lax` cookie will not (security audit finding B1; see
  // `../../prototype-origin.ts` and `server/serve/prototype-capability.ts`).
  //
  // Not minted for an anonymously-readable prototype: its assets need no
  // credential, so a capability would be a short-lived secret protecting
  // something that is not secret. `publicLinksEnabled` is part of that
  // question now (Milestone 2): with the instance-wide kill switch off, a
  // `"public-link"` project's assets need the cookie exactly like any other
  // project's, so it gets a capability minted for it too — the OLD
  // mechanical `access === "public-link"` check would have skipped minting
  // here and sandboxed a member's iframe onto assets that still 404 without
  // the cookie.
  const capability = prototypeAnonymouslyReadable(project.access, publicLinksEnabled)
    ? null
    : mintPrototypeCapability({
        secret: config.sessionSecret,
        slug: project.slug,
        deploymentId: project.activeDeploymentId,
      })

  // Where to embed the prototype from. Over the SAME internal hop the project
  // list came from, and for the same reason: under the custom server, `app/**`
  // is compiled by Next into its own module graph, so the listener registry
  // imported here would be a DIFFERENT instance from the one `server/index.ts`
  // holds. The route is the only way to reach the real one.
  //
  // AFTER the project lookup above, which is the authorization gate: the route
  // runs its own read check with the same forwarded cookie, so this is the
  // second of two independent admissions, not the first.
  //
  // Every failure — non-OK, network throw, malformed JSON, a body shape this
  // page does not recognise — lands on fallback, and fallback is today's
  // sandboxed same-host embed. A prototype origin is an ENHANCEMENT over that;
  // nothing here is worth failing a review page for.
  let embedOrigin: ReviewEmbedOrigin = FALLBACK_EMBED_ORIGIN
  try {
    const res = await fetch(
      `${internalApiBaseUrl(config.port)}/api/v1/projects/${encodeURIComponent(project.id)}/prototype-origin`,
      internalPrototypeOriginFetchInit(cookie, shellOrigin),
    )
    if (res.ok) embedOrigin = readPrototypeOrigin(await res.json())
  } catch {
    embedOrigin = FALLBACK_EMBED_ORIGIN
  }

  return (
    <ReviewShell
      project={{
        id: project.id,
        slug: project.slug,
        name: project.name,
        access: project.access,
        publicLinksEnabled,
        // Not used to build the iframe origin (that is `shellOrigin` /
        // `prototypeOrigin` below); the Deployments panel reads it to decide
        // whether a deploy-time root-absolute-asset warning applies.
        serveDomain: config.serveDomain,
        capability,
        // The three per-request origin fields. All resolved server-side:
        // nothing downstream may recompute any of this from `window.location`,
        // because the `<iframe>` is part of the server-rendered HTML and the
        // browser starts fetching its `src` before the shell bundle has even
        // hydrated.
        shellOrigin,
        prototypeOrigin: embedOrigin.origin,
        mode: embedOrigin.mode,
      }}
    />
  )
}
