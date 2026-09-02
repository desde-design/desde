import { describe, expect, it } from "vitest"
import {
  isMissingBinary,
  isUserCancel,
  linuxPickArgs,
  MACOS_PICK_SCRIPT,
  windowsPickScript,
} from "../folder-picker.js"

describe("folder-picker", () => {
  it("macOS script activates then chooses a folder as a POSIX path", () => {
    // Activation must come first so the dialog fronts the browser window.
    expect(MACOS_PICK_SCRIPT.indexOf("activate")).toBeLessThan(
      MACOS_PICK_SCRIPT.indexOf("choose folder"),
    )
    expect(MACOS_PICK_SCRIPT).toContain("POSIX path of (choose folder")
  })

  it("recognizes osascript user-cancel by error code and message", () => {
    // osascript exits 1 with AppleScript error -128 on dialog dismiss.
    expect(
      isUserCancel({ stderr: "execution error: User canceled. (-128)" }),
    ).toBe(true)
    expect(isUserCancel(new Error("Command failed: ... User cancelled"))).toBe(
      true,
    )
    expect(isUserCancel({ stderr: "some real failure" })).toBe(false)
    expect(isUserCancel(new Error("spawn osascript ENOENT"))).toBe(false)
    expect(isUserCancel(undefined)).toBe(false)
  })

  it("Windows script only prints a path when the dialog was confirmed", () => {
    const script = windowsPickScript("project")
    expect(script).toContain("FolderBrowserDialog")
    // Without the OK guard a cancel would print an empty SelectedPath and the
    // caller would read it as a chosen folder rather than a dismiss.
    expect(script).toContain("if ($d.ShowDialog() -eq 'OK')")
    expect(script.indexOf("Add-Type")).toBeLessThan(script.indexOf("New-Object"))
  })

  it("both scripts take their prompt from the closed purpose set", () => {
    // The prompt is interpolated into a script, so a caller-supplied string
    // would let the caller append code. Two fixed prompts cannot.
    expect(windowsPickScript("reference")).toContain("reference")
    expect(windowsPickScript("project")).not.toContain("reference")
    expect(linuxPickArgs("reference").join(" ")).toContain("reference")
  })

  it("Linux args ask zenity for a directory, not a file", () => {
    const args = linuxPickArgs("project")
    expect(args).toContain("--file-selection")
    // Without --directory zenity returns a FILE, and the caller would happily
    // treat it as a repo root.
    expect(args).toContain("--directory")
  })

  it("tells a missing chooser binary apart from a chooser that failed", () => {
    // zenity absent is an ordinary state on a minimal Linux install and must
    // degrade to the manual path field, not surface as an error.
    expect(isMissingBinary({ code: "ENOENT" })).toBe(true)
    expect(isMissingBinary({ code: 1, stderr: "some real failure" })).toBe(false)
    expect(isMissingBinary(new Error("boom"))).toBe(false)
    expect(isMissingBinary(undefined)).toBe(false)
  })
})
