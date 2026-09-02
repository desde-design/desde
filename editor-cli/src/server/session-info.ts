/**
 * Session-info file at `~/.desde/editor-session.json`.
 *
 * Written by editor-cli at boot once the HTTP server is healthy.
 * Read by the `desde-mcp` stdio proxy on every tool
 * call so it can locate the live editor-cli (URL + token + pid).
 *
 * Lifecycle:
 *   - Write on successful HTTP server bind.
 *   - Replace existing file (mode 0600) — last-writer wins is fine
 *     because we don't support two editors on the same machine
 *     (the proxy points at exactly one session at a time).
 *   - Unlink on process exit (best-effort via `process.on` hooks).
 *
 * Stale-file detection: the proxy checks the recorded `pid` is still
 * alive via `process.kill(pid, 0)`. A editor-cli that crashed
 * without cleanup leaves a stale file; the proxy detects and reports
 * "editor-cli not running" instead of POSTing to a dead port.
 */
import { mkdirSync, writeFileSync, unlinkSync, chmodSync } from "node:fs"
import { homedir } from "node:os"
import { resolve as resolvePath, dirname } from "node:path"

/** Absolute path to the session-info file. */
export function sessionInfoPath(): string {
  return resolvePath(homedir(), ".desde", "editor-session.json")
}

export interface SessionInfo {
  /** Editor-cli HTTP URL (e.g. `http://127.0.0.1:4321`). */
  url: string
  /** Per-session bearer token. */
  token: string
  /** Editor-cli process pid for liveness checks. */
  pid: number
  /** Repo the editor was launched against. */
  repoRoot: string
  /** Tool names the MCP proxy can call against this editor. */
  mcpToolsAvailable: string[]
  /** Bridge bundle version, for future compatibility checks. */
  bridgeVersion: string
  /** ISO timestamp, for debugging stale files. */
  writtenAt: string
}

/**
 * Write the session-info file. Creates `~/.desde/` with 0700 if
 * absent. Returns nothing — failures are surfaced via thrown errors
 * (the caller logs them as a warning; a missing session file just
 * means the MCP proxy can't auto-discover, which is recoverable by
 * passing args).
 */
export function writeSessionInfo(info: SessionInfo): void {
  const path = sessionInfoPath()
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  // Belt-and-suspenders: chmod the dir even when it already existed,
  // so a pre-existing 0755 dir from another tool gets tightened.
  try {
    chmodSync(dir, 0o700)
  } catch {
    // Ignore — best-effort tightening; the file itself is 0600.
  }
  writeFileSync(path, JSON.stringify(info, null, 2), { mode: 0o600 })
  // Defensive: writeFileSync's `mode` option is only honored on file
  // CREATION. If the file already existed, the mode is unchanged.
  // Chmod explicitly so the token is never world-readable.
  chmodSync(path, 0o600)
}

/**
 * Best-effort cleanup. Called from process exit hooks. Swallows
 * errors because the file may have already been removed by a sibling
 * cleanup handler or by another editor-cli that ran after this one.
 */
export function removeSessionInfo(): void {
  try {
    unlinkSync(sessionInfoPath())
  } catch {
    // ENOENT or stale handle — nothing to do.
  }
}

/**
 * Register a process-exit handler that deletes the session file.
 * Idempotent — calling twice doesn't double-register.
 *
 * Only listens on `'exit'` (synchronous) — it runs whether the process
 * leaves via `process.exit()`, a normal completion, or an unhandled
 * throw. The SIGINT / SIGTERM lifecycle is owned by the CLI entry
 * (`editor-cli/src/cli.ts`): its handler awaits `core.close()` (which
 * also calls `removeSessionInfo` AND discards the worktree session),
 * then exits with the signal-derived code. Codex Phase B review (May
 * 2026) flagged the previous design where this module's signal
 * handlers called `process.exit()` synchronously and killed the
 * process before cli.ts's async `core.close()` could finish — leaving
 * the worktree on disk (orphan leak).
 */
let cleanupRegistered = false
export function registerSessionInfoCleanup(): void {
  if (cleanupRegistered) return
  cleanupRegistered = true
  process.on("exit", removeSessionInfo)
}
