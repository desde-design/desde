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

/**
 * The slug rule, mirrored from the server's `SLUG_PATTERN`
 * (`server/api/projects-routes.ts`): 2-63 characters, lowercase letters,
 * digits and hyphens, starting with a letter or digit.
 *
 * Duplicated deliberately, and it is a duplication with a rule attached: the
 * SERVER is the authority and its 400 is always shown verbatim. This copy
 * exists only so the Create button can be disabled before a round trip that
 * is certain to fail. If the two ever disagree, the server wins and the user
 * sees the server's words — the failure mode of a stale copy here is a
 * button that stays disabled, never a project created with a bad slug.
 */
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/

/**
 * Derives a URL slug from a display name — the same transform the original
 * Desde used: lowercase, runs of anything non-alphanumeric collapse to
 * a single hyphen, and leading/trailing hyphens are trimmed.
 */
export function slugFromName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
}

export interface CreateProjectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** `VIEWER_PUBLIC_URL` — used only to show the URL the slug will produce. */
  publicUrl: string
  /**
   * Called with the created project once the server returns 201. The
   * dashboard uses it to reload the list and hand the new project straight
   * to the repo-connect wizard.
   */
  onCreated: (project: { id: string; slug: string; name: string }) => void
}

/**
 * New project — name and URL slug, and nothing else.
 *
 * A dialog rather than the Editor's full-page stepper, because the two flows
 * are not the same size. The Editor's has four steps of real content (source,
 * name, design systems, reference folders); the Viewer's create API takes
 * exactly `{ slug, name }`, so a stepper here would be one step wearing a
 * costume. This matches the original Desde' own create dialog.
 *
 * The slug tracks the name until the moment the user edits the slug
 * themselves, and then stops forever. That "stops forever" is the part worth
 * keeping: a slug that quietly re-derives after a manual edit throws away
 * work the user did on purpose, and they will not notice until the URL is
 * already live.
 *
 * The server is the only authority on whether a slug is acceptable. Its 400
 * and 409 bodies are shown verbatim rather than re-phrased, so a rule that
 * changes server-side reaches the user without this file being touched.
 */
export function CreateProjectDialog({
  open,
  onOpenChange,
  publicUrl,
  onCreated,
}: CreateProjectDialogProps) {
  const [name, setName] = useState("")
  const [slug, setSlug] = useState("")
  const [slugEdited, setSlugEdited] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const trimmedName = name.trim()
  const slugValid = SLUG_PATTERN.test(slug)
  const canSubmit = trimmedName.length > 0 && slugValid && !busy

  function reset() {
    setName("")
    setSlug("")
    setSlugEdited(false)
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

  function handleNameChange(value: string) {
    setName(value)
    if (!slugEdited) setSlug(slugFromName(value))
  }

  async function handleSubmit() {
    if (!canSubmit) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch("/api/v1/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, name: trimmedName }),
      })
      if (!res.ok) {
        // The server's own wording, not a re-phrasing of it. A 409 already
        // says the slug is taken; a 400 already names the rule that was
        // broken. Only a response with no usable body needs us to invent
        // anything.
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
          <DialogDescription>
            Give it a name and a URL. You can connect a repository next.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <Field label="Project name" htmlFor="new-project-name">
            <Input
              id="new-project-name"
              value={name}
              onChange={(e) => handleNameChange(e.target.value)}
              placeholder="Checkout redesign"
              autoFocus
              disabled={busy}
              data-testid="new-project-name"
            />
          </Field>

          <Field
            label="URL"
            htmlFor="new-project-slug"
            hint={
              slug
                ? `Served at ${publicUrl.replace(/\/$/, "")}/p/${slug}/`
                : "Lowercase letters, digits and hyphens."
            }
            /* Only complain once there is something to complain ABOUT. An
               empty field is incomplete, not wrong, and reddening it before
               the user has typed reads as an accusation. */
            error={
              slug.length > 0 && !slugValid
                ? "Use 2-63 lowercase letters, digits or hyphens, starting with a letter or digit."
                : undefined
            }
          >
            <Input
              id="new-project-slug"
              value={slug}
              onChange={(e) => {
                setSlug(e.target.value)
                setSlugEdited(true)
              }}
              placeholder="checkout-redesign"
              disabled={busy}
              /* Not mono (Mo, 2026-08-29). docs/design.md puts paths and
                 routes in mono, but the rule's other half decides this one:
                 "text the user typed: the UI font". This is a field being
                 typed into, not a value being read back, and mono here made
                 the slug look like output rather than input. Where it IS
                 shown back — the "Served at …/p/<slug>/" hint below — it can
                 stay a path. */
              data-testid="new-project-slug"
            />
          </Field>

          {error ? (
            <Callout tone="destructive" data-testid="new-project-error">
              {error}
            </Callout>
          ) : null}
        </div>

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
