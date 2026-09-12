/**
 * Parsing the `GET /api/v1/projects/:id/prototype-origin` route's body.
 *
 * Its own module, split out of `page.tsx` (codex round 2, item 2): `page.tsx`
 * is a Server Component that imports `next/headers` and `server/config.ts` at
 * its top level, both VALUE imports, so any client module that imported so
 * much as a pure function from it would drag the whole file — and those two
 * modules — into the client bundle. Confirmed with `next build --webpack`:
 * "You're importing a module that depends on next/headers into a React
 * Client Component module." `use-live-prototype-origin.ts` needs this exact
 * parser client-side (it reads the same body off the route's event stream),
 * so the parser lives here instead, with only TYPE imports —
 * `OriginMode`, `ProcessStatus`, `DeploymentServe` — which TypeScript erases
 * entirely at compile time and cost the client bundle nothing.
 *
 * `page.tsx` re-exports both names from here, so every existing import of
 * `ReviewEmbedOrigin` / `readPrototypeOrigin` from `"./page"` (including
 * `page.test.ts`) needs no edit.
 */

import type { OriginMode } from "../../../server/serve/prototype-origin-resolve"
import type { ProcessStatus } from "../../../server/serve/prototype-processes"
import type { DeploymentServe } from "../../../server/storage/types"

/**
 * The fields of the prototype-origin answer this page acts on.
 *
 * `serve` and `process` (server-prototypes work, 2026-09-10) say whether the
 * project's active deployment is a folder of files or a process, and what
 * that process is doing. `range` is the configured loopback port range, sent
 * with loopback mode's bodies and with the ports-exhausted 503 — it is what
 * the port banner names the `-p` flag from, and what the exhausted panel
 * counts. `reason` carries the two 503 reasons this page cares about: the
 * loopback port range is full (`"ports-exhausted"`), or a listener could not
 * be opened for some other reason (`"listener-failed"`, codex round 6, Fix
 * 2 — an `EADDRNOTAVAIL` on an IPv4-only host trying `::1`, say). Neither
 * 503 carries a `mode`, so both fall back to `"fallback"` here — but a
 * STATIC deployment still loads fine from the shell's own path prefix in
 * fallback mode, which is why `serve` travels alongside `reason` rather than
 * this page just blanking the frame outright.
 */
export interface ReviewEmbedOrigin {
  mode: OriginMode
  origin: string | null
  serve: DeploymentServe
  process?: ProcessStatus
  range: { from: number; to: number } | null
  reason?: "ports-exhausted" | "listener-failed"
  /**
   * Where the bridge bundle lives on the prototype origin, relative to its
   * root (`__desde/bridge-<version>.js`), or `null` when the server did not
   * say. The port watchdog probes it: the serve router answers it before the
   * server-prototype fork, so it proves the PORT is reachable without waiting
   * on a cold `next start`.
   */
  bridgeAssetPath?: string | null
  /**
   * Which deployment this answer was computed against. ABSENT when the body
   * named none — the project has nothing built, or the answer came from a
   * server old enough not to say.
   *
   * The shell compares it against the deployment the page was rendered with,
   * and asks Next to re-render when they differ: a new deployment needs a
   * capability only the server can mint, and the document in the frame is the
   * previous build's. Nothing else in the body can stand in for it — a static
   * rebuild has no process, two server builds can both be at generation 1,
   * and a subdomain origin is the same string for every deployment.
   */
  deploymentId?: string
}

/** What every unusable answer resolves to. See `readPrototypeOrigin`. */
export const FALLBACK_EMBED_ORIGIN: ReviewEmbedOrigin = {
  mode: "fallback",
  origin: null,
  serve: "static",
  range: null,
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
  const {
    mode,
    origin,
    serve: rawServe,
    process: rawProcess,
    range: rawRange,
    reason: rawReason,
    bridgeAssetPath: rawBridgeAssetPath,
    deploymentId: rawDeploymentId,
  } = value as {
    mode?: unknown
    origin?: unknown
    serve?: unknown
    process?: unknown
    range?: unknown
    reason?: unknown
    bridgeAssetPath?: unknown
    deploymentId?: unknown
  }

  // Read before the shape checks below can bail out: neither 503 body (ports
  // exhausted, or the generic listener failure) carries `mode` at all, and
  // the page still has to act on all three of these. `reason` says what
  // happened; `serve` decides whether it matters (a static prototype still
  // loads from the shell's own path prefix); `range` is the count the panel
  // names, when there is one.
  const reason =
    rawReason === "ports-exhausted"
      ? ("ports-exhausted" as const)
      : rawReason === "listener-failed"
        ? ("listener-failed" as const)
        : undefined
  // `serve` defaults to "static" so an older server's body (no field at all)
  // parses exactly like it used to: a static deployment, no process to show.
  const serve: DeploymentServe = rawServe === "server" ? "server" : "static"
  const range =
    typeof rawRange === "object" &&
    rawRange !== null &&
    typeof (rawRange as { from?: unknown }).from === "number" &&
    typeof (rawRange as { to?: unknown }).to === "number"
      ? (rawRange as { from: number; to: number })
      : null
  // Omitted rather than nulled when the body named none, so an older
  // server's answer parses to exactly the object it used to — see
  // `ReviewEmbedOrigin.deploymentId`. Read here, alongside `serve` and
  // `reason`, so it survives a body that fails the shape checks below too.
  const deploymentId = typeof rawDeploymentId === "string" ? rawDeploymentId : null
  /** What every unusable body falls back to, carrying what it did say. */
  const fallback: ReviewEmbedOrigin = {
    ...FALLBACK_EMBED_ORIGIN,
    serve,
    range,
    ...(reason ? { reason } : {}),
    ...(deploymentId ? { deploymentId } : {}),
  }

  if (
    mode !== "loopback" &&
    mode !== "subdomain" &&
    mode !== "fallback" &&
    mode !== "prototype-origin"
  ) {
    return fallback
  }
  if (origin !== null && typeof origin !== "string") {
    return fallback
  }

  // Named `processStatus`, not `process` — this module can run on the Node
  // server (imported from `page.tsx`), where `process` is the global.
  const processStatus =
    serve === "server" &&
    typeof rawProcess === "object" &&
    rawProcess !== null &&
    typeof (rawProcess as { state?: unknown }).state === "string"
      ? (rawProcess as ProcessStatus)
      : undefined
  // The bridge asset's path on the prototype origin, which the shell probes
  // to tell "this port is unreachable" from "this app is slow to start". A
  // body without it (an older server) leaves it null and the probe falls back
  // to the origin root. Only its TYPE is checked here: it is a path this same
  // server built, and it is used as a URL suffix, never as markup.
  // Omitted rather than nulled when absent, like `reason` above: a body that
  // did not name one should parse to exactly the object it used to.
  const bridgeAssetPath = typeof rawBridgeAssetPath === "string" ? rawBridgeAssetPath : null

  return {
    mode,
    origin,
    serve,
    process: processStatus,
    range,
    ...(bridgeAssetPath ? { bridgeAssetPath } : {}),
    ...(reason ? { reason } : {}),
    ...(deploymentId ? { deploymentId } : {}),
  }
}
