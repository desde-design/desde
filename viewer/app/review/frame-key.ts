import type { ProcessStatus } from "../../server/serve/prototype-processes"
import type { BridgeGeneration } from "./use-viewer-bridge"

/**
 * What the review page keys the prototype iframe on, and when that key
 * changes. A changed key remounts the frame, and a remounted frame's first
 * request is what starts a server prototype's child. So the key must change
 * exactly when a restart is wanted, and never otherwise:
 *
 * - a NEW DEPLOYMENT: the build in the frame is not the live one any more.
 *   The page also asks Next to re-render for this (the capability in the
 *   frame's URL was minted for the previous deployment), but a refresh keeps
 *   the client component and its DOM, so React reuses the iframe node. The
 *   URL alone cannot stand in for the deployment: a static prototype's path
 *   never names it, a subdomain is one string for every build, and two server
 *   builds both start at generation 1. Without the deployment in the key, all
 *   three cases leave the OLD build on screen for ever.
 * - a RETRYABLE crash: the frame is showing the child's last answer or the
 *   proxy's 502, and the manager would restart on the next request. The key
 *   becomes the generation that restart will have, so the `starting` and
 *   `running` bodies that follow share it (one restart, one remount).
 * - a `running` or `starting` body under a generation NEWER than the one
 *   this frame is following: another tab restarted the child, and this
 *   frame's document came from a process that is gone.
 * - anything else keeps the key. `stopped` in particular: the idle reaper
 *   put the child away on purpose, and a remount here would restart it, so
 *   an open tab would rotate cold starts for ever (final review, N1). The
 *   frame keeps its document; the next click in it starts the child again.
 *
 * The generation rules are scoped to the deployment being followed, which is
 * why the state records that too. A generation only means anything beside the
 * build it was counted for.
 *
 * The first body a page sees only RECORDS the deployment and generation it is
 * following; it never changes the key, since that frame is the one whose
 * request started (or will start) the child.
 */
export interface FrameKeyState {
  key: BridgeGeneration
  /** The generation this frame follows, or null before any server body was seen. */
  generation: number | null
  /** The deployment this frame follows, or null before any body named one. */
  deployment: string | null
}

export const INITIAL_FRAME_KEY: FrameKeyState = { key: "static", generation: null, deployment: null }

export function nextFrameKey(
  previous: FrameKeyState,
  serve: "static" | "server" | undefined,
  status: ProcessStatus | undefined,
  deploymentId?: string | null,
): FrameKeyState {
  const deployment = deploymentId ?? null
  const server = serve === "server" && !!status && "generation" in status

  if (deployment !== null && previous.deployment !== null && deployment !== previous.deployment) {
    // A build the frame has never loaded. The key carries the deployment id so
    // it cannot collide with anything the generation rules below produce, and
    // the generation it is paired with is the NEW deployment's, not the one
    // this frame had been counting from.
    const generation = server ? status.generation : null
    return {
      key: generation === null ? `${deployment}#static` : `${deployment}#${generation}`,
      generation,
      deployment,
    }
  }

  // Same deployment (or a body that named none): record the deployment on the
  // first body that does name one, and leave the key to the rules below.
  const followed = previous.deployment ?? deployment
  const kept = followed === previous.deployment ? previous : { ...previous, deployment: followed }

  if (!server) return kept
  if (status.state === "crashed") {
    if (!status.retryable) return kept
    const next = status.generation + 1
    return previous.key === next ? kept : { key: next, generation: next, deployment: followed }
  }
  if (previous.generation === null) {
    return { key: previous.key, generation: status.generation, deployment: followed }
  }
  if (status.generation > previous.generation) {
    return { key: status.generation, generation: status.generation, deployment: followed }
  }
  return kept
}
