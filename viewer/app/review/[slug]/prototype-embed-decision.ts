/**
 * What the review iframe's slot should show for one prototype, right now.
 *
 * Pure, so every branch is tested (`app/__tests__/prototype-embed-decision.test.ts`);
 * `review-shell.tsx` only carries out the answer, in `PrototypeUnavailable`
 * (`prototype-unavailable.tsx`).
 *
 * A **server prototype** (`Deployment.serve === "server"`, server-prototypes
 * work, 2026-09-10) is a process the viewer runs and proxies to, not a folder
 * of static files. The router can only proxy it when the review iframe sits at
 * the ORIGIN ROOT — loopback and subdomain mode. In `prototype-origin` mode
 * (the shared `VIEWER_PROTOTYPE_ORIGIN` host, path-namespaced) and `fallback`
 * mode (path-namespaced under the shell's own origin), the router answers 409
 * for a server deployment, because a process expects to own the whole origin,
 * not a path prefix under it. So those two modes get a panel explaining that,
 * instead of an iframe that would just 503 or 409.
 */

import type { OriginMode } from "../../../server/serve/prototype-origin-resolve"
import type { ProcessStatus } from "../../../server/serve/prototype-processes"
import type { DeploymentServe } from "../../../server/storage/types"

export type PrototypeEmbed =
  | { kind: "embed" }
  | { kind: "needs-origin" }
  | { kind: "ports-exhausted" }
  | { kind: "crashed"; reason: string }

/**
 * Checked in this order:
 *
 * 1. `reason: "ports-exhausted"` — the loopback listener registry is full.
 *    This wins over everything else: even a STATIC prototype could not be
 *    reached in loopback mode right now, because the 503 the route answered
 *    means no listener was opened for it at all.
 * 2. A static deployment always embeds — the router proxies static assets in
 *    every mode, so there is nothing here to say.
 * 3. A server deployment needs an origin of its own: only `loopback` and
 *    `subdomain` mode can proxy it.
 * 4. A server deployment whose process has crashed shows the crash instead
 *    of an iframe that would just 503.
 * 5. Otherwise, embed — including `starting` and `stopped`, both of which the
 *    router starts on the iframe's own request.
 */
export function decidePrototypeEmbed(input: {
  mode: OriginMode
  serve: DeploymentServe
  process?: ProcessStatus
  reason?: "ports-exhausted"
}): PrototypeEmbed {
  if (input.reason === "ports-exhausted") return { kind: "ports-exhausted" }
  if (input.serve === "static") return { kind: "embed" }
  if (input.mode !== "loopback" && input.mode !== "subdomain") return { kind: "needs-origin" }
  if (input.process?.state === "crashed") return { kind: "crashed", reason: input.process.reason }
  return { kind: "embed" }
}
