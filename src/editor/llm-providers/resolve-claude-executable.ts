/**
 * Resolves the `pathToClaudeCodeExecutable` the Agent SDK should spawn —
 * the ONE seam both `query()` call sites (`claude-agent-sdk-provider.ts`,
 * `run-chat-turn-sdk.ts`) go through. See `tasks/electron-app.md`'s "stop
 * bundling the claude binary, fetch it on first run" work.
 *
 * **Terminal CLI (run from a checkout, or any payload that still ships the
 * platform package under its own `node_modules`): unaffected.** This
 * function returns `undefined` unless `EDITOR_CLAUDE_RUNTIME_DIR` is set,
 * and only Desde's Electron main process ever sets that (`desktop/main.ts`,
 * on every process it spawns) — so a terminal user's `process.env` never
 * has it, this function always returns `undefined` for them, and the SDK
 * falls through to its OWN default resolution
 * (`require.resolve('@anthropic-ai/claude-agent-sdk-<platform>-<arch>')`)
 * exactly as it did before this work existed.
 *
 * **Desktop app.** Desde's staged payload does NOT ship the platform
 * package (`scripts/build-server-package.mts` excludes it — see that
 * file's doc comment for why: Anthropic's npm terms give no clear grant to
 * redistribute that binary through a third party's own installer).
 * `desktop/claude-runtime-installer.ts` fetches it directly from npm onto
 * the user's own machine instead, into a version-keyed, user-writable
 * directory OUTSIDE `Desde.app` (never inside the code-signed bundle).
 * Electron main sets `EDITOR_CLAUDE_RUNTIME_DIR` to that directory's PARENT
 * (the app-support root) on every process it spawns — unconditionally and
 * SYNCHRONOUSLY at boot, since it's just a path string, no I/O. This
 * function then does a live filesystem check against the exact version-keyed
 * path EVERY TIME it's called: whichever `query()` call happens to run
 * first — seconds or minutes after boot — sees whatever is ACTUALLY on disk
 * at that moment. There is deliberately no cached/env-var-encoded "is it
 * installed" flag to go stale: the one variable Electron hands down
 * (`EDITOR_CLAUDE_RUNTIME_DIR`) never changes after spawn, so a fresh disk
 * check is the only thing that can be right regardless of whether the
 * install finished before or after the process that will use it was
 * spawned.
 */

import { accessSync, constants as fsConstants } from "node:fs"

import {
  readInstalledClaudeAgentSdkVersion,
  resolveClaudeRuntimeDir,
} from "./claude-runtime-location"
import { verifyInstalledClaudeRuntime } from "./claude-runtime-verify"

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * `EDITOR_CLAUDE_EXECUTABLE_PATH` / `EDITOR_CLAUDE_RUNTIME_DIR` are
 * desktop-app-internal plumbing (set only by `desktop/main.ts`, read only
 * here), not documented user-facing config knobs — that's why they aren't
 * in CLAUDE.md's "Editor CLI env vars" table alongside `EDITOR_MODE` et al.
 *
 * @param env Defaults to `process.env`. Overridable for tests.
 * @param resolveFrom Defaults to this module's own `import.meta.url` — the
 *   base `readInstalledClaudeAgentSdkVersion` resolves
 *   `@anthropic-ai/claude-agent-sdk` from. Overridable for tests (and, in
 *   principle, for a future caller that needs to resolve against a
 *   different installed SDK than this process's own — no such caller
 *   exists today).
 * @returns The absolute path to a verified-executable `claude` binary, or
 *   `undefined` to defer to the SDK's own default resolution.
 */
export function resolveClaudeExecutablePath(
  env: NodeJS.ProcessEnv = process.env,
  resolveFrom: string = import.meta.url,
): string | undefined {
  const appSupportDir = env.EDITOR_CLAUDE_RUNTIME_DIR

  // Explicit override — tests, and a manual escape hatch for a power user
  // pointing at a hand-installed binary. Honoured ONLY outside the desktop
  // app (`EDITOR_CLAUDE_RUNTIME_DIR` absent): under Desde, every spawned
  // binary must come through the verified well-known path below, and an
  // inherited env var must not be able to route around that verification —
  // Electron inherits its launch environment and passes env down to every
  // child, so treating this variable as trusted inside the desktop app
  // would let anyone who can influence the app's environment substitute an
  // arbitrary executable with no content check at all. (`child.ts` also
  // scrubs the variable from spawned children as defense in depth; this
  // branch is the class fix — it holds for grandchildren whose spawn sites
  // desktop/ does not own.)
  const override = env.EDITOR_CLAUDE_EXECUTABLE_PATH
  if (override && !appSupportDir && isExecutableFile(override)) return override

  if (!appSupportDir) return undefined // Not running under Desde — unaffected.

  let sdkVersion: string
  try {
    sdkVersion = readInstalledClaudeAgentSdkVersion(resolveFrom)
  } catch {
    // Can't determine which version to look for — fall through to the SDK's
    // own resolution/error rather than guessing a path that might belong to
    // the wrong version.
    return undefined
  }

  // FULL content verification, not a bare X_OK check (which follows
  // symlinks and says nothing about the bytes): no-follow regular-file
  // check, install-time manifest, size, and sha256 — hashed on EVERY
  // resolve, never cached (see claude-runtime-verify.ts's module doc
  // comment for the trust chain, what it does and does not defend against,
  // the residual TOCTOU window, and why a stat-identity cache is unsound;
  // measured cost is ~150ms on the real 207MB binary, once per chat turn).
  // A runtime that fails verification resolves to `undefined`, which
  // `assertClaudeRuntimeReady` below turns into a refusal — an unverified
  // binary is never handed to the SDK's spawn. (Recovery is the desktop
  // installer's job: its fast path runs this same verification and
  // reinstalls from the anchored download on any failure.)
  const runtimeDir = resolveClaudeRuntimeDir({ appSupportDir, sdkVersion })
  const verification = verifyInstalledClaudeRuntime({
    runtimeDir,
    platform: process.platform,
    sdkVersion,
  })
  return verification.ok ? verification.path : undefined
}

/** Shared across both `query()` call sites' error paths — see {@link assertClaudeRuntimeReady}. */
export const DESKTOP_CLAUDE_RUNTIME_NOT_READY_MESSAGE =
  "Desde is still setting up the AI chat runtime (a one-time download from Anthropic, " +
  "~200MB). This can take a minute on a fresh install or a slow connection. Please try again " +
  "shortly. If this persists, check your network connection and available disk space."

/**
 * Throws {@link DESKTOP_CLAUDE_RUNTIME_NOT_READY_MESSAGE} when `resolvedPath`
 * (the value {@link resolveClaudeExecutablePath} already returned this turn —
 * passed in rather than re-resolved, so callers pay the filesystem check
 * once) came back empty WHILE running under Desde
 * (`EDITOR_CLAUDE_RUNTIME_DIR` set). Both `query()` call sites call this
 * right after resolving the path and before constructing SDK options, so a
 * turn attempted before the desktop install finishes fails fast with a
 * message the user can act on, instead of letting the SDK's own spawn
 * attempt fail with "Reinstall @anthropic-ai/claude-agent-sdk…" — an
 * instruction a desktop-app user has no way to follow.
 *
 * A no-op for the terminal CLI (`EDITOR_CLAUDE_RUNTIME_DIR` unset there) and
 * for a desktop process where the runtime IS ready (`resolvedPath` is set).
 */
export function assertClaudeRuntimeReady(
  resolvedPath: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (resolvedPath === undefined && env.EDITOR_CLAUDE_RUNTIME_DIR !== undefined) {
    throw new Error(DESKTOP_CLAUDE_RUNTIME_NOT_READY_MESSAGE)
  }
}
