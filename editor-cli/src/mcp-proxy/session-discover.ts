/**
 * Locate the running editor-cli by reading the session-info file
 * written at boot. Used by `stdio-server.ts` on every tool call so a
 * editor-cli restart (which rotates the per-session token) is
 * invisible to long-running `claude` sessions.
 *
 * Pid-liveness check rejects stale files left by a crashed
 * editor-cli — `process.kill(pid, 0)` is a no-op signal that throws
 * ESRCH when the pid doesn't exist. Cross-platform on Linux/macOS/
 * Windows (Node normalizes the behavior).
 */
import { readFileSync } from "node:fs"
import {
  sessionInfoPath,
  type SessionInfo,
} from "../server/session-info.js"

export type DiscoverResult =
  | { ok: true; info: SessionInfo }
  | { ok: false; reason: string }

export function discoverEditorSession(): DiscoverResult {
  let raw: string
  try {
    raw = readFileSync(sessionInfoPath(), "utf-8")
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "ENOENT") {
      return {
        ok: false,
        reason:
          "editor-cli is not running. Start it with `desde <repo-path>` and retry.",
      }
    }
    return {
      ok: false,
      reason: `Failed to read ${sessionInfoPath()}: ${(err as Error).message}`,
    }
  }

  let info: SessionInfo
  try {
    info = JSON.parse(raw) as SessionInfo
  } catch (err) {
    return {
      ok: false,
      reason: `Session-info file at ${sessionInfoPath()} is corrupt: ${(err as Error).message}. Restart editor-cli to regenerate.`,
    }
  }

  if (
    typeof info.url !== "string" ||
    typeof info.token !== "string" ||
    typeof info.pid !== "number"
  ) {
    return {
      ok: false,
      reason: `Session-info file at ${sessionInfoPath()} is missing required fields. Restart editor-cli.`,
    }
  }

  if (!isProcessAlive(info.pid)) {
    return {
      ok: false,
      reason: `editor-cli (pid ${info.pid}) is no longer running. Start it with \`desde <repo-path>\` and retry.`,
    }
  }

  return { ok: true, info }
}

function isProcessAlive(pid: number): boolean {
  try {
    // Signal 0 is a no-op probe — throws if the process doesn't exist
    // OR if we don't have permission. On macOS/Linux, EPERM means the
    // process exists but is owned by another user (very unusual for a
    // local CLI); treat as alive to avoid false negatives.
    process.kill(pid, 0)
    return true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "EPERM") return true
    return false
  }
}
