/**
 * A plain-text log of what boot decided, in the user data directory.
 *
 * A Finder-launched app has no stdout anyone can read, so every
 * `console.log` in `main.ts` is lost the moment it matters. The login-shell
 * PATH failure of 2026-09-02 (see `login-shell-path.ts`,
 * `loginShellFallbackInvocation`) was diagnosed by attaching an inspector to
 * the live process, eight minutes after the fact, and the evidence that
 * would have explained it was already gone. This file is where that
 * evidence goes next time.
 *
 * One file, rewritten on every boot, so it never grows: the previous boot's
 * lines are exactly what a fresh boot replaces. Every write swallows its own
 * failure. A log that cannot be written must not become a boot that cannot
 * happen.
 */
import { appendFileSync, writeFileSync } from "node:fs"

export type BootLog = (line: string) => void

/** Truncates `path` now and returns a writer that appends one timestamped line per call. */
export function createBootLog(path: string, now: () => Date = () => new Date()): BootLog {
  try {
    writeFileSync(path, "")
  } catch {
    // Unwritable location: the writer below fails the same way, quietly.
  }
  return (line) => {
    try {
      appendFileSync(path, `${now().toISOString()} ${line}\n`)
    } catch {
      // See the module doc comment.
    }
  }
}
