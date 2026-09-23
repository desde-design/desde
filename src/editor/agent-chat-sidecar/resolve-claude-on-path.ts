/**
 * Locates the `claude` binary this dev-only sidecar spawns.
 *
 * The Claude Agent SDK lane is a dev sidecar now, not a distributed runtime.
 * There is no bundled binary, no desktop-managed install directory, and no
 * integrity verification to run: whatever `claude` a developer has installed
 * on their own machine (Claude Code, via `npm install -g @anthropic-ai/
 * claude-code` or the native installer) is the one this process spawns. That
 * replaces the old `EDITOR_CLAUDE_RUNTIME_DIR`-keyed resolver
 * (`resolve-claude-executable.ts`, deleted alongside this file's
 * introduction), which looked for a binary the desktop app had downloaded
 * and verified into a version-keyed app-support directory — desktop no
 * longer ships that installer.
 *
 * No SDK import here on purpose: this module is on the boot graph through
 * `isClaudeOnPath` (the credential-ladder presence check that runs on every
 * settings-menu status GET), and pulling in `@anthropic-ai/claude-agent-sdk`
 * there would put the SDK on every boot regardless of provider (see M1,
 * `llm-boot-graph-sdk-laziness.test.ts`).
 */

import { accessSync, constants as fsConstants, statSync } from "node:fs"
import { delimiter as pathDelimiter, join as joinPath } from "node:path"

/**
 * Shown when neither the override nor a `PATH` walk finds an executable
 * `claude`. The Claude-subscription path has nothing to spawn without it.
 */
export const SIDECAR_NO_BINARY_MESSAGE =
  "The Claude subscription path needs the claude command line tool on your PATH. Install Claude Code, or turn EDITOR_USE_CLAUDE_SUBSCRIPTION off and add an API key from the settings gear."

/**
 * `accessSync(X_OK)` alone says nothing about what KIND of thing is at
 * `path` — a directory named `claude` (which `PATH` can easily contain,
 * e.g. a build output dir, a git worktree, an unrelated package) is
 * executable-bit-set by convention (that bit means "traversable" for a
 * directory) and would pass an access-only check, then fail when the SDK
 * actually tries to spawn it. `statSync(path).isFile()` rules that out
 * before the caller commits to this candidate; any stat error (missing,
 * permission denied, a broken symlink) is treated the same as "not it" so
 * the `PATH` walk continues to the next entry instead of throwing.
 */
function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, fsConstants.X_OK)
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** `claude` everywhere except win32, where a `PATH` walk must also try the two extensions Windows actually installs a CLI shim as. */
function candidateFileNames(platform: NodeJS.Platform): string[] {
  return platform === "win32" ? ["claude.exe", "claude.cmd"] : ["claude"]
}

/**
 * Finds the `claude` executable this process should spawn.
 *
 * `EDITOR_CLAUDE_EXECUTABLE_PATH` wins first — a manual escape hatch for a
 * developer pointing at a specific binary (tests use it the same way). Its
 * only requirement is that the path names an executable file; unlike the old
 * desktop-app resolver, there is no runtime-dir gate on when this override is
 * honoured, because there is no longer a well-known verified path to route
 * around. (The old resolver's "ignore the override while a runtime dir is
 * set" guard defended against an INHERITED override letting a caller skip
 * verification of a bundled runtime — there is no verification left to skip.
 * The desktop app now sets this variable deliberately, to the path its own
 * installer already verified — see `desktop/child.ts` — and scrubs any
 * value it inherited from its own launch environment before doing so, which
 * is the equivalent protection in the new shape: this module trusts
 * whatever value is in `env` because the one caller who sets it on purpose
 * is also the one who cleans up anyone else's attempt to.)
 *
 * Otherwise walks `env.PATH`, split on the platform's `path.delimiter`,
 * checking each directory for an executable `claude` (or, on win32,
 * `claude.exe` / `claude.cmd`) — the same thing a shell's own `which`/`where`
 * does, deliberately: this IS the developer's own installed Claude Code, not
 * a runtime Desde manages.
 *
 * @param env Defaults to `process.env`. Overridable for tests.
 * @returns The absolute path to the resolved binary, or `undefined` when
 *   nothing on `PATH` (and no valid override) names one.
 */
export function resolveClaudeOnPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const override = env.EDITOR_CLAUDE_EXECUTABLE_PATH
  if (override && isExecutableFile(override)) return override

  const pathVar = env.PATH
  if (!pathVar) return undefined

  const names = candidateFileNames(process.platform)
  for (const dir of pathVar.split(pathDelimiter)) {
    if (dir.length === 0) continue
    for (const name of names) {
      const candidate = joinPath(dir, name)
      if (isExecutableFile(candidate)) return candidate
    }
  }
  return undefined
}

/** Presence check for the credential ladder's subscription rung. See {@link resolveClaudeOnPath}. */
export function isClaudeOnPath(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveClaudeOnPath(env) !== undefined
}
