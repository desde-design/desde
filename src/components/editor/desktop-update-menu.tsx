"use client"

/**
 * Desktop auto-update UI — the badge, the settings-menu section, and the
 * launcher's standalone nav button. All of it is built on
 * `useDesktopUpdates()` (`src/hooks/useDesktopUpdates.ts`), which returns
 * `undefined` in a plain browser tab, so every piece here is written to
 * accept `undefined` and render nothing rather than being gated by a
 * separate flag.
 *
 * Placement (`tasks/electron-app.md` §4 "UI placement"):
 *  - `DesktopUpdateBadge` — a small dot on the existing settings gear
 *    (`EditorSettingsMenu`) and on the launcher's (`LauncherSettingsMenu`),
 *    following VS Code's gear badge / Slack's Help badge.
 *  - `DesktopUpdateSection` — the top section inside `EditorSettingsMenu`'s
 *    dropdown: a phase-specific status row, then the "Download updates
 *    automatically" toggle, then "Check for updates" (`DesktopUpdateCheckNowItem`
 *    — the on-demand third trigger alongside boot + the 4h timer). Composed
 *    into `EditorSettingsMenu` directly rather than living in its own dialog
 *    — updates aren't a daily surface, same reasoning `editor-settings-menu.tsx`
 *    already gives for keeping config-adjacent chrome behind the gear.
 *  - There is no launcher-specific button here any more. It existed because
 *    the launcher had no settings gear to attach a badge to; the launcher
 *    grew one on 2026-08-18 (`LauncherSettingsMenu`) and folds updates in
 *    through `DesktopUpdateSection`, exactly as the project menu does.
 *
 * Copy follows the frontend-ui skill's house style (sentences, no em dashes,
 * no trailing ellipsis) rather than `tasks/electron-app.md` §4's literal
 * example strings ("Update available — Download", "Downloading… 43%") —
 * the plan names the STATES, this is the wording for them.
 */

import { Download, Loader2, RefreshCw, RotateCw, CircleAlert } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu"
import { StatusDot, type StatusTone } from "@/components/blocks"
import { cn } from "@/lib/utils"
import type { DesktopUpdatesApi } from "@/hooks/useDesktopUpdates"
import type { DesktopUpdateState } from "@/types/desktop-bridge"

/**
 * Which phases earn a badge, and what it looks like. `idle`/`checking` are
 * not actionable — nothing for the user to do, so nothing to flag. Pure and
 * exported so the gallery fixtures (and a future test) can drive every case
 * without mounting a component.
 */
export function desktopUpdateBadgeTone(
  state: DesktopUpdateState,
): { tone: StatusTone; pulse?: boolean } | null {
  switch (state.phase) {
    case "available":
      return { tone: "info" }
    case "downloading":
      return { tone: "info", pulse: true }
    case "ready":
      return { tone: "success" }
    case "error":
      return { tone: "destructive" }
    case "idle":
    case "checking":
      return null
  }
}

/**
 * The dot itself — the caller positions it (`className="absolute -right-0.5 -top-0.5"`
 * on a `relative` trigger button, matching `chat-session-menu.tsx`'s own
 * StatusDot-on-icon-button composition). Renders nothing for a
 * non-badge-worthy phase.
 */
export function DesktopUpdateBadge({
  state,
  className,
}: {
  state: DesktopUpdateState
  className?: string
}) {
  const badge = desktopUpdateBadgeTone(state)
  if (!badge) return null
  return (
    <StatusDot
      tone={badge.tone}
      size="sm"
      pulse={badge.pulse}
      className={cn("absolute -right-0.5 -top-0.5", className)}
      data-testid="desktop-update-badge"
      data-phase={state.phase}
    />
  )
}

/**
 * The phase-specific row: "Download update" (available), a progress readout
 * (downloading), "Restart to update" (ready), or a quiet failure line
 * (error). Renders nothing for idle/checking — there's nothing to say.
 *
 * `onRestartClick` is a callback rather than calling
 * `updates.restartAndInstall()` directly, so a caller with something to lose
 * (a streaming chat turn) can interpose a confirmation first — see
 * `EditorSettingsMenu`'s usage.
 */
export function DesktopUpdateStatusRow({
  updates,
  onRestartClick,
}: {
  updates: DesktopUpdatesApi
  onRestartClick: () => void
}) {
  const { state } = updates

  switch (state.phase) {
    case "available":
      return (
        <DropdownMenuItem
          onSelect={() => void updates.download()}
          data-testid="desktop-update-download"
        >
          <Download className="h-4 w-4" />
          <div className="flex min-w-0 flex-col">
            <span>Download update</span>
            {state.version ? (
              <span className="text-2xs text-muted-foreground">Version {state.version}</span>
            ) : null}
          </div>
        </DropdownMenuItem>
      )

    case "downloading": {
      const percent = Math.round(state.progressPercent ?? 0)
      return (
        <div className="flex flex-col gap-1 px-2 py-1.5" data-testid="desktop-update-downloading">
          <div className="flex items-center justify-between text-sm">
            <span>Downloading update</span>
            <span className="tabular-nums text-muted-foreground">{percent}%</span>
          </div>
          <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-[width]"
              // Genuinely dynamic: the download's live progress. Everything
              // static about this bar is in className.
              style={{ width: `${percent}%` }}
            />
          </div>
        </div>
      )
    }

    case "ready":
      return (
        <DropdownMenuItem onSelect={onRestartClick} data-testid="desktop-update-restart">
          <RefreshCw className="h-4 w-4" />
          Restart to update
        </DropdownMenuItem>
      )

    case "error": {
      // F5 (whole-branch review, Minor): `state.version` is the attributed
      // operation's own signal — `updater-reducer.ts`'s `applyCheckOutcome`
      // only ever lands a bare CHECK failure with no version (rule 4: a
      // check failure may write the display only where no update
      // operation's state exists yet), while a download or install-prep
      // failure keeps the version of the operation it belongs to. So a
      // defined version means this error came from downloading or
      // installing an update, not from checking for one — labelling it
      // "Update check failed" there is wrong on exactly the build this
      // product ships today (an unsigned build's likeliest error is a
      // Squirrel signature failure during install prep).
      const label = state.version ? "Update failed" : "Update check failed"
      return (
        <div
          className="px-2 py-1.5 text-sm text-destructive"
          data-testid="desktop-update-error"
        >
          <div className="flex items-center gap-1.5">
            <CircleAlert className="h-4 w-4 shrink-0" />
            <span>
              {label}
              {state.error ? `: ${state.error}` : ""}
            </span>
          </div>
        </div>
      )
    }

    case "idle":
    case "checking":
      return null
  }
}

/** The "Download updates automatically" toggle — always shown when the desktop bridge is present, independent of the current update phase. */
export function DesktopUpdateAutoDownloadItem({ updates }: { updates: DesktopUpdatesApi }) {
  return (
    <DropdownMenuCheckboxItem
      // Defaults to checked while the initial read is in flight — matches
      // the persisted store's own default (settings.ts's
      // defaultDesktopSettings().updates.autoDownload is true), so there's
      // no visible flicker from unchecked-then-checked in the common case.
      checked={updates.autoDownload ?? true}
      onCheckedChange={(value) => void updates.setAutoDownload(value)}
      data-testid="desktop-update-auto-download-toggle"
    >
      Download updates automatically
    </DropdownMenuCheckboxItem>
  )
}

/**
 * On-demand "Check for updates" — the third trigger alongside boot and the
 * 4h timer. Always shown (not phase-gated): checking is safe to invoke from
 * any phase (a no-op mid-download, reused rather than duplicated while
 * already checking — see `updater.ts`'s `checkForUpdates()` doc comment), so
 * the current check state is reflected in the item's own label instead of
 * hiding the control. Follows "Run smoke test"'s shape in
 * `editor-settings-menu.tsx` — a spinner + swapped label while running,
 * disabled for the duration.
 */
export function DesktopUpdateCheckNowItem({ updates }: { updates: DesktopUpdatesApi }) {
  const checking = updates.state.phase === "checking"
  return (
    <DropdownMenuItem
      disabled={checking}
      onSelect={() => updates.checkForUpdates()}
      data-testid="desktop-update-check-now"
    >
      {checking ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <RotateCw className="h-4 w-4" />
      )}
      {checking ? "Checking for updates" : "Check for updates"}
    </DropdownMenuItem>
  )
}

/**
 * The full top section for `EditorSettingsMenu`'s dropdown: the phase row
 * (when there's one to show), then the auto-download toggle, then the
 * on-demand check item, then a separator before the rest of the menu.
 * Returns null entirely when `updates` is undefined (browser tab) — nothing
 * renders, not even the separator.
 */
export function DesktopUpdateSection({
  updates,
  onRestartClick,
}: {
  updates: DesktopUpdatesApi | undefined
  onRestartClick: () => void
}) {
  if (!updates) return null
  return (
    <>
      <DesktopUpdateStatusRow updates={updates} onRestartClick={onRestartClick} />
      <DesktopUpdateAutoDownloadItem updates={updates} />
      <DesktopUpdateCheckNowItem updates={updates} />
      <DropdownMenuSeparator />
    </>
  )
}

/**
 * Confirms before restarting when a chat turn is streaming
 * (`tasks/electron-app.md` §4: "If a chat turn is streaming, the confirm
 * dialog says so before restarting."). `EditorSettingsMenu` owns `open` —
 * it only opens this when `onRestartClick` fires WHILE `chatSubmitting` is
 * true; otherwise it calls `restartAndInstall()` straight away and this
 * dialog never mounts. The launcher has no chat, so it never needs this at
 * all — `LauncherSettingsMenu` restarts directly.
 */
export function DesktopUpdateRestartConfirmDialog({
  open,
  onOpenChange,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (next: boolean) => void
  onConfirm: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="xl" data-testid="desktop-update-restart-confirm-dialog">
        <DialogHeader>
          <DialogTitle>Restart to update?</DialogTitle>
          <DialogDescription>
            A chat turn is still running. Restarting now will stop it before it
            finishes.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            data-testid="desktop-update-restart-confirm-cancel"
          >
            Cancel
          </Button>
          <Button
            onClick={() => {
              onOpenChange(false)
              onConfirm()
            }}
            data-testid="desktop-update-restart-confirm-restart"
          >
            Restart anyway
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
