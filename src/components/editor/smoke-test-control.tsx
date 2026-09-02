"use client"

/**
 * Manual route smoke-test — the run hook + failure dialog.
 *
 * Relocated from the former "Checks" right-rail tab (removed: per-edit
 * verification is automatic and now badges the Activity row it produced —
 * see activity-panel.tsx). The route smoke-test is a manual, route-level
 * "is the prototype broken across all its screens" check, so it lives as a
 * "Run smoke test" entry in the settings gear next to Push
 * (see editor-settings-menu). The result is transient: a toast on pass, a
 * dialog of failing routes on failure. No run history is kept.
 *
 * Backend (editor-cli/src/server/smoke-test-handler.ts):
 *   POST /api/editor/smoke-test  { routes?: string[] }
 *     → { ok: true; run: SmokeRunSummary; report: SmokeReport }
 *
 * Types are inlined (not imported from editor-cli) to keep the shell
 * bundle independent of the CLI server code.
 */

import { useCallback, useState } from "react"
import { toast } from "sonner"
import { editorFetch } from "@/lib/editor-fetch"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"

// ---------------------------------------------------------------------------
// Inline type mirrors — keep in sync with editor-cli/src/smoke/types.ts
// ---------------------------------------------------------------------------

interface FailedRequest {
  url: string
  resourceType: string
  status: number | null
  failure: string | null
  /** Whether this counts toward route failure (see `failOnNetworkError`). */
  critical: boolean
}

interface RouteResult {
  route: string
  url: string
  ok: boolean
  loadOk: boolean
  httpStatus: number | null
  consoleErrors: string[]
  pageErrors: string[]
  /** Failed sub-resources (all recorded; `.critical` flags the ones that count). */
  failedRequests: FailedRequest[]
  bridgeVersion: string | null
  bridgeOk: boolean | null
  selectorFound: boolean | null
  screenshotPath: string | null
  durationMs: number
  error: string | null
}

interface SmokeReport {
  ok: boolean
  baseUrl: string
  startedAt: string
  durationMs: number
  routes: RouteResult[]
  artifactsDir: string | null
}

const MAX_ERROR_LINES = 5

/** Duration in ms → human-readable "1.2s". */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

export interface UseSmokeTestResult {
  running: boolean
  /** POST the smoke-test; toast on pass, populate `failureReport` on failure. */
  runSmokeTest: () => Promise<void>
  /** The failing-routes report from the last run (null → no dialog). */
  failureReport: SmokeReport | null
  /** Clear the failure report (closes the dialog). */
  clearFailureReport: () => void
}

/**
 * Run-and-surface hook for the manual smoke-test. Owns the in-flight flag and
 * the last failure report; the caller renders {@link SmokeTestFailureDialog}
 * with `failureReport` / `clearFailureReport`.
 */
export function useSmokeTest(): UseSmokeTestResult {
  const [running, setRunning] = useState(false)
  const [failureReport, setFailureReport] = useState<SmokeReport | null>(null)

  const runSmokeTest = useCallback(async () => {
    setRunning(true)
    try {
      const res = await editorFetch("/api/editor/smoke-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      })
      const body = (await res.json()) as
        | { ok: true; report: SmokeReport }
        | { ok: false; reason?: string }
      if (!res.ok || !body.ok) {
        toast.error("Smoke test failed to run", {
          description:
            (body as { reason?: string }).reason ??
            `Server responded ${res.status}`,
        })
        return
      }
      const report = body.report
      const total = report.routes.length
      const failed = report.routes.filter((r) => !r.ok).length
      if (report.ok) {
        toast.success(`Smoke test passed: ${total}/${total} routes`)
      } else {
        toast.warning(`Smoke test: ${failed}/${total} routes failed`)
        setFailureReport(report)
      }
    } catch (err) {
      toast.error("Smoke test failed to run", {
        description: (err as Error).message,
      })
    } finally {
      setRunning(false)
    }
  }, [])

  const clearFailureReport = useCallback(() => setFailureReport(null), [])

  return { running, runSmokeTest, failureReport, clearFailureReport }
}

/** Per-route detail row (only failing routes are rendered in the dialog). */
function RouteDetailRow({ result }: { result: RouteResult }) {
  const visibleConsole = result.consoleErrors.slice(0, MAX_ERROR_LINES)
  const extraConsole = result.consoleErrors.length - visibleConsole.length
  const visiblePage = result.pageErrors.slice(0, MAX_ERROR_LINES)
  const extraPage = result.pageErrors.length - visiblePage.length
  // Critical ones are what actually failed the route (see
  // `failOnNetworkError`); a non-critical failed sub-resource is recorded
  // but doesn't explain a red route on its own, so only critical ones are
  // shown here — same "explains the failure" bar as console/page errors.
  const criticalRequests = result.failedRequests.filter((r) => r.critical)
  const visibleRequests = criticalRequests.slice(0, MAX_ERROR_LINES)
  const extraRequests = criticalRequests.length - visibleRequests.length

  return (
    <li className="border-b px-3 py-2 text-sm last:border-b-0">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-mono text-code" title={result.route}>
          {result.route}
        </span>
        <div className="flex shrink-0 items-center gap-2">
          {result.httpStatus !== null ? (
            <span className="text-2xs text-muted-foreground">
              HTTP {result.httpStatus}
            </span>
          ) : null}
          <span className="text-2xs text-muted-foreground">
            {formatDuration(result.durationMs)}
          </span>
        </div>
      </div>

      {result.bridgeVersion || result.bridgeOk !== null ? (
        <p className="mt-0.5 text-2xs text-muted-foreground">
          bridge: {result.bridgeVersion ?? "not detected"}
          {result.bridgeOk === false ? " (unhealthy)" : ""}
        </p>
      ) : null}

      <div className="mt-1 space-y-1">
        {result.error ? (
          <p className="text-2xs text-destructive">{result.error}</p>
        ) : null}

        {visibleConsole.length > 0 && (
          <div>
            <p className="text-2xs font-normal text-muted-foreground">
              Console errors
            </p>
            <ul className="mt-0.5 space-y-0.5">
              {visibleConsole.map((msg, i) => (
                <li
                  key={i}
                  className="truncate font-mono text-code text-destructive"
                  title={msg}
                >
                  {msg}
                </li>
              ))}
              {extraConsole > 0 && (
                <li className="text-2xs text-muted-foreground">
                  +{extraConsole} more
                </li>
              )}
            </ul>
          </div>
        )}

        {visiblePage.length > 0 && (
          <div>
            <p className="text-2xs font-normal text-muted-foreground">
              Page errors
            </p>
            <ul className="mt-0.5 space-y-0.5">
              {visiblePage.map((msg, i) => (
                <li
                  key={i}
                  className="truncate font-mono text-code text-destructive"
                  title={msg}
                >
                  {msg}
                </li>
              ))}
              {extraPage > 0 && (
                <li className="text-2xs text-muted-foreground">
                  +{extraPage} more
                </li>
              )}
            </ul>
          </div>
        )}

        {visibleRequests.length > 0 && (
          <div>
            <p className="text-2xs font-normal text-muted-foreground">
              Failed requests
            </p>
            <ul className="mt-0.5 space-y-0.5">
              {visibleRequests.map((req, i) => (
                <li
                  key={i}
                  className="truncate font-mono text-code text-destructive"
                  title={req.url}
                >
                  {req.status !== null ? `${req.status} ` : ""}
                  {req.failure ?? "failed"}: {req.url}
                </li>
              ))}
              {extraRequests > 0 && (
                <li className="text-2xs text-muted-foreground">
                  +{extraRequests} more
                </li>
              )}
            </ul>
          </div>
        )}

        {result.screenshotPath ? (
          <p
            className="truncate font-mono text-code text-muted-foreground"
            title={result.screenshotPath}
          >
            screenshot: {result.screenshotPath.split("/").pop()}
          </p>
        ) : null}
      </div>
    </li>
  )
}

/** Failing-routes dialog, opened when a smoke run reports failures. */
export function SmokeTestFailureDialog({
  report,
  onClose,
}: {
  report: SmokeReport | null
  onClose: () => void
}) {
  const failingRoutes = report?.routes.filter((r) => !r.ok) ?? []
  return (
    <Dialog
      open={report !== null}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent
        size="2xl"
        className="gap-0 overflow-hidden p-0"
        data-testid="smoke-test-failure-dialog"
      >
        <DialogHeader className="border-b px-4 py-3">
          {/*
            Same failure treatment as the save dialog: destructive icon, and the
            title in the same colour rather than leaving the red to the error
            lines further down. This is the only other error modal, and it had
            neither.
          */}
          {/*
            No icon beside a title that is already `text-destructive`, above
            error lines that are already red — three reds for one fact. Same
            call as `save-progress-dialog`'s PhaseIcon: the coloured heading is
            the one that scales, because it carries the state in the thing the
            user reads rather than in a 16px glyph beside it.
          */}
          <DialogTitle className="text-lg text-destructive">
            {failingRoutes.length} of {report?.routes.length ?? 0} routes failed
          </DialogTitle>
          <DialogDescription>
            Routes that didn&apos;t load cleanly against the served prototype
            {report ? ` · ${formatDuration(report.durationMs)}` : ""}.
          </DialogDescription>
        </DialogHeader>
        <ul className="max-h-[60vh] overflow-auto" data-testid="smoke-test-failures">
          {failingRoutes.map((r) => (
            <RouteDetailRow key={r.route} result={r} />
          ))}
        </ul>
        {/*
          An explicit Close. The header `X` alone is a 16px glyph in a corner
          and the last thing in the reading order. See docs/design.md
          § "Every modal can be dismissed".
        */}
        {/*
          `px-4 py-3` and a top border, matching the header exactly.

          This `DialogContent` is `p-0` — deliberately, so the header and the
          route list can run full-bleed and own their own padding — which means
          a bare `DialogFooter` inherits ZERO padding and the button ends up
          jammed into the corner. A footer added to a `p-0` dialog has to bring
          its own.
        */}
        <DialogFooter className="border-t px-4 py-3">
          <DialogClose asChild>
            <Button variant="outline">Close</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
