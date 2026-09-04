"use client"

/**
 * The AI provider credential dialog. Doubles as the first-run prompt and the
 * settings surface, because they ask for the same thing.
 *
 * One tab per provider the server serves (Task 7). Hosts the hidden dev-mode
 * toggle, scoped to whichever tab's provider has a subscription runtime
 * (Anthropic today). See
 * `docs/superpowers/specs/2026-08-13-editor-llm-credentials-design.md` §6,
 * §11.
 *
 * Section budget (frontend-ui §1b2): the header carries ALL prose, including
 * the environment-managed explanation, the dev-mode notice and any error, so
 * the worst reachable state is two sections — header plus the dev-mode row.
 * The tab strip is part of the header region, not a third section.
 */

import { useCallback, useMemo, useRef, useState } from "react"
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"
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
  const providers = useMemo(() => Object.values(status?.providers ?? {}), [status])
  const [activeId, setActiveId] = useState<string | null>(null)
  const active = providers.find((p) => p.id === activeId) ?? providers[0]
  // Per provider, so switching tabs cannot carry one vendor's key into
  // another's field, and so an unsaved draft survives a look at the other tab.
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [baseUrlDrafts, setBaseUrlDrafts] = useState<Record<string, string>>({})
  const draft = active ? (drafts[active.id] ?? "") : ""
  const [revealed, setRevealed] = useState(false)
  const [busy, setBusy] = useState(false)
  /**
   * Bumped on every close. A save that resolves after the user closed and
   * reopened the dialog would otherwise close the NEW instance and, via
   * `handleOpenChange`, wipe the key they had just started typing into it.
   */
  const openGeneration = useRef(0)

  const devMode = status?.devMode ?? false
  const source = active?.source ?? "none"
  const envManaged = source === "env"
  const toggleVisible = (devMode || revealed) && (active?.hasSubscriptionRuntime ?? false)
  // Keyed off the STORE, not the active source. In dev mode `source` is
  // `subscription` even with a key stored behind it, and gating on the source
  // stranded that key: it could be neither seen nor removed until dev mode
  // was switched off. Spec §5 requires management to stay available.
  const hasStoredKey = active?.hasStoredKey ?? false

  /**
   * Closing resets the easter egg and both draft maps, so a reveal or a
   * pasted secret never survives into the next time the dialog is opened.
   * Done here rather than in an effect on `open`: a synchronous setState in
   * an effect body is a cascading render, which
   * `react-hooks/set-state-in-effect` rejects.
   */
  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) {
        openGeneration.current += 1
        setRevealed(false)
        // Drop any unsaved key or base URL. The dialog stays MOUNTED between
        // opens, so without this a pasted secret survives Close, Escape and a
        // backdrop click, and reappears in the field next time it is opened.
        setDrafts({})
        setBaseUrlDrafts({})
      }
      onOpenChange(next)
    },
    [onOpenChange],
  )

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      // Scoped to the tab of a provider that HAS a subscription runtime. Dev
      // mode forces the Claude subscription, so the easter egg appearing over
      // an OpenAI pane would offer a control with no meaning there.
      if (!active?.hasSubscriptionRuntime) return
      if (!shouldRevealDevMode(event.nativeEvent)) return
      event.preventDefault()
      setRevealed(true)
    },
    [active?.hasSubscriptionRuntime],
  )

  const handleSave = useCallback(async () => {
    if (!active) return
    const generation = openGeneration.current
    setBusy(true)
    const ok = await saveKey(active.id, draft, baseUrlDrafts[active.id] || undefined)
    setBusy(false)
    // Only close the instance that started this save. Validation is a network
    // round-trip, and Close, Escape and the backdrop all stay live during it.
    if (ok && openGeneration.current === generation) handleOpenChange(false)
  }, [active, draft, baseUrlDrafts, saveKey, handleOpenChange])

  const handleRemove = useCallback(async () => {
    if (!active) return
    setBusy(true)
    await removeKey(active.id)
    setBusy(false)
  }, [active, removeKey])

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
          <DialogTitle>AI provider keys</DialogTitle>
          <DialogDescription>
            Chat and the other AI features need a key from one of these
            providers. Everything else, including the inspector, layers and
            direct edits, works without one.
            {envManaged ? (
              <>
                {" "}
                A key is already set by the{" "}
                <span className="font-mono text-code-lg">{active?.apiKeyEnvVar}</span>{" "}
                environment variable
                {active?.maskedHint ? (
                  <>
                    {" ("}
                    <span className="font-mono text-code-lg">{active.maskedHint}</span>
                    {")"}
                  </>
                ) : null}
                . It cannot be changed from here, so unset the variable to
                manage a key in the app.
              </>
            ) : null}
            {devMode && active?.hasSubscriptionRuntime ? (
              <>
                {" "}
                Dev mode is on, so the Claude subscription is used and any{" "}
                {active.label} key is ignored. Subprocesses will not see{" "}
                <span className="font-mono text-code-lg">{active.apiKeyEnvVar}</span>{" "}
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

        <Tabs
          value={active?.id ?? ""}
          onValueChange={setActiveId}
          className={cn(providers.length < 2 && "gap-0")}
        >
          <TabsList>
            {providers.map((p) => (
              <TabsTrigger key={p.id} value={p.id} data-testid={`llm-credential-tab-${p.id}`}>
                {p.label}
              </TabsTrigger>
            ))}
          </TabsList>
          {providers.map((p) => (
            <TabsContent key={p.id} value={p.id} className="flex flex-col gap-3">
              {p.source === "env" ? null : (
                <Field
                  label="API key"
                  htmlFor={`llm-api-key-${p.id}`}
                  hint={
                    p.storedHint
                      ? devMode && p.hasSubscriptionRuntime
                        ? `Stored key ${p.storedHint}, unused while dev mode is on.`
                        : `Currently using ${p.storedHint}.`
                      : undefined
                  }
                >
                  <Input
                    id={`llm-api-key-${p.id}`}
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={`${p.maskPrefix}...`}
                    value={drafts[p.id] ?? ""}
                    onChange={(e) =>
                      setDrafts((prev) => ({ ...prev, [p.id]: e.target.value }))
                    }
                  />
                </Field>
              )}
              {p.baseUrlEnvVar ? (
                <Field
                  label="Base URL"
                  htmlFor={`llm-base-url-${p.id}`}
                  hint={`Optional. Point this at an OpenAI-compatible endpoint, or set ${p.baseUrlEnvVar}. Leave it blank for ${p.label}.`}
                >
                  <Input
                    id={`llm-base-url-${p.id}`}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="https://api.openai.com"
                    value={baseUrlDrafts[p.id] ?? p.baseUrl ?? ""}
                    onChange={(e) =>
                      setBaseUrlDrafts((prev) => ({ ...prev, [p.id]: e.target.value }))
                    }
                  />
                </Field>
              ) : null}
              <a
                href={p.consoleUrl}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-muted-foreground underline underline-offset-2"
              >
                Get a {p.label} key
              </a>
            </TabsContent>
          ))}
        </Tabs>

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
