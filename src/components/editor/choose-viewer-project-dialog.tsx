"use client"

/**
 * Which prototype on the viewer is this repo?
 *
 * Opens only when the Editor genuinely cannot answer: several prototypes on
 * the viewer are connected to this repo, so adopting one would put comments
 * somewhere nobody chose. A single match is adopted silently and never shows
 * this dialog, which is why it interrupts so rarely.
 *
 * Comments stay on this machine while it is open and after it is dismissed.
 * That is not this component's doing — `effectiveViewerConfig` yields no link
 * for an ambiguous resolution — but it is what the copy promises, so the two
 * have to stay in step.
 *
 * Linking writes the committed link, the same one the manual Connect dialog
 * writes. So the question is answered once, for everyone who clones the repo,
 * and later boots short-circuit resolution entirely.
 *
 * "Keep comments local" never returns on its own. The label says so rather
 * than reading "Not now", and the manual Connect dialog is the way back.
 * Escape and a click outside are deliberately NOT that: they close for this
 * viewer and record nothing, because only the button states the consequence.
 */

import { useCallback, useMemo, useState } from "react"
import { toast } from "sonner"
import { OptionCard, OptionCardGroup } from "@/components/blocks"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogCopy,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { editorFetch } from "@/lib/editor-fetch"
import { formatRelativeTime } from "@/lib/relative-time"
import { linkProjectOnDisk } from "@/services/editor-project-link"
import type { ViewerAuthStatus, ViewerCandidate } from "@/hooks/useViewerAuthStatus"

export interface ChooseViewerProjectDialogProps {
  status: ViewerAuthStatus | null
  /** Re-probe after a successful link, so the rest of the UI catches up. */
  onLinked: () => void
}

/** The one line under a candidate's name. */
function describe(candidate: ViewerCandidate): string {
  const parts: string[] = []
  // Empty on a viewer too old to report it. Omitted rather than shown blank.
  if (candidate.branch) parts.push(`Builds ${candidate.branch}`)
  parts.push(
    candidate.lastBuiltAt
      ? `Last built ${formatRelativeTime(candidate.lastBuiltAt)}`
      : "Never built",
  )
  return parts.join(" · ")
}

export function ChooseViewerProjectDialog({
  status,
  onLinked,
}: ChooseViewerProjectDialogProps) {
  const [chosen, setChosen] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /**
   * Which viewer origin this dialog has been closed FOR, rather than a bare
   * boolean.
   *
   * Closing is tracked locally so both buttons shut the dialog at once,
   * without waiting for a round-trip and a re-probe. A boolean made that
   * suppression permanent for the session: pointing the Editor at a different
   * viewer produces a fresh ambiguous link with `matchDismissed: false`, and
   * the flag still hid it until a reload (codex P2). The server scopes
   * dismissals per origin; this has to agree, or the local echo outlives the
   * thing it was echoing.
   */
  const [closedForOrigin, setClosedForOrigin] = useState<string | null>(null)

  const link = status?.link
  const open = useMemo(() => {
    if (!status) return false
    // A committed link outranks any resolution, so there is nothing to ask.
    if (status.source !== null) return false
    if (status.matchDismissed) return false
    if (link?.status !== "ambiguous") return false
    return closedForOrigin !== link.origin
  }, [closedForOrigin, status, link])

  // Memoized (not a plain conditional) because it feeds `link_`'s dependency
  // array below: a fresh empty array on every non-ambiguous render would
  // otherwise change identity every render and defeat that callback's memo.
  const candidates = useMemo(
    () => (link?.status === "ambiguous" ? link.candidates : []),
    [link],
  )
  const origin = link?.status === "ambiguous" ? link.origin : null

  /**
   * Escape, or a click outside. Closes for this viewer and records NOTHING.
   *
   * Only the button makes it permanent, because only the button says what it
   * does. Escape is a reflex, and wiring it to the same permanent dismissal
   * meant one stray keypress silently stopped comments reaching the viewer
   * with nothing on screen to say so and no obvious way back.
   */
  const closeForNow = useCallback(() => {
    setClosedForOrigin(origin)
  }, [origin])

  const keepLocal = useCallback(() => {
    setClosedForOrigin(origin)
    // Fire and forget. A failed write means the chooser returns next launch,
    // which is the safe failure and must never block closing the dialog.
    void editorFetch("/api/editor/viewer-auth/dismiss-match", { method: "POST" })
  }, [origin])

  const link_ = useCallback(async () => {
    const picked = candidates.find((c) => c.projectId === chosen)
    if (!picked || !origin) return
    setBusy(true)
    setError(null)
    try {
      const result = await linkProjectOnDisk({
        projectId: picked.projectId,
        slug: picked.slug,
        platformBaseUrl: origin,
      })
      if (!result.ok) {
        setError(result.reason ?? "Could not link that prototype.")
        return
      }
      toast.success(`Linked to ${picked.name}`)
      setClosedForOrigin(origin)
      onLinked()
    } finally {
      setBusy(false)
    }
  }, [candidates, chosen, origin, onLinked])

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !busy && closeForNow()}>
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle>Choose a prototype</DialogTitle>
          <DialogCopy
            description="This repo matches more than one prototype on your viewer. Comments stay on this computer until you choose one."
            {...(error ? { issues: [{ key: "link", node: error }] } : {})}
          />
        </DialogHeader>

        <OptionCardGroup
          value={chosen}
          onValueChange={setChosen}
          aria-label="Choose a prototype"
          className="max-h-64 overflow-y-auto"
        >
          {candidates.map((candidate) => (
            <OptionCard
              key={candidate.projectId}
              value={candidate.projectId}
              title={candidate.name}
              hint={describe(candidate)}
              data-testid={`viewer-candidate-${candidate.slug}`}
            />
          ))}
        </OptionCardGroup>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={keepLocal} disabled={busy}>
            Keep comments local
          </Button>
          <Button
            size="sm"
            onClick={() => void link_()}
            disabled={busy || chosen === undefined}
            busy={busy}
          >
            Link
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
