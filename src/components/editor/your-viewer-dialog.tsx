"use client"

import { useCallback, useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogCopy,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldGroup } from "@/components/blocks"
import { Input } from "@/components/ui/input"
import { editorFetch } from "@/lib/editor-fetch"
import type { ViewerLinkState } from "@/hooks/useViewerAuthStatus"

/**
 * "Your viewer" — the machine-level viewer, set once.
 *
 * The point of it (Mo, 2026-08-26): point the Editor at a viewer, and every
 * repo you open afterwards finds its own project by itself. The CLI asks the
 * viewer `POST /api/v1/projects/resolve` with the repo's embedded identity and
 * its git remote; a match links silently.
 *
 * ## Not the same thing as the connect dialog
 *
 * `connect-viewer-dialog.tsx` links THIS repo to a chosen project and writes
 * `platformBaseUrl` + `projectId` into `.desde/config.json`, which is
 * committed and travels to everyone who clones it. This writes nothing to the
 * repo at all: URL and token both live on this machine.
 *
 * A repo that carries a committed link keeps it — the committed answer always
 * wins over what this machine resolved. This fills a gap, it does not override
 * a decision someone made on behalf of the whole team.
 *
 * ## Why it probes before saving
 *
 * The store's own check is a shape check (`dsv_…`), which catches a typo but
 * not a revoked token, a wrong instance, or a URL nothing is serving. Probing
 * first means a wrong value fails HERE, next to the field that is wrong,
 * rather than as a 401 on the next comment fetch — which reads as "the viewer
 * is broken".
 */
export interface YourViewerDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The origin currently set for this machine, if any. */
  defaultOrigin: string | null
  /** What that viewer made of the CURRENT repo — shown so the save has visible consequence. */
  link: ViewerLinkState | null
  onSaved?: () => void
}

export function YourViewerDialog({
  open,
  onOpenChange,
  defaultOrigin,
  link,
  onSaved,
}: YourViewerDialogProps) {
  const [baseUrl, setBaseUrl] = useState(defaultOrigin ?? "")
  const [token, setToken] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const probe = await editorFetch("/api/editor/viewer-auth/probe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseUrl: baseUrl.trim(), token: token.trim() }),
      })
      const probeJson = (await probe.json()) as { ok?: boolean; reason?: string }
      if (!probe.ok || probeJson.ok === false) {
        setError(probeJson.reason ?? "Could not reach that viewer with that token.")
        return
      }
      const stored = await editorFetch("/api/editor/viewer-auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseUrl: baseUrl.trim(), token: token.trim(), makeDefault: true }),
      })
      const storedJson = (await stored.json()) as { ok?: boolean; reason?: string }
      if (!stored.ok || storedJson.ok === false) {
        setError(storedJson.reason ?? "Could not save the viewer.")
        return
      }
      toast.success("Viewer saved")
      onSaved?.()
      onOpenChange(false)
    } catch {
      setError("Could not reach that viewer.")
    } finally {
      setBusy(false)
    }
  }, [baseUrl, token, onSaved, onOpenChange])

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle>Your viewer</DialogTitle>
          <DialogCopy
            description="Projects you open will link themselves to this viewer when it recognises them. This is stored on this computer, not in any repo."
            {...(error ? { issues: [{ key: "save", node: error }] } : {})}
          />
        </DialogHeader>

        <FieldGroup>
          <Field label="Viewer URL" htmlFor="your-viewer-url">
            <Input
              id="your-viewer-url"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://viewer.example.com"
              autoComplete="off"
            />
          </Field>
          <Field
            label="Access token"
            htmlFor="your-viewer-token"
            hint="In the viewer: Settings, then Create token. Tick the write scope, or comments cannot be posted."
          >
            <Input
              id="your-viewer-token"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="dsv_…"
              autoComplete="off"
            />
          </Field>
        </FieldGroup>

        {/* What this viewer made of the repo that is open right now. It is the
            only visible consequence of saving, and without it "Viewer saved"
            is a claim the user has no way to check. */}
        {link ? <LinkSummary link={link} /> : null}

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => void save()}
            disabled={busy || baseUrl.trim() === "" || token.trim() === ""}
            busy={busy}
          >
            {busy ? "Checking" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** One line about the open repo, in the reader's terms. */
function LinkSummary({ link }: { link: ViewerLinkState }) {
  const text = summarize(link)
  if (!text) return null
  return (
    <p role="status" className="text-sm text-muted-foreground">
      {text}
    </p>
  )
}

function summarize(link: ViewerLinkState): string | null {
  switch (link.status) {
    case "linked":
      return `This project is linked to "${link.name}" on your viewer.`
    case "unlinked":
      // Deliberately not an instruction: creating a project from the Editor
      // is not built, so telling someone to do it here would name a control
      // that does not exist.
      return "Your viewer does not have this project yet, so comments stay on this computer."
    case "conflict":
      return link.reason
    case "error":
      return link.reason
    case "no-token":
      return "Your viewer will not accept the saved token. Create a new one and save it here."
    default:
      return null
  }
}

export { summarize as summarizeViewerLink }
