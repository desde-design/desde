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
 *  - `DesktopUpdateCheckDialog` — what "Check for updates" opens (Mo,
 *    2026-09-02: "we should use a modal and not a toast as this is an
 *    explicit action from a user"). It follows the click from "checking"
 *    through whatever the check finds: up to date, an update to download,
 *    the download's progress, ready to restart, or the failure. The menu
 *    closes on select, so the dialog cannot live inside the section; each
 *    settings menu owns its `open` state, the same way it owns the restart
 *    confirm. Before this, the click's only feedback was a toast, and the
 *    launcher mounted no toast host, so there it did nothing visible.
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
import type { DesktopUpdateCheckResult, DesktopUpdatesApi } from "@/hooks/useDesktopUpdates"
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
          <UpdateProgressBar percent={percent} />
        </div>
      )
    }

    case "ready":
      if (updates.restarting) {
        // The click already happened; the menu was reopened during the
        // seconds before the window closes. Not a second invitation.
        return (
          <div className="flex items-center gap-2 px-2 py-1.5 text-sm" data-testid="desktop-update-restarting">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            Restarting to update
          </div>
        )
      }
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

/** The download's progress, shared by the menu row and the check dialog so the two cannot drift. */
function UpdateProgressBar({ percent }: { percent: number }) {
  return (
    <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
      <div
        className="h-full rounded-full bg-primary transition-[width]"
        // Genuinely dynamic: the download's live progress. Everything
        // static about this bar is in className.
        style={{ width: `${percent}%` }}
      />
    </div>
  )
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
 * 4h timer. Always shown (not phase-gated): invoking it is safe from any
 * phase because `updater.ts` decides what a click may do — it shares an
 * in-flight check, shares a running download, and REFUSES while an update
 * is already ready (see `runCheck()` there for why a re-check then is
 * destructive on macOS; the dialog shows "ready" for that click). So the
 * current check state is reflected in the item's own label instead of
 * hiding the control. Follows "Run smoke test"'s shape in
 * `editor-settings-menu.tsx` — a spinner + swapped label while running,
 * disabled for the duration.
 *
 * `onSelect` is the caller's: the item only starts the check, and the
 * caller opens `DesktopUpdateCheckDialog` to show it. The menu closes on
 * select, so nothing rendered in here could stay on screen to do that.
 */
export function DesktopUpdateCheckNowItem({
  updates,
  onSelect,
}: {
  updates: DesktopUpdatesApi
  onSelect: () => void
}) {
  const checking = updates.state.phase === "checking"
  return (
    <DropdownMenuItem
      disabled={checking}
      onSelect={() => {
        updates.checkForUpdates()
        onSelect()
      }}
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
 *
 * `onCheckClick` fires after the on-demand check has been started; the
 * caller opens its `DesktopUpdateCheckDialog` there.
 */
export function DesktopUpdateSection({
  updates,
  onRestartClick,
  onCheckClick,
}: {
  updates: DesktopUpdatesApi | undefined
  onRestartClick: () => void
  onCheckClick: () => void
}) {
  if (!updates) return null
  return (
    <>
      <DesktopUpdateStatusRow updates={updates} onRestartClick={onRestartClick} />
      <DesktopUpdateAutoDownloadItem updates={updates} />
      <DesktopUpdateCheckNowItem updates={updates} onSelect={onCheckClick} />
      <DropdownMenuSeparator />
    </>
  )
}

/**
 * What the check dialog shows, derived from the click's own result and the
 * update state. Pure and exported so the gallery fixtures and the tests can
 * drive every case without mounting a component.
 *
 * The click's result is consulted FIRST, because `state` alone cannot tell
 * two of these apart: "idle" is both "checked, nothing new" and "no check
 * ever ran". Once a check has `performed`, the state machine is the truth
 * and keeps being read live, so a download that starts after the dialog
 * opened shows its progress in place. `restarting` (the hook's flag, set by
 * a "Restart to update" click) outranks even that — see the first branch.
 */
export type UpdateCheckView =
  | { kind: "restarting" }
  | { kind: "checking" }
  | { kind: "up-to-date"; version: string }
  | { kind: "not-performed" }
  | { kind: "available"; version?: string }
  | { kind: "downloading"; version?: string; percent: number }
  | { kind: "ready"; version?: string }
  | { kind: "error"; scope: "check" | "update"; message?: string }

export function describeUpdateCheck(
  lastCheck: DesktopUpdateCheckResult | undefined,
  state: DesktopUpdateState,
  appVersion: string,
  restarting = false,
): UpdateCheckView {
  // "Restart to update" was clicked and the app has not closed yet: the
  // payload child is being shut down, then the native installer takes over
  // and the window goes away. Outranks everything, including a click's own
  // result — no check matters once the restart is under way. Measured
  // 2026-09-02: that shutdown is normally well under a second, but the
  // whole round trip (quit, install, relaunch) can run to a minute, and
  // with no state on screen it read as "nothing happened", so the app was
  // relaunched by hand mid-install and the installer aborted.
  if (restarting) return { kind: "restarting" }
  if (lastCheck?.status === "checking") return { kind: "checking" }
  // No click's result to go on: the dialog was opened by a "Restart to
  // update" click that then stood down (shutdown could not be confirmed, or
  // nothing was ready after all), or it is about to receive one. With an
  // update in hand the state machine is the answer; only idle/checking read
  // as "still looking", which is also what an about-to-arrive click shows.
  if (lastCheck === undefined && (state.phase === "idle" || state.phase === "checking")) {
    return { kind: "checking" }
  }
  // A check is refused, not just skipped, while an update is already
  // downloaded (`updater.ts`'s `runCheck()`: re-checking then would destroy
  // the native install prep on macOS). Everything the state machine says
  // about that update — ready, and any failure it runs into afterwards —
  // is the answer; "can't check for updates" is only true when there is
  // nothing in hand at all (no feed configured, or unpackaged dev).
  if (lastCheck?.status === "not-performed" && state.phase === "idle") return { kind: "not-performed" }
  if (lastCheck?.status === "failed") return { kind: "error", scope: "check", message: lastCheck.error }
  switch (state.phase) {
    case "idle":
      return { kind: "up-to-date", version: appVersion }
    case "checking":
      // A background check began after this click's own check settled.
      // Its result will land in `state` too; "checking" is the honest
      // reading until it does.
      return { kind: "checking" }
    case "available":
      return { kind: "available", version: state.version }
    case "downloading":
      return {
        kind: "downloading",
        version: state.version,
        percent: Math.round(state.progressPercent ?? 0),
      }
    case "ready":
      return { kind: "ready", version: state.version }
    case "error":
      // Same rule as `DesktopUpdateStatusRow`: a version means the failure
      // belongs to a download or install, not to the check.
      return { kind: "error", scope: state.version ? "update" : "check", message: state.error }
  }
}

/**
 * The dialog "Check for updates" opens. `updates` may be undefined (browser
 * tab), in which case nothing renders.
 *
 * Close is always in the footer. It hides the dialog and nothing else: a
 * check or a download carries on in the background, and the menu's own
 * status row and the settings dot keep reporting it, so closing is a way
 * out that is one. Restart goes through `onRestartClick` for the same
 * reason the menu row's does: the project menu confirms first when a chat
 * turn is streaming.
 */
export function DesktopUpdateCheckDialog({
  open,
  onOpenChange,
  updates,
  onRestartClick,
}: {
  open: boolean
  onOpenChange: (next: boolean) => void
  updates: DesktopUpdatesApi | undefined
  onRestartClick: () => void
}) {
  if (!updates) return null
  const view = describeUpdateCheck(updates.lastCheck, updates.state, updates.appVersion, updates.restarting)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md" data-testid="desktop-update-check-dialog" data-view={view.kind}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {checkDialogTitle(view)}
            {view.kind === "checking" || view.kind === "restarting" ? (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            ) : null}
          </DialogTitle>
          <DialogDescription>
            {view.kind === "error" ? (
              <span role="status" className="text-destructive">
                {checkDialogDescription(view)}
              </span>
            ) : (
              checkDialogDescription(view)
            )}
          </DialogDescription>
        </DialogHeader>
        {view.kind === "downloading" ? (
          <div className="flex flex-col gap-1" data-testid="desktop-update-check-progress">
            <div className="flex items-center justify-between text-sm">
              <span>Downloading</span>
              <span className="tabular-nums text-muted-foreground">{view.percent}%</span>
            </div>
            <UpdateProgressBar percent={view.percent} />
          </div>
        ) : null}
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            data-testid="desktop-update-check-close"
          >
            Close
          </Button>
          {view.kind === "available" ? (
            <Button
              onClick={() => void updates.download()}
              data-testid="desktop-update-check-download"
            >
              <Download />
              Download
            </Button>
          ) : null}
          {view.kind === "ready" ? (
            <Button onClick={onRestartClick} data-testid="desktop-update-check-restart">
              <RefreshCw />
              Restart to update
            </Button>
          ) : null}
          {view.kind === "error" ? (
            <Button
              onClick={() => updates.checkForUpdates()}
              data-testid="desktop-update-check-retry"
            >
              <RotateCw />
              Try again
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Titles are sentences that name the state. No trailing ellipsis: the spinner already says it is running. */
export function checkDialogTitle(view: UpdateCheckView): string {
  switch (view.kind) {
    case "restarting":
      return "Restarting to update"
    case "checking":
      return "Checking for updates"
    case "up-to-date":
      return "Up to date"
    case "not-performed":
      return "Update checks aren't available"
    case "available":
      return "Update available"
    case "downloading":
      return "Downloading update"
    case "ready":
      return "Update ready to install"
    case "error":
      return view.scope === "update" ? "Update failed" : "Update check failed"
  }
}

export function checkDialogDescription(view: UpdateCheckView): string {
  const version = (v: string | undefined) => (v ? `Version ${v}` : "A new version")
  switch (view.kind) {
    case "restarting":
      return "Closing the editor. Desde will quit and reopen on its own. This can take a minute, so leave it be."
    case "checking":
      return "Looking for a newer version."
    case "up-to-date":
      return `Version ${view.version} is the latest available.`
    case "not-performed":
      return "This copy of the app can't check for updates."
    case "available":
      return `${version(view.version)} can be downloaded now.`
    case "downloading":
      return `${version(view.version)} is downloading. Closing this keeps the download going.`
    case "ready":
      return `${version(view.version)} is downloaded and installs on the next restart.`
    case "error":
      return view.message
        ? `${view.message} Check the connection and try again.`
        : "Something went wrong. Check the connection and try again."
  }
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
