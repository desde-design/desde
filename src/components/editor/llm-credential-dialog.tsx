"use client"

/**
 * The Anthropic credential dialog. Doubles as the first-run prompt and the
 * settings surface, because they ask for the same thing.
 *
 * Hosts the hidden dev-mode toggle. See
 * `docs/superpowers/specs/2026-08-13-editor-llm-credentials-design.md` §6.
 *
 * Section budget (frontend-ui §1b2): the header carries ALL prose, including
 * the environment-managed explanation, the dev-mode notice and any error, so
 * the worst reachable state is two sections — header plus the dev-mode row.
 * An earlier draft had those three as separate Callouts and blew the budget.
 */

import { useCallback, useRef, useState } from "react"
import { Field } from "@/components/blocks/field"
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
import { Switch } from "@/components/ui/switch"
import type { UseLlmCredentials } from "@/hooks/useLlmCredentials"

/**
 * Ctrl+? reveals the dev-mode toggle.
 *
 * Matches on `key` first, never `code` alone: `?` sits on different physical
 * keys across layouts, and `key` reports the character the layout actually
 * produced.
 *
 * The `code === "Slash"` fallback exists because macOS does NOT report `?`
 * here. Measured in the desktop app 2026-09-02: Ctrl+Shift+/ on a US layout
 * arrives as `key: "/"`, `code: "Slash"`, ctrl and shift both true. Chromium
 * recomputes the key value without Control and the result is the unshifted
 * character. So on macOS the `key` branch never fired and the toggle was
 * unreachable. The fallback still requires Shift, so plain Ctrl+/ stays inert.
 *
 * Ctrl ONLY. `Cmd+Shift+/` is the macOS Help-menu search shortcut and macOS is
 * the primary platform, so accepting `metaKey` would collide with the OS.
 * Requiring a control modifier also means the browser inserts no character,
 * which is why this can safely listen while the key input has focus. The
 * earlier bare-`?` design had to exclude focused inputs and force the user to
 * click the dialog body first.
 */
export function shouldRevealDevMode(
  event: Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "shiftKey" | "metaKey">,
): boolean {
  if (!event.ctrlKey || event.metaKey) return false
  if (event.key === "?") return true
  return event.shiftKey && event.code === "Slash"
}

export interface LlmCredentialDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /**
   * Credential state, owned by the CALLER.
   *
   * The dialog deliberately does not call `useLlmCredentials` itself. When it
   * did, the settings menu held a second, independent instance: saving a key
   * here updated only the dialog, so the gear's "no credential" marker stayed
   * lit until a page reload (and stayed dark after a removal). One owner, one
   * status.
   */
  credentials: UseLlmCredentials
}

export function LlmCredentialDialog({
  open,
  onOpenChange,
  credentials,
}: LlmCredentialDialogProps) {
  const { status, error, saveKey, removeKey, setDevMode } = credentials
  const [draft, setDraft] = useState("")
  const [revealed, setRevealed] = useState(false)
  const [busy, setBusy] = useState(false)
  /**
   * Bumped on every close. A save that resolves after the user closed and
   * reopened the dialog would otherwise close the NEW instance and, via
   * `handleOpenChange`, wipe the key they had just started typing into it.
   */
  const openGeneration = useRef(0)

  const devMode = status?.devMode ?? false
  const source = status?.source ?? "none"
  const envManaged = source === "env"
  const toggleVisible = devMode || revealed
  // Keyed off the STORE, not the active source. In dev mode `source` is
  // `subscription` even with a key stored behind it, and gating on the source
  // stranded that key: it could be neither seen nor removed until dev mode
  // was switched off. Spec §5 requires management to stay available.
  const hasStoredKey = status?.hasStoredKey ?? false
  const storedHint = status?.storedHint

  /**
   * Closing resets the easter egg, so a reveal never survives into the next
   * time the dialog is opened. Done here rather than in an effect on `open`:
   * a synchronous setState in an effect body is a cascading render, which
   * `react-hooks/set-state-in-effect` rejects.
   */
  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) {
        openGeneration.current += 1
        setRevealed(false)
        // Drop any unsaved key. The dialog stays MOUNTED between opens, so
        // without this a pasted secret survives Close, Escape and a backdrop
        // click, and reappears in the field next time it is opened.
        setDraft("")
      }
      onOpenChange(next)
    },
    [onOpenChange],
  )

  const handleKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (!shouldRevealDevMode(event.nativeEvent)) return
    event.preventDefault()
    setRevealed(true)
  }, [])

  const handleSave = useCallback(async () => {
    const generation = openGeneration.current
    setBusy(true)
    const ok = await saveKey(draft)
    setBusy(false)
    // Only close the instance that started this save. Validation is a network
    // round-trip, and Close, Escape and the backdrop all stay live during it.
    if (ok && openGeneration.current === generation) handleOpenChange(false)
  }, [draft, saveKey, handleOpenChange])

  const handleRemove = useCallback(async () => {
    setBusy(true)
    await removeKey()
    setBusy(false)
  }, [removeKey])

  const handleDevModeChange = useCallback(
    async (value: boolean) => {
      setBusy(true)
      await setDevMode(value)
      setBusy(false)
      // Turning it off clears the reveal, so the toggle hides again.
      if (!value) setRevealed(false)
    },
    [setDevMode],
  )

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {/* The listener is scoped to the dialog, not the document, so the
          easter egg can only fire while this form is open. */}
      <DialogContent size="md" onKeyDown={handleKeyDown}>
        <DialogHeader>
          <DialogTitle>Anthropic API key</DialogTitle>
          <DialogDescription>
            Chat and the other AI features need this key. Everything else,
            including the inspector, layers and direct edits, works without one.
            {envManaged ? (
              <>
                {" "}
                A key is already set by the{" "}
                <span className="font-mono text-code-lg">ANTHROPIC_API_KEY</span>{" "}
                environment variable
                {status?.maskedHint ? (
                  <>
                    {" ("}
                    <span className="font-mono text-code-lg">{status.maskedHint}</span>
                    {")"}
                  </>
                ) : null}
                . It cannot be changed from here, so unset the variable to manage
                a key in the app.
              </>
            ) : null}
            {devMode ? (
              <>
                {" "}
                Dev mode is on, so the Claude subscription is used and any API
                key is ignored. Subprocesses will not see{" "}
                <span className="font-mono text-code-lg">ANTHROPIC_API_KEY</span>{" "}
                while it is on.
              </>
            ) : null}
            {error ? (
              // DialogDescription is announced on open, not on change, so an
              // error raised in an already-open dialog needs its own live
              // region or it goes silent for screen readers.
              <span role="status" className="text-destructive">
                {" "}
                {error}
              </span>
            ) : null}
          </DialogDescription>
        </DialogHeader>

        {envManaged ? null : (
          <Field
            label={hasStoredKey ? "Replace key" : "API key"}
            htmlFor="llm-api-key"
            hint={
              storedHint
                ? devMode
                  ? `Stored key ${storedHint}, unused while dev mode is on.`
                  : `Currently using ${storedHint}.`
                : undefined
            }
          >
            <Input
              id="llm-api-key"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="sk-ant-..."
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
          </Field>
        )}

        {/* Conditionally rendered, not CSS-hidden. A `hidden` class would
            leave the control in the DOM for anyone who opens the inspector,
            which defeats the point of an easter egg. */}
        {toggleVisible ? (
          <div className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
            {/*
              Label only, no description. This toggle is reached by an easter
              egg (see the `toggleVisible` comment above), and a hidden feature
              that explains itself in the UI is documented after all. Anyone who
              found it already knows what it does.
            */}
            <span className="text-base font-medium">Dev mode</span>
            <Switch
              checked={devMode}
              disabled={busy}
              onCheckedChange={handleDevModeChange}
              aria-label="Dev mode"
            />
          </div>
        ) : null}

        <DialogFooter>
          {hasStoredKey && !envManaged ? (
            <Button variant="ghost" disabled={busy} onClick={() => void handleRemove()}>
              Remove key
            </Button>
          ) : null}
          <Button
            variant="outline"
            data-testid="llm-credential-close"
            onClick={() => handleOpenChange(false)}
          >
            Close
          </Button>
          {envManaged ? null : (
            <Button
              disabled={busy || draft.trim().length === 0}
              onClick={() => void handleSave()}
            >
              {busy ? "Checking" : "Save key"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
