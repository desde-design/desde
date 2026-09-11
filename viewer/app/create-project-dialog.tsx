"use client"

import { useState } from "react"
import { Callout, Field } from "@/components/blocks"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"

export interface CreateProjectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /**
   * Called with the created project once the server returns 201. The
   * dashboard uses it to reload the list and hand the new project straight
   * to the repo-connect wizard.
   */
  onCreated: (project: { id: string; slug: string; name: string }) => void
}

/**
 * New project — a name, and nothing else.
 *
 * A dialog rather than the Editor's full-page stepper, because the two flows
 * are not the same size. The Editor's has four steps of real content (source,
 * name, design systems, reference folders); the Viewer's create API takes a
 * name, so a stepper here would be one step wearing a costume.
 *
 * There is no URL field (Mo, 2026-09-10: "generate it automatically, opaque
 * to the user"). The server derives the slug from the name and suffixes it
 * when the name is already taken, so nothing about the URL is the user's
 * problem. Until then the dialog showed a second field that tracked the name
 * and could be edited by hand; nobody needed to.
 *
 * No placeholder text in the field either (Mo, same day: "it isn't
 * helpful"). The label says what goes there.
 *
 * The server's 400 and 403 bodies are shown verbatim rather than re-phrased,
 * so a rule that changes server-side reaches the user without this file
 * being touched.
 */
export function CreateProjectDialog({ open, onOpenChange, onCreated }: CreateProjectDialogProps) {
  const [name, setName] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const trimmedName = name.trim()
  const canSubmit = trimmedName.length > 0 && !busy

  function reset() {
    setName("")
    setBusy(false)
    setError(null)
  }

  function handleOpenChange(next: boolean) {
    // Reset on CLOSE, not on open. Resetting on open would wipe a draft the
    // moment a re-render flipped `open` back to true for any reason; closing
    // is the only unambiguous "this attempt is over" signal.
    if (!next) reset()
    onOpenChange(next)
  }

  async function handleSubmit() {
    if (!canSubmit) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch("/api/v1/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmedName }),
      })
      if (!res.ok) {
        // The server's own wording, not a re-phrasing of it. Only a response
        // with no usable body needs us to invent anything.
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        setError(body?.error ?? "Couldn't create the project. Try again.")
        setBusy(false)
        return
      }
      const project = (await res.json()) as { id: string; slug: string; name: string }
      reset()
      onCreated(project)
    } catch {
      setError("Couldn't reach the server. Check your connection and try again.")
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {/* No `X` while the create is in flight. Mo, 2026-08-28. */}
      <DialogContent showCloseButton={!busy}>
        <DialogHeader>
          {/* "Add project" on BOTH steps of the wizard — this dialog and
              the connect-a-repository step that follows it — so the flow reads
              as one thing, and it matches the dashboard button that opened it
              (Mo, 2026-08-29). */}
          <DialogTitle>Add project</DialogTitle>
          <DialogDescription>Give it a name. You can connect a repository next.</DialogDescription>
        </DialogHeader>

        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            // One field, so Enter submits, the way a one-field form should.
            e.preventDefault()
            void handleSubmit()
          }}
        >
          <Field label="Project name" htmlFor="new-project-name">
            <Input
              id="new-project-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              disabled={busy}
              data-testid="new-project-name"
            />
          </Field>

          {error ? (
            <Callout tone="destructive" data-testid="new-project-error">
              {error}
            </Callout>
          ) : null}
        </form>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          {/* `busy` for the spinner — see `Button`'s own doc on why a
              swapped label alone reads as "unavailable" rather than "running".
              This dialog shows no other progress. */}
          <Button
            onClick={() => void handleSubmit()}
            disabled={!canSubmit}
            busy={busy}
            data-testid="new-project-submit"
          >
            {/* "Add", not "Add project": the dialog title directly above
                already says it. docs/design.md, "Don't repeat the noun the
                surface already carries". */}
            {busy ? "Adding" : "Add"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
