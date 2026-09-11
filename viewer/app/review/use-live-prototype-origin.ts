"use client"

/**
 * Follows one project's prototype-origin answer live, over the server-sent
 * events route `GET /api/v1/projects/:id/prototype-origin/stream`.
 *
 * ## Why this exists
 *
 * The review page's whole embed decision — the frame, the crashed panel, the
 * ports-exhausted panel, the listener-failed panel — is computed from the
 * prototype-origin body. That body used to be resolved ONCE, server-side, in
 * `page.tsx`, and everything after that was a patch on top of a value that
 * could not change: a poll while the crashed panel was up, a second poll while
 * the frame was embedded, a `router.refresh()` from each, and a frame-epoch
 * counter to force the iframe to remount because a refresh alone left the same
 * DOM node in place. Four codex rounds (2, 4, 5, 7) found defects in that
 * arrangement, each in a different one of those pieces.
 *
 * The server now pushes the body instead. This hook holds the latest one, and
 * the page re-decides from it on every render — so a crash, a restart and a
 * recovery are ordinary state changes rather than a page reload.
 *
 * ## What it does not do
 *
 * No retry logic of its own. `EventSource` reconnects on its own schedule, and
 * while it is disconnected this keeps the last body it had, which is the right
 * answer: the page should go on showing what it last knew rather than blanking
 * on a dropped connection.
 *
 * No `EventSource` at all when the environment has none. A host without one
 * gets the server-rendered body and nothing else, rather than a crash. The
 * surface gallery and the review suites install a fake instead, so their
 * streams connect to nothing and deliver only what a fixture or a test asks
 * for.
 */

import { useEffect, useState } from "react"
import { readPrototypeOrigin, type ReviewEmbedOrigin } from "./[slug]/prototype-origin-response"

export function useLivePrototypeOrigin(
  projectId: string,
  initial: ReviewEmbedOrigin,
): ReviewEmbedOrigin {
  /**
   * `null` until the first event, rather than seeding with `initial`. Seeding
   * would make a later change to the server-rendered prop invisible, and it
   * would also mean re-rendering once on connect for a body identical to the
   * one already on screen.
   */
  const [live, setLive] = useState<ReviewEmbedOrigin | null>(null)

  /**
   * The server-rendered body the followed one is an update OF.
   *
   * A NEW `initial` means the page was re-rendered with something this hook
   * has not seen — a rebuild's `router.refresh()`, whose whole point is that
   * the active deployment changed. Whatever the stream delivered up to now
   * describes the OLD deployment, so it is dropped, and the effect below
   * reconnects: a fresh connection resolves the new deployment server-side
   * at connect, ahead of the stream's own heartbeat noticing.
   *
   * Adjusted during render rather than in an effect, which is React's own
   * answer for "a prop changed and some state derived from it is now stale":
   * the stale body is never painted, and there is no second commit. Safe
   * against a loop because `initial` is memoised on the project's own fields
   * by the shell, so its identity changes only when one of them does.
   */
  const [followedFrom, setFollowedFrom] = useState<ReviewEmbedOrigin>(initial)
  if (followedFrom !== initial) {
    setFollowedFrom(initial)
    setLive(null)
  }

  useEffect(() => {
    if (typeof EventSource === "undefined") return
    const source = new EventSource(
      `/api/v1/projects/${encodeURIComponent(projectId)}/prototype-origin/stream`,
    )

    function onOrigin(event: Event): void {
      const raw = (event as MessageEvent<string>).data
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        // Not JSON at all. Nothing to act on, and the body already on screen
        // is a better answer than any guess made from an unreadable frame.
        return
      }
      // "Is this even a body" — checked on the RAW value, before the parser
      // below gets it. `readPrototypeOrigin` answers its fallback shape for
      // anything it does not recognise, and that shape is also what a genuine
      // fallback-mode static prototype answers with, so the two cannot be told
      // apart after the fact. Refusing a non-object here is the only place the
      // difference is still visible.
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return
      setLive(readPrototypeOrigin(parsed))
    }

    source.addEventListener("origin", onOrigin)
    return () => {
      source.removeEventListener("origin", onOrigin)
      source.close()
    }
  }, [projectId, initial])

  return live ?? initial
}
