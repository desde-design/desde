/**
 * The check dialog: what "Check for updates" opens (Mo, 2026-09-02: "we
 * should use a modal and not a toast as this is an explicit action from a
 * user"). `describeUpdateCheck` is the whole decision, so it gets the table;
 * the component tests cover what the dialog puts on screen and which
 * control it offers for each outcome.
 */

import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import {
  DesktopUpdateCheckDialog,
  checkDialogDescription,
  checkDialogTitle,
  describeUpdateCheck,
} from "./desktop-update-menu"
import type { DesktopUpdateCheckResult, DesktopUpdatesApi } from "@/hooks/useDesktopUpdates"
import type { DesktopUpdateState } from "@/types/desktop-bridge"

function api(
  state: DesktopUpdateState,
  lastCheck: DesktopUpdateCheckResult | undefined,
): DesktopUpdatesApi {
  return {
    appVersion: "0.1.1",
    state,
    lastCheck,
    autoDownload: true,
    setAutoDownload: vi.fn(async () => {}),
    download: vi.fn(async () => {}),
    restartAndInstall: vi.fn(),
    restarting: false,
    checkForUpdates: vi.fn(),
  }
}

describe("describeUpdateCheck", () => {
  const idle: DesktopUpdateState = { phase: "idle" }

  it("is 'checking' before any click and while the click's own call is pending, whatever the state says", () => {
    expect(describeUpdateCheck(undefined, idle, "0.1.1")).toEqual({ kind: "checking" })
    expect(describeUpdateCheck({ status: "checking" }, idle, "0.1.1")).toEqual({ kind: "checking" })
    // A background check's "checking" state does not decide the dialog; the
    // click's own result does.
    expect(
      describeUpdateCheck({ status: "checking" }, { phase: "available", version: "9" }, "0.1.1"),
    ).toEqual({ kind: "checking" })
  })

  it("reads the click's result before the state: idle is only 'up to date' once a check actually ran", () => {
    expect(describeUpdateCheck({ status: "performed" }, idle, "0.1.1")).toEqual({
      kind: "up-to-date",
      version: "0.1.1",
    })
    // A check refused because an update is already downloaded (updater.ts
    // never re-checks while ready — re-checking destroys Squirrel.Mac's
    // install prep on macOS) reads the state machine: the update IS the answer.
    expect(describeUpdateCheck({ status: "not-performed" }, { phase: "ready", version: "1.5.0" }, "0.1.1")).toEqual({
      kind: "ready",
      version: "1.5.0",
    })
    // A restart under way outranks everything, the click's own result included.
    expect(describeUpdateCheck(undefined, { phase: "ready", version: "1.5.0" }, "0.1.1", true)).toEqual({
      kind: "restarting",
    })
    expect(describeUpdateCheck({ status: "performed" }, { phase: "ready", version: "1.5.0" }, "0.1.1", true)).toEqual({
      kind: "restarting",
    })
    // …and if that ready update then fails its native prep, the failure is
    // shown, not "checks aren't available" (codex, 2026-09-02).
    expect(
      describeUpdateCheck({ status: "not-performed" }, { phase: "error", version: "1.5.0", error: "ditto: lstat" }, "0.1.1"),
    ).toEqual({ kind: "error", scope: "update", message: "ditto: lstat" })
    // A restart that stood down leaves no click result; the update in hand
    // is the view, never a permanent "Checking for updates".
    expect(describeUpdateCheck(undefined, { phase: "ready", version: "1.5.0" }, "0.1.1", false)).toEqual({
      kind: "ready",
      version: "1.5.0",
    })
    expect(describeUpdateCheck(undefined, { phase: "error", version: "1.5.0", error: "deadline" }, "0.1.1")).toEqual({
      kind: "error",
      scope: "update",
      message: "deadline",
    })
    expect(describeUpdateCheck({ status: "not-performed" }, idle, "0.1.1")).toEqual({
      kind: "not-performed",
    })
    expect(describeUpdateCheck({ status: "failed", error: "IPC channel closed" }, idle, "0.1.1")).toEqual({
      kind: "error",
      scope: "check",
      message: "IPC channel closed",
    })
  })

  it("follows the update state live once the check has performed", () => {
    const performed: DesktopUpdateCheckResult = { status: "performed" }
    expect(describeUpdateCheck(performed, { phase: "available", version: "1.5.0" }, "0.1.1")).toEqual({
      kind: "available",
      version: "1.5.0",
    })
    expect(
      describeUpdateCheck(performed, { phase: "downloading", version: "1.5.0", progressPercent: 42.6 }, "0.1.1"),
    ).toEqual({ kind: "downloading", version: "1.5.0", percent: 43 })
    expect(describeUpdateCheck(performed, { phase: "ready", version: "1.5.0" }, "0.1.1")).toEqual({
      kind: "ready",
      version: "1.5.0",
    })
    expect(describeUpdateCheck(performed, { phase: "checking" }, "0.1.1")).toEqual({ kind: "checking" })
  })

  it("scopes an error the way the menu row does: a version means the update failed, none means the check did", () => {
    expect(describeUpdateCheck({ status: "performed" }, { phase: "error", error: "ENOTFOUND" }, "0.1.1")).toEqual({
      kind: "error",
      scope: "check",
      message: "ENOTFOUND",
    })
    expect(
      describeUpdateCheck({ status: "performed" }, { phase: "error", version: "1.5.0", error: "sha512 mismatch" }, "0.1.1"),
    ).toEqual({ kind: "error", scope: "update", message: "sha512 mismatch" })
  })

  it("has a title and a description for every view, with no em dashes and no trailing ellipsis", () => {
    const views = [
      describeUpdateCheck(undefined, idle, "0.1.1"),
      describeUpdateCheck({ status: "performed" }, idle, "0.1.1"),
      describeUpdateCheck({ status: "not-performed" }, idle, "0.1.1"),
      describeUpdateCheck({ status: "performed" }, { phase: "available" }, "0.1.1"),
      describeUpdateCheck({ status: "performed" }, { phase: "downloading", progressPercent: 1 }, "0.1.1"),
      describeUpdateCheck({ status: "performed" }, { phase: "ready" }, "0.1.1"),
      describeUpdateCheck({ status: "performed" }, { phase: "error" }, "0.1.1"),
      describeUpdateCheck({ status: "performed" }, { phase: "error", version: "2" }, "0.1.1"),
    ]
    for (const view of views) {
      for (const text of [checkDialogTitle(view), checkDialogDescription(view)]) {
        expect(text.length).toBeGreaterThan(0)
        expect(text).not.toMatch(/—|…|\.\.\.$/)
      }
    }
  })
})

describe("DesktopUpdateCheckDialog", () => {
  it("renders nothing in a plain browser tab", () => {
    render(
      <DesktopUpdateCheckDialog open onOpenChange={() => {}} updates={undefined} onRestartClick={() => {}} />,
    )
    expect(screen.queryByTestId("desktop-update-check-dialog")).not.toBeInTheDocument()
  })

  it("shows the checking state with only Close, and Close hands the open state back", () => {
    const onOpenChange = vi.fn()
    render(
      <DesktopUpdateCheckDialog
        open
        onOpenChange={onOpenChange}
        updates={api({ phase: "checking" }, { status: "checking" })}
        onRestartClick={() => {}}
      />,
    )
    expect(screen.getByTestId("desktop-update-check-dialog")).toHaveAttribute("data-view", "checking")
    expect(screen.getByText("Checking for updates")).toBeInTheDocument()
    expect(screen.queryByTestId("desktop-update-check-download")).not.toBeInTheDocument()
    expect(screen.queryByTestId("desktop-update-check-restart")).not.toBeInTheDocument()
    expect(screen.queryByTestId("desktop-update-check-retry")).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId("desktop-update-check-close"))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("names the running version when up to date", () => {
    render(
      <DesktopUpdateCheckDialog
        open
        onOpenChange={() => {}}
        updates={api({ phase: "idle" }, { status: "performed" })}
        onRestartClick={() => {}}
      />,
    )
    expect(screen.getByTestId("desktop-update-check-dialog")).toHaveAttribute("data-view", "up-to-date")
    expect(screen.getByText("Up to date")).toBeInTheDocument()
    expect(screen.getByText("Version 0.1.1 is the latest available.")).toBeInTheDocument()
  })

  it("offers Download when an update is available, and it calls the bridge", () => {
    const updates = api({ phase: "available", version: "1.5.0" }, { status: "performed" })
    render(<DesktopUpdateCheckDialog open onOpenChange={() => {}} updates={updates} onRestartClick={() => {}} />)
    expect(screen.getByText("Update available")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("desktop-update-check-download"))
    expect(updates.download).toHaveBeenCalledTimes(1)
  })

  it("shows the download's progress in place", () => {
    render(
      <DesktopUpdateCheckDialog
        open
        onOpenChange={() => {}}
        updates={api({ phase: "downloading", version: "1.5.0", progressPercent: 43 }, { status: "performed" })}
        onRestartClick={() => {}}
      />,
    )
    expect(screen.getByTestId("desktop-update-check-progress")).toHaveTextContent("43%")
  })

  it("offers Restart when the update is ready, through the caller's confirm seam", () => {
    const onRestartClick = vi.fn()
    render(
      <DesktopUpdateCheckDialog
        open
        onOpenChange={() => {}}
        updates={api({ phase: "ready", version: "1.5.0" }, { status: "performed" })}
        onRestartClick={onRestartClick}
      />,
    )
    fireEvent.click(screen.getByTestId("desktop-update-check-restart"))
    expect(onRestartClick).toHaveBeenCalledTimes(1)
  })

  it("offers Try again on a failed check, announced as a status", () => {
    const updates = api({ phase: "error", error: "ENOTFOUND github.com" }, { status: "performed" })
    render(<DesktopUpdateCheckDialog open onOpenChange={() => {}} updates={updates} onRestartClick={() => {}} />)
    expect(screen.getByText("Update check failed")).toBeInTheDocument()
    expect(screen.getByRole("status")).toHaveTextContent("ENOTFOUND github.com")
    fireEvent.click(screen.getByTestId("desktop-update-check-retry"))
    expect(updates.checkForUpdates).toHaveBeenCalledTimes(1)
  })

  it("shows the restarting view once Restart was clicked: a spinner, no Restart or Download to click again, Close still there", () => {
    render(
      <DesktopUpdateCheckDialog
        open
        onOpenChange={() => {}}
        updates={{ ...api({ phase: "ready", version: "1.5.0" }, undefined), restarting: true }}
        onRestartClick={() => {}}
      />,
    )
    expect(screen.getByTestId("desktop-update-check-dialog")).toHaveAttribute("data-view", "restarting")
    expect(screen.getByText("Restarting to update")).toBeInTheDocument()
    expect(screen.queryByTestId("desktop-update-check-restart")).not.toBeInTheDocument()
    expect(screen.queryByTestId("desktop-update-check-download")).not.toBeInTheDocument()
    expect(screen.getByTestId("desktop-update-check-close")).toBeInTheDocument()
  })

  it("says plainly when nothing was checked, instead of claiming up to date", () => {
    render(
      <DesktopUpdateCheckDialog
        open
        onOpenChange={() => {}}
        updates={api({ phase: "idle" }, { status: "not-performed" })}
        onRestartClick={() => {}}
      />,
    )
    expect(screen.getByTestId("desktop-update-check-dialog")).toHaveAttribute("data-view", "not-performed")
    expect(screen.queryByText("Up to date")).not.toBeInTheDocument()
  })
})
