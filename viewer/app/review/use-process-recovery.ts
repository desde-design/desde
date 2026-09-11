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
 * Same question as `shouldRefreshAfterPoll`, asked from the OPPOSITE
 * starting point.
 *
 * `shouldRefreshAfterPoll` is asked while a crashed panel is already on
 * screen, so an unrecognised body is treated as "refresh" — the worst it can
 * do is trade one failure state for another. This one is asked while the
 * iframe is EMBEDDED and presumed fine. An unrecognised body here (a
 * malformed response, an older server, a hiccup `readPrototypeOrigin`
 * collapses to its fallback shape) must NOT refresh: a server that started
 * sending a shape this poll cannot parse would otherwise refresh the page
 * forever, fighting the reader on every tick. So this refreshes on exactly
 * one thing: an explicit `crashed`, retryable or not — either way the
 * server-side render decides the right panel (or a fresh frame) once it
 * re-resolves `project.process`.
 *
 * Pure and table-tested for the same reason as `shouldRefreshAfterPoll`
 * (`app/__tests__/use-process-recovery.test.ts`), without mounting the hook.
 */
export function shouldRefreshWhileEmbedded(process: ProcessStatus | undefined): boolean {
  return process?.state === "crashed"
}

/** How often `useProcessRecovery`'s `"embedded"` mode polls before a `running` state has been observed. */
const EMBEDDED_FAST_POLL_MS = 5_000
/** How often it polls once `running` has been observed at least once. */
const EMBEDDED_SLOW_POLL_MS = 30_000

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
 * a demo state. It applies only to `mode: "crashed-panel"` — `"embedded"`
 * has its own fixed two-speed cadence (see `mode` below), because that mode's
 * whole point is the SWITCH between two fixed speeds, not one configurable
 * one.
 *
 * `mode` picks which question this poll asks of the SAME route, and which
 * panel it is standing in for (codex round 4, Fix 2):
 *
 * - `"crashed-panel"` (the default, and the only mode before this) — a
 *   crashed panel is already on screen (`PrototypeUnavailable`), and this
 *   polls to notice the manager's restart budget aging out, via
 *   `shouldRefreshAfterPoll`. Unchanged from before.
 * - `"embedded"` — a SERVER deployment's iframe is on screen and PRESUMED
 *   fine. Nothing else notices a start failure or a later crash happening
 *   INSIDE that iframe: the proxy's 503 lands inside the frame, and
 *   `project.process` (resolved once, server-side) never changes on its own.
 *   This polls the same route and calls `onShouldRefresh` the moment
 *   `shouldRefreshWhileEmbedded` says the process has crashed, so the
 *   server-rendered page can re-resolve and swap in the right panel (or a
 *   fresh frame, if the crash already cleared by the time the render runs).
 *   Polls every 5s until a `running` state has been observed at least once,
 *   then every 30s — fast while the frame is still cold-starting (so a start
 *   failure is caught quickly), slow once it is known to have come up
 *   (nothing left to catch quickly; a crash from here is rarer and the
 *   iframe itself is already visible, so there is no rush).
 */
export function useProcessRecovery(options: {
  active: boolean
  projectId: string
  onShouldRefresh: () => void
  intervalMs?: number
  mode?: "crashed-panel" | "embedded"
}): void {
  const { active, projectId, onShouldRefresh, intervalMs = 30_000, mode = "crashed-panel" } = options

  useEffect(() => {
    if (!active) return
    let cancelled = false

    async function fetchProcess(): Promise<ProcessStatus | undefined> {
      const res = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/prototype-origin`, {
        cache: "no-store",
      })
      const body: unknown = await res.json().catch(() => null)
      return readPrototypeOrigin(body).process
    }

    if (mode === "crashed-panel") {
      async function poll(): Promise<void> {
        try {
          // An unrecognised body (including malformed JSON, caught above)
          // parses to the fallback shape via `readPrototypeOrigin`, whose
          // `process` is `undefined` — `shouldRefreshAfterPoll` treats that
          // as "refresh", so a response this poll cannot make sense of still
          // gives the reader a chance to see a fresh render rather than
          // silently doing nothing.
          const process = await fetchProcess()
          if (cancelled) return
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
    }

    // `mode === "embedded"`. A self-scheduling `setTimeout` chain rather than
    // `setInterval`, because the cadence itself changes once `running` is
    // observed — `setInterval`'s period is fixed at the moment it is created,
    // and there is no way to widen it in place without tearing it down and
    // building a new one, which a chain does for free on every tick.
    let hasSeenRunning = false
    let timer: ReturnType<typeof setTimeout>

    async function pollEmbedded(): Promise<void> {
      try {
        const process = await fetchProcess()
        if (cancelled) return
        if (process?.state === "running") hasSeenRunning = true
        // Unlike the crashed-panel branch above, an unrecognised body must
        // NOT refresh here — see `shouldRefreshWhileEmbedded`'s own doc
        // comment for why.
        if (shouldRefreshWhileEmbedded(process)) onShouldRefresh()
      } catch {
        // Same reasoning as the crashed-panel branch: a network hiccup is
        // not a verdict on the process, so it is left for the next tick.
      } finally {
        if (!cancelled) {
          timer = setTimeout(
            () => void pollEmbedded(),
            hasSeenRunning ? EMBEDDED_SLOW_POLL_MS : EMBEDDED_FAST_POLL_MS,
          )
        }
      }
    }

    timer = setTimeout(() => void pollEmbedded(), EMBEDDED_FAST_POLL_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [active, projectId, intervalMs, mode, onShouldRefresh])
}
