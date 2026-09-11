"use client"

import { useEffect } from "react"
import type { ProcessStatus } from "../../server/serve/prototype-processes"
import { readPrototypeOrigin } from "./[slug]/prototype-origin-response"

/**
 * Does a freshly-polled process status mean the crashed panel should give
 * way to a fresh server render?
 *
 * Codex round 2, item 2. `review-shell.tsx` decides which panel to show
 * (`decidePrototypeEmbed`) from `project.process`, a prop resolved ONCE,
 * server-side, in `page.tsx`. `prototype-processes.ts`'s restart budget is a
 * moving five-minute window, so a crash that was NOT retryable when the page
 * rendered can become retryable a minute later with nothing on the page
 * aware of it — the reader is stuck looking at "The prototype's server
 * stopped" long after the manager would have started it again on the very
 * next request.
 *
 * Pure so it is table-tested on its own (`app/__tests__/use-process-recovery.test.ts`)
 * without mounting the hook below. True in every case EXCEPT "still crashed
 * and still not retryable" — that is the one state this page's `embed`
 * decision already agrees with, so there is nothing to refresh for.
 */
export function shouldRefreshAfterPoll(process: ProcessStatus | undefined): boolean {
  if (!process) return true
  if (process.state !== "crashed") return true
  return process.retryable
}

/**
 * Polls the prototype-origin route while a crashed panel is on screen, and
 * calls `onShouldRefresh` (the caller's `router.refresh()`) the moment the
 * polled status says the crash is no longer a dead end.
 *
 * `active` gates the whole hook rather than the caller choosing whether to
 * mount it: `review-shell.tsx`'s tree keeps `PrototypeUnavailable` mounted
 * across every `embed.kind`, so this needs its own on/off switch instead of
 * relying on mount/unmount to start and stop the interval.
 *
 * The route polled, `GET /api/v1/projects/:id/prototype-origin`, is the same
 * one `page.tsx` calls server-side — any reader who can already see this
 * project may call it, so the poll runs for every viewer of the crashed
 * panel, not only a manager who can also see the Rebuild button
 * (`prototype-unavailable.tsx`'s `CrashedControls`, which is canManage-only).
 * A browser `fetch` to a same-origin path sends the session cookie on its
 * own, so no `X-Viewer-Shell-Origin` juggling is needed the way the internal
 * server-side hop in `page.tsx` requires.
 *
 * `intervalMs` is a parameter, not a constant, so a test can drive several
 * ticks without a real 30s wait and the surface gallery can do the same for
 * a demo state.
 */
export function useProcessRecovery(options: {
  active: boolean
  projectId: string
  onShouldRefresh: () => void
  intervalMs?: number
}): void {
  const { active, projectId, onShouldRefresh, intervalMs = 30_000 } = options

  useEffect(() => {
    if (!active) return
    let cancelled = false

    async function poll(): Promise<void> {
      try {
        const res = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/prototype-origin`, {
          cache: "no-store",
        })
        // An unrecognised body (including malformed JSON, caught below)
        // parses to the fallback shape via `readPrototypeOrigin`, whose
        // `process` is `undefined` — `shouldRefreshAfterPoll` treats that as
        // "refresh", so a response this poll cannot make sense of still
        // gives the reader a chance to see a fresh render rather than
        // silently doing nothing.
        const body: unknown = await res.json().catch(() => null)
        if (cancelled) return
        const { process } = readPrototypeOrigin(body)
        if (shouldRefreshAfterPoll(process)) onShouldRefresh()
      } catch {
        // A network hiccup says nothing about whether the process is still
        // stuck. Leave it for the next tick rather than refreshing on a
        // failed read, which would fight the reader's own retry.
      }
    }

    const timer = setInterval(() => {
      void poll()
    }, intervalMs)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [active, projectId, intervalMs, onShouldRefresh])
}
