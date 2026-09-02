/**
 * `PostToolUse` SDK hook that deterministically replays each successful
 * built-in `Write` / `Edit` into the Vite dev pipeline via the CLI's
 * `invalidateFiles` callback (→ `invalidateViteModules`).
 *
 * Why: Vite only re-serves a file when its watcher fires, and the OS
 * watcher (fsevents/chokidar) can coalesce, delay, or drop events under
 * load — leaving the dev server serving the STALE cached transform even
 * though the file on disk is correct. The CLI edit handler and the
 * editor MCP structural tools (insert_component, scaffold_route, …)
 * already invalidate deterministically after their own writes; the SDK's
 * built-in Write/Edit are executed inside the Agent SDK where no handler
 * of ours runs, so this hook is the interception point. Matters most for
 * the agent's own edit→verify loop: verify_edit / capture_screenshot run
 * seconds after the write, exactly when a lost watcher event makes the
 * edit look like it "didn't take".
 *
 * Why PostToolUse (not canUseTool): canUseTool fires BEFORE the SDK
 * writes; invalidating there would replay the OLD content. PostToolUse
 * fires only after a successful tool execution (failures route to
 * PostToolUseFailure), so this hook never invalidates for a write that
 * didn't happen.
 *
 * Best-effort: any error is swallowed after a console.warn — the OS
 * watcher remains the backstop, and a missed invalidation must never
 * fail the agent's turn.
 */

import { promises as fs } from 'node:fs'
import { isAbsolute, relative as relativePath, resolve as resolvePath } from 'node:path'

import type { HookCallback, PostToolUseHookInput } from '@anthropic-ai/claude-agent-sdk'
import { isRootEscape } from './root-escape'

export interface WriteInvalidateHookOptions {
  /** Absolute path of the repo root the SDK is editing (branch mode: the user's working tree). */
  worktreeRoot: string
  /** The CLI's Vite-invalidation callback; called with repo-relative paths. */
  invalidateFiles: (files: string[]) => void
}

/**
 * Build a `PostToolUse` hook callback. Register under
 * `hooks: { PostToolUse: [{ matcher: 'Write|Edit', hooks: [cb] }] }` in
 * the SDK's `query()` options.
 */
export function createWriteInvalidateHook(
  opts: WriteInvalidateHookOptions,
): HookCallback {
  // Canonicalize the root once, lazily — the containment check below
  // compares realpath'd file paths against it, so a symlinked repo root
  // (or macOS's /var → /private/var alias) must be canonicalized too or
  // every valid in-repo edit would look like an escape and be skipped.
  let rootRealPromise: Promise<string> | undefined
  const rootReal = (): Promise<string> => {
    rootRealPromise ??= fs.realpath(opts.worktreeRoot).catch(() => opts.worktreeRoot)
    return rootRealPromise
  }
  return async (input) => {
    if (input.hook_event_name !== 'PostToolUse') {
      return { continue: true }
    }
    const post = input as PostToolUseHookInput
    if (post.tool_name !== 'Write' && post.tool_name !== 'Edit') {
      return { continue: true }
    }
    const toolInput = post.tool_input as { file_path?: unknown } | undefined
    const filePath = toolInput?.file_path
    if (typeof filePath !== 'string' || filePath.length === 0) {
      return { continue: true }
    }
    try {
      const rel = await resolveRepoRelative(await rootReal(), filePath)
      if (rel !== null) {
        opts.invalidateFiles([rel])
      }
    } catch (err) {
      console.warn(
        `[editor-sdk] vite invalidation threw for ${filePath}: ${(err as Error).message}`,
      )
    }
    return { continue: true }
  }
}

/**
 * Resolve `filePath` against the CANONICALIZED repo root and return a
 * repo-relative path for `invalidateViteModules` (which resolves
 * against the repo root, then emits both the joined path and its
 * realpath). Follows symlinks on the file first because the SDK's
 * Write follows them transparently — invalidating only the link path
 * would leave the real target's module stale.
 *
 * Returns null when the resolved path escapes the repo (canUseTool
 * should have refused the write already; treat as "nothing to do").
 */
async function resolveRepoRelative(
  worktreeRoot: string,
  filePath: string,
): Promise<string | null> {
  const abs = isAbsolute(filePath) ? filePath : resolvePath(worktreeRoot, filePath)
  let real: string
  try {
    real = await fs.realpath(abs)
  } catch {
    real = abs
  }
  const rel = relativePath(worktreeRoot, real)
  // `isRootEscape` (shared with `edit-ack.ts`'s `toRel` and
  // `sdk-write-guard.ts`'s `toRepoRelative`, which this function
  // "mirrors" per the doc comment above) checks BOTH separator forms
  // explicitly — this used to be a hardcoded POSIX `'../'` literal only,
  // which never matches `path.relative`'s native `\`-separated output on
  // Windows (Task 14 review round-3 P2, found auditing this function's
  // sibling). Lower severity here — this is a best-effort Vite
  // invalidation, not a gate on a read/write — but the same gap.
  if (isRootEscape(rel) || isAbsolute(rel)) {
    return null
  }
  return rel
}
