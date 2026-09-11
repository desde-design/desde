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
 *
 * Every panel this can return is a state a STATIC prototype never reaches.
 * That is the property to preserve when adding a branch: before this feature
 * every static prototype loaded in every mode, and it still must.
 */

import type { OriginMode } from "../../../server/serve/prototype-origin-resolve"
import type { ProcessStatus } from "../../../server/serve/prototype-processes"
import type { DeploymentServe } from "../../../server/storage/types"

export type PrototypeEmbed =
  | { kind: "embed" }
  | { kind: "needs-origin" }
  /** `count` is how many ports the range holds, or `null` when none was reported. */
  | { kind: "ports-exhausted"; count: number | null }
  | { kind: "crashed"; reason: string }

/**
 * Checked in this order:
 *
 * 1. `reason: "ports-exhausted"` on a SERVER deployment — the loopback
 *    listener registry is full, and a server prototype has nowhere else to
 *    run. A STATIC one does: the page's fallback shape serves it from the
 *    asset store under the shell's own path prefix, exactly as it did before
 *    listeners existed, so blanking it would be a regression.
 * 2. A static deployment always embeds — the router proxies static assets in
 *    every mode, so there is nothing here to say.
 * 3. A server deployment needs an origin of its own: only `loopback` and
 *    `subdomain` mode can proxy it.
 * 4. A server deployment whose process crashed and will NOT be retried shows
 *    the crash instead of an iframe that would just 503. A retryable crash
 *    embeds: the iframe's own request is the `ensure` that restarts it, and
 *    that takes seconds where the panel offers a multi-minute rebuild. The
 *    verdict is the manager's (`ProcessStatus.retryable`), never a second
 *    copy of its restart budget written here.
 * 5. Otherwise, embed — including `starting` and `stopped`, both of which the
 *    router starts on the iframe's own request.
 */
export function decidePrototypeEmbed(input: {
  mode: OriginMode
  serve: DeploymentServe
  process?: ProcessStatus
  reason?: "ports-exhausted"
  /** The configured loopback port range, when the server reported one. */
  range?: { from: number; to: number } | null
}): PrototypeEmbed {
  if (input.reason === "ports-exhausted" && input.serve === "server") {
    const range = input.range ?? null
    return { kind: "ports-exhausted", count: range ? range.to - range.from + 1 : null }
  }
  if (input.serve === "static") return { kind: "embed" }
  if (input.mode !== "loopback" && input.mode !== "subdomain") return { kind: "needs-origin" }
  if (input.process?.state === "crashed" && !input.process.retryable) {
    return { kind: "crashed", reason: input.process.reason }
  }
  return { kind: "embed" }
}
