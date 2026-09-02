/**
 * Native OS folder picker for the launcher's "Open a local folder" flow.
 *
 * The browser cannot hand JS a real filesystem path (the File System
 * Access API deliberately hides it), but the launcher is a local Node
 * process — so the server pops the OS-native chooser and returns the
 * picked absolute path to the page.
 *
 * All three desktop platforms now have one, so the Browse button is offered
 * everywhere rather than only on macOS:
 *
 *  - macOS: `osascript` + AppleScript `choose folder`
 *  - Windows: PowerShell + `System.Windows.Forms.FolderBrowserDialog`
 *  - Linux: `zenity --file-selection --directory`
 *
 * Linux keeps a real `supported: false` path, and that is not laziness. zenity
 * is a GTK package that plenty of installs do not have, so support there is a
 * property of the MACHINE rather than of the platform, and the honest answer
 * is discovered by trying. A missing binary makes `execFile` fail with ENOENT,
 * which is reported as unsupported so the UI falls back to the manual path
 * field. Anything else is a real failure and rethrows.
 *
 * `folderPickerSupported()` stays synchronous and platform-only, so on Linux
 * it can say yes and the pick can still come back unsupported. That is the
 * right way round: the button appears, and the one time it cannot work the UI
 * switches to the manual field with the path already typeable. The reverse,
 * probing for zenity at capability time, would spawn a process on every
 * launcher boot to answer a question almost nobody needs.
 */

import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

export interface FolderPickResult {
  /** Whether this platform has a native picker implementation. */
  supported: boolean
  /** Absolute POSIX path of the chosen folder (when picked). */
  path?: string
  /** True when the user dismissed the dialog without choosing. */
  canceled?: boolean
}

/**
 * What the user is picking a folder FOR. The prompt differs, and picking a
 * reference directory mid-wizard with a chooser that says "choose a prototype
 * repo to open" reads as the wrong dialog.
 *
 * A closed set rather than a caller-supplied string on purpose: the prompt is
 * interpolated into an AppleScript program, so accepting arbitrary text would
 * make the caller able to append script of its own. Two fixed strings cannot.
 */
export type FolderPickPurpose = "project" | "reference"

const PICK_PROMPTS: Record<FolderPickPurpose, string> = {
  project: "Choose a prototype repo to open in Editor",
  reference: "Choose a folder for the agent to reference",
}

/** AppleScript that pops the chooser and returns the POSIX path. */
export function macosPickScript(purpose: FolderPickPurpose): string {
  return [
    // Focus the dialog in front of the browser — without the activate the
    // chooser can open behind the current window and look like a hang.
    'tell application "System Events" to activate',
    `POSIX path of (choose folder with prompt "${PICK_PROMPTS[purpose]}")`,
  ].join("\n")
}

/** Back-compat alias for the original project-picking script. */
export const MACOS_PICK_SCRIPT = macosPickScript("project")

/**
 * PowerShell that pops the Windows folder browser and prints the chosen path.
 *
 * `FolderBrowserDialog` rather than the newer `IFileOpenDialog`, because it is
 * reachable from stock PowerShell 5.1 with no module install. It prints
 * nothing on cancel, which is the same shape the other two report.
 *
 * The prompt is interpolated, so it comes from `PICK_PROMPTS` and never from a
 * caller-supplied string. Same reason `FolderPickPurpose` is a closed set.
 */
export function windowsPickScript(purpose: FolderPickPurpose): string {
  return [
    "Add-Type -AssemblyName System.Windows.Forms",
    "$d = New-Object System.Windows.Forms.FolderBrowserDialog",
    `$d.Description = '${PICK_PROMPTS[purpose]}'`,
    // Without this the dialog can open behind the browser window and read as
    // a hang, the same problem the macOS `activate` line solves.
    "$d.RootFolder = 'MyComputer'",
    "if ($d.ShowDialog() -eq 'OK') { Write-Output $d.SelectedPath }",
  ].join("\n")
}

/** zenity args for the Linux chooser. */
export function linuxPickArgs(purpose: FolderPickPurpose): string[] {
  return [
    "--file-selection",
    "--directory",
    `--title=${PICK_PROMPTS[purpose]}`,
  ]
}

/**
 * A missing chooser binary, as opposed to a chooser that ran and failed.
 *
 * ENOENT is what `execFile` reports when zenity is not installed, which is an
 * ordinary state on a minimal Linux install and must degrade to the manual
 * path field rather than surfacing as an error.
 */
export function isMissingBinary(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === "ENOENT"
}

/** osascript exits 1 with "User canceled." on dialog dismiss (error -128). */
export function isUserCancel(err: unknown): boolean {
  const stderr = (err as { stderr?: string })?.stderr ?? ""
  const message = (err as Error)?.message ?? ""
  return /-128|[Uu]ser cancell?ed/.test(stderr + message)
}

export type PickFolder = (purpose?: FolderPickPurpose) => Promise<FolderPickResult>

/** The chooser invocation for this platform, or null where there is none. */
function pickCommand(
  purpose: FolderPickPurpose,
): { file: string; args: string[] } | null {
  switch (process.platform) {
    case "darwin":
      return { file: "osascript", args: ["-e", macosPickScript(purpose)] }
    case "win32":
      return {
        file: "powershell.exe",
        // `-NoProfile` so a user's profile script cannot write to stdout and
        // corrupt the path we parse. `-NonInteractive` keeps it from stalling
        // on a prompt with no console attached.
        args: [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          windowsPickScript(purpose),
        ],
      }
    case "linux":
      return { file: "zenity", args: linuxPickArgs(purpose) }
    default:
      return null
  }
}

export async function pickFolder(
  purpose: FolderPickPurpose = "project",
): Promise<FolderPickResult> {
  const command = pickCommand(purpose)
  if (!command) return { supported: false }
  try {
    const { stdout } = await execFileAsync(command.file, command.args, {
      // No timeout: the dialog legitimately stays open while the user browses.
      maxBuffer: 1024 * 1024,
    })
    const path = stdout.trim()
    // Empty stdout is cancel on all three: AppleScript errors instead (caught
    // below), zenity exits 1 with nothing, PowerShell writes nothing unless
    // ShowDialog returned OK.
    if (!path) return { supported: true, canceled: true }
    return { supported: true, path }
  } catch (err) {
    if (isUserCancel(err)) return { supported: true, canceled: true }
    // zenity exits 1 on cancel with no stderr, which reaches here rather than
    // the empty-stdout branch above. Treat a clean exit-1-with-no-output as
    // cancel rather than an error.
    if (isCleanNonZeroExit(err)) return { supported: true, canceled: true }
    // No chooser installed (Linux without zenity). The machine, not the
    // platform, lacks one: report unsupported so the UI shows the manual path
    // field instead of an error for something the user cannot fix from here.
    if (isMissingBinary(err)) return { supported: false }
    throw err
  }
}

/** Exit code 1 with nothing on stderr, which is how zenity reports a dismiss. */
function isCleanNonZeroExit(err: unknown): boolean {
  const e = err as { code?: unknown; stderr?: string }
  return e?.code === 1 && !(e.stderr ?? "").trim()
}

/**
 * Whether this platform has a native picker (for capability flags).
 *
 * Platform-only and synchronous on purpose. On Linux this can say yes and the
 * pick still come back `supported: false` when zenity is absent; see the
 * module doc for why that is the right way round.
 */
export function folderPickerSupported(): boolean {
  return (
    process.platform === "darwin" ||
    process.platform === "win32" ||
    process.platform === "linux"
  )
}
