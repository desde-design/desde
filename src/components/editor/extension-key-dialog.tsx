"use client"

/**
 * The form that supplies an extension's API key.
 *
 * Before this existed the panel printed `export FIGMA_API_KEY=…` and told the
 * user to restart. That is not a setting a designer who opened a folder in a
 * window can reach (Mo, 2026-08-18: "there should be no text that refers to
 * env, or variables — every major setting that a user needs to set should be
 * available in the GUI").
 *
 * Section budget (frontend-ui §1b2): header plus one field. Where the key
 * comes from lives in the header prose rather than in a Callout of its own,
 * and the environment-managed warning replaces that prose instead of stacking
 * under it.
 *
 * Deliberately NOT a general secrets manager. The server accepts only names a
 * catalog entry declares, so this form can offer only the key the extension in
 * front of the user actually asks for.
 */

import { useCallback, useRef, useState } from "react"
import { Field } from "@/components/blocks/field"
import { Callout } from "@/components/blocks/callout"
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

/** Where to get the key, per extension. Absent ⇒ no pointer is shown. */
const KEY_SOURCE: Record<string, { what: string; where: string }> = {
  FIGMA_API_KEY: {
    what: "a Figma personal access token",
    where:
      "In Figma, open your account menu, then Settings, then Security. Under Personal access tokens, generate one with read access to file content. Copy it now: Figma shows it once.",
  },
}

export interface ExtensionKeyDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The extension asking for it, for the title. */
  label: string
  /** The name the server stores it under. Never shown to the reader. */
  name: string
  /** A key is already saved here, so Remove is a real action. */
  stored: boolean
  /** A key is set outside the app and would win over anything saved here. */
  fromEnvironment: boolean
  onSave: (name: string, value: string | null) => Promise<{ ok: boolean; reason?: string }>
}

export function ExtensionKeyDialog({
  open,
  onOpenChange,
  label,
  name,
  stored,
  fromEnvironment,
  onSave,
}: ExtensionKeyDialogProps) {
  const [draft, setDraft] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /**
   * Bumped on every close, so a save that resolves after the dialog was
   * dismissed cannot reach in and close a later opening of it. Same guard the
   * Anthropic key dialog carries, and for the same reason: the round-trip
   * stays live while Escape, Close and the backdrop all do.
   */
  const openGeneration = useRef(0)

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) {
        openGeneration.current += 1
        // The dialog stays MOUNTED between opens. Without this a pasted
        // secret survives Close and reappears in the field next time.
        setDraft("")
        setError(null)
      }
      onOpenChange(next)
    },
    [onOpenChange],
  )

  const run = useCallback(
    async (value: string | null) => {
      const generation = openGeneration.current
      setBusy(true)
      setError(null)
      const result = await onSave(name, value)
      setBusy(false)
      if (!result.ok) {
        setError(result.reason ?? "That key couldn't be saved.")
        return
      }
      if (openGeneration.current === generation) handleOpenChange(false)
    },
    [name, onSave, handleOpenChange],
  )

  const source = KEY_SOURCE[name]

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>{label} API key</DialogTitle>
          <DialogDescription>
            {fromEnvironment ? (
              <>
                A key is already set outside this app and it takes precedence,
                so nothing saved here would be used. Clear the one set outside
                to manage this key in the app.
              </>
            ) : (
              <>
                {label} needs {source?.what ?? "an API key"} to read your files.
                It is stored on this computer only, and it is never sent
                anywhere except to {label}.{" "}
                {stored ? "A key is already saved. Entering another replaces it." : null}
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        {error ? (
          <Callout tone="destructive" role="alert">
            {error}
          </Callout>
        ) : null}

        {fromEnvironment ? null : (
          <Field
            label={stored ? "New key" : "Key"}
            htmlFor="extension-key"
            hint={source?.where}
          >
            <Input
              id="extension-key"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={draft}
              disabled={busy}
              onChange={(e) => setDraft(e.target.value)}
              data-testid="extension-key-input"
            />
          </Field>
        )}

        <DialogFooter>
          {stored ? (
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => void run(null)}
              data-testid="extension-key-remove"
            >
              Remove key
            </Button>
          ) : null}
          <Button variant="outline" disabled={busy} onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={busy || fromEnvironment || draft.trim() === ""}
            onClick={() => void run(draft)}
            data-testid="extension-key-save"
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
