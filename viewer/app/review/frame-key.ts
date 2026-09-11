import type { ProcessStatus } from "../../server/serve/prototype-processes"
import type { BridgeGeneration } from "./use-viewer-bridge"

/**
 * What the review page keys the prototype iframe on, and when that key
 * changes. A changed key remounts the frame, and a remounted frame's first
 * request is what starts a server prototype's child. So the key must change
 * exactly when a restart is wanted, and never otherwise:
 *
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
 * The first body a page sees only RECORDS the generation it is following;
 * it never changes the key, since that frame is the one whose request
 * started (or will start) the child.
 */
export interface FrameKeyState {
  key: BridgeGeneration
  /** The generation this frame follows, or null before any server body was seen. */
  generation: number | null
}

export const INITIAL_FRAME_KEY: FrameKeyState = { key: "static", generation: null }

export function nextFrameKey(
  previous: FrameKeyState,
  serve: "static" | "server" | undefined,
  status: ProcessStatus | undefined,
): FrameKeyState {
  if (serve !== "server" || !status || !("generation" in status)) return previous
  if (status.state === "crashed") {
    if (!status.retryable) return previous
    const next = status.generation + 1
    return previous.key === next ? previous : { key: next, generation: next }
  }
  if (previous.generation === null) return { key: previous.key, generation: status.generation }
  if (status.generation > previous.generation) return { key: status.generation, generation: status.generation }
  return previous
}
