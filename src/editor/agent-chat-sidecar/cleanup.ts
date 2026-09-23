/**
 * Cleanup of SDK-runtime artifacts when a worktree session is
 * discarded. The SDK persists conversation history as JSONL at
 * `.claude/projects/<encoded-cwd>/<sdk-session-id>.jsonl`. Without
 * explicit cleanup the file orphans in the user's home directory
 * after the worktree it references is deleted — harmless in
 * isolation, but accumulates over time and can confuse `resume` if
 * a new session reuses an encoded-cwd that happens to collide.
 *
 * We call the SDK's exported `deleteSession()` (per Phase 3 Codex
 * round-1 note) rather than rolling our own JSONL path — the SDK
 * owns the cwd-encoding scheme and changing it between versions
 * would silently break a hand-rolled cleanup.
 */

import { deleteSession } from '@anthropic-ai/claude-agent-sdk'

import { loadSession } from '../agent-chat/session-store'

/**
 * Best-effort cleanup of the SDK's conversation JSONL for a worktree
 * being discarded. Never throws — discard must succeed even if the
 * cleanup fails (e.g. SDK JSONL never existed because the first SDK
 * turn errored before init).
 */
export async function cleanupSdkSession(worktreeRoot: string): Promise<void> {
  let sdkSessionId: string | undefined
  try {
    const result = await loadSession(worktreeRoot)
    sdkSessionId = result.session.sdkSessionId
  } catch {
    // Session file unreadable — nothing to do
    return
  }
  if (!sdkSessionId) return
  try {
    await deleteSession(sdkSessionId, { dir: worktreeRoot })
  } catch {
    // SDK JSONL absent (init failed early) or path-encoding drift —
    // non-fatal. The discard proceeds.
  }
}
