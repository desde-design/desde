"use client"

/**
 * The launcher's settings gear — editor-level settings, the ones that belong
 * to the person and the machine rather than to a project.
 *
 * It replaces `DesktopUpdateNavButton` (Mo, 2026-08-18: "the update menu is a
 * footer with the same menu as the settings menu at the top of the project.
 * Instead it should be part of the settings menu for both the Editor and
 * Project level"). A standalone download button existed only because the
 * launcher had no gear to fold updates into; this is that gear.
 *
 * ## What is here, and what deliberately is not
 *
 * AI provider keys are machine-level — one key per provider, every project —
 * so they belong here and not only behind an open project. Same for updates.
 *
 * Extensions are NOT here, and that is a fact about where they live rather
 * than an omission: enabling one writes `.mcp.json` inside a repo, and on the
 * launcher there is no repo to write to. The friction Mo named — re-entering
 * the Figma key in every project — is gone anyway, because the KEY is stored
 * per-machine (`extension-secret-store.ts`) even though the enablement is per
 * project.
 *
 * ## It mirrors `EditorSettingsMenu` rather than sharing code with it
 *
 * The two menus have the same trigger and one overlapping item, and the pull
 * to extract a shared component is strong. It is resisted because they differ
 * in the part that matters: the project menu must route a restart through a
 * confirm dialog when a chat turn is streaming, and the launcher has no chat,
 * so restart goes straight through. A shared component would carry the
 * streaming concern into a surface that has no concept of it.
 */

import { useCallback, useState } from "react"
import { KeyRound, SlidersHorizontal } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  DesktopUpdateCheckDialog,
  DesktopUpdateSection,
} from "@/components/editor/desktop-update-menu"
import { SettingsStatusDot } from "@/components/editor/settings-status-dot"
import { LlmCredentialDialog } from "@/components/editor/llm-credential-dialog"
import { everyProviderUncredentialed, useLlmCredentials } from "@/hooks/useLlmCredentials"
import { useFirstRunCredentialPrompt } from "@/hooks/useFirstRunCredentialPrompt"
import type { DesktopUpdatesApi } from "@/hooks/useDesktopUpdates"
import { cn } from "@/lib/utils"

export function LauncherSettingsMenu({ updates }: { updates: DesktopUpdatesApi | undefined }) {
  const credentials = useLlmCredentials()
  const [credentialDialogManuallyOpen, setCredentialDialogManuallyOpen] =
    useState(false)
  // Owned here, not in `DesktopUpdateSection`: the dropdown closes on
  // select, so a dialog rendered inside it would unmount with the menu.
  const [checkDialogOpen, setCheckDialogOpen] = useState(false)

  const status = credentials.status
  const credentialMissing = everyProviderUncredentialed(status)
  // The Launcher showed only a passive "Not set" badge, so a brand-new user's
  // FIRST screen never asked for a key. Someone with nothing configured should
  // be asked before they open a project, not after.
  const { shouldPrompt: credentialPrompt, dismiss: dismissCredentialPrompt } =
    useFirstRunCredentialPrompt(status, credentials.dismissPrompt)
  const credentialDialogOpen = credentialDialogManuallyOpen || credentialPrompt

  const handleCredentialDialogChange = useCallback(
    (open: boolean) => {
      setCredentialDialogManuallyOpen(open)
      // Closing the auto-opened prompt IS the dismissal, or it reopens
      // immediately while no credential exists.
      if (!open && credentialPrompt) dismissCredentialPrompt()
    },
    [credentialPrompt, dismissCredentialPrompt],
  )
  // Same rule as the project gear: an actionable update makes the button say
  // its own name, because it is the one thing behind here worth interrupting
  // for. Downloading and error keep the quiet dot — progress and problems are
  // not a call to act.
  const updateReady =
    updates?.state.phase === "available" || updates?.state.phase === "ready"

  const handleRestartClick = useCallback(() => {
    // Straight through. The launcher has no chat turn to interrupt, which is
    // the only reason the project menu confirms first. The dialog opens to
    // show "Restarting to update" until the window closes.
    setCheckDialogOpen(true)
    updates?.restartAndInstall()
  }, [updates])

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant={updateReady ? "outline" : "ghost"}
            size={updateReady ? "sm" : "icon-sm"}
            className={cn(updates || credentialMissing ? "relative" : undefined)}
            title="Settings"
            aria-label="Settings"
            data-testid="launcher-settings"
          >
            {/* `SlidersHorizontal`, matching the Viewer's settings control
                (`viewer/app/account-menu.tsx`) — Mo, 2026-09-02: "The Editor is
                using a different settings icon (gear) it should match the
                viewer settings icon". It was lucide's `Settings` gear. Two
                surfaces of one product opening the same kind of panel behind
                two different glyphs is the drift the shared `blocks/` layer
                exists to prevent; this one just never went through it. */}
            <SlidersHorizontal />
            {updateReady ? "Update" : null}
            {/* ONE dot, top-right — see `settings-status-dot.tsx`. Replaces
                an update badge at the top-right plus a credential marker at
                the bottom-right, which could not be told apart on a 24px
                glyph. Suppressed once the word "Update" is showing. */}
            {!updateReady ? (
              <SettingsStatusDot
                state={updates?.state}
                credentialMissing={credentialMissing}
                credentialTestId="launcher-settings-credential-marker"
              />
            ) : null}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          {/* Renders nothing, separator included, when there is no desktop
              bridge — so a plain browser tab gets a menu of one item rather
              than a leading rule with nothing above it. */}
          <DesktopUpdateSection
            updates={updates}
            onRestartClick={handleRestartClick}
            onCheckClick={() => setCheckDialogOpen(true)}
          />
          <DropdownMenuItem
            onSelect={() => setCredentialDialogManuallyOpen(true)}
            data-testid="launcher-settings-api-key"
          >
            <KeyRound className="h-4 w-4" />
            AI provider keys
            {credentialMissing ? (
              <span className="ml-auto text-2xs text-muted-foreground">Not set</span>
            ) : null}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <DesktopUpdateCheckDialog
        open={checkDialogOpen}
        onOpenChange={setCheckDialogOpen}
        updates={updates}
        onRestartClick={handleRestartClick}
      />
      <LlmCredentialDialog
        open={credentialDialogOpen}
        onOpenChange={handleCredentialDialogChange}
        credentials={credentials}
      />
    </>
  )
}
