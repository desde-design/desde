/**
 * The SDK lane's enforcement point for the secret-read policy.
 *
 * ## Why this exists rather than only the gate
 *
 * `buildToolPermissionGate` (`edit-ack.ts`) is the shared policy, and the
 * neutral lane reaches it for every tool including Read. **The SDK lane does
 * not.** Under `permissionMode: 'default'` the Claude Agent SDK auto-allows
 * Read without invoking `canUseTool` at all — that is not a guess, it is the
 * measured fact `file-read-snapshot.ts` was written around, and the reason
 * that module snapshots reads from a `PreToolUse` hook instead of from the
 * permission callback.
 *
 * So a read policy that lived only in the gate would be enforced on one lane
 * and decorative on the other. That is the shape the FX15 brief called
 * theatre. `PreToolUse` fires for EVERY tool, and it fires BEFORE the
 * permission system (`sdk-write-guard.ts` verified that against the installed
 * SDK), so a deny returned here is the earliest and the only reliable refusal
 * on this lane.
 *
 * ## What it does NOT do
 *
 * It refuses whole calls. It cannot filter results, because `PreToolUse` runs
 * before the tool. On the SDK lane a broad `Glob` that happens to enumerate
 * `.env` therefore still reports the NAME — the neutral lane, which owns its
 * own Glob, omits it with a note. Names are not contents, and the content
 * paths (Read, and a Grep scoped at the file) are both closed here. That
 * residual difference is stated rather than papered over; closing it would
 * mean rewriting the SDK's tool output from a `PostToolUse` hook, which
 * depends on an output shape the SDK does not contract.
 *
 * The gate keeps its own copy of the same check. That is the both-ends rule,
 * not redundancy: this hook is registered per turn in `run-chat-turn-sdk.ts`,
 * and a future caller that constructs a query without it must still hit the
 * policy somewhere.
 */

import type { HookCallback, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk'

import { resolveRepoPath } from '../agent-tools/read-tools'
import {
  globPatternTargetsSecret,
  isSecretAgentPath,
  secretPathDenial,
} from './protected-paths'

export interface SecretReadGuardOptions {
  /** Absolute path to the worktree the SDK is running against. */
  worktreeRoot: string
  /**
   * The per-project override. Default OFF — an omitted value refuses, on the
   * same `=== true` discipline as every other opt-in gate in the product.
   */
  allowSecretReads?: boolean
}

/** Deny this tool call, with a reason written to be read by the model. */
function deny(reason: string) {
  return {
    continue: true,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse' as const,
      permissionDecision: 'deny' as const,
      permissionDecisionReason: reason,
    },
  }
}

const ALLOW = { continue: true } as const

/**
 * A `PreToolUse` hook for matcher `Read|Glob|Grep` that refuses to let the
 * agent read a credential.
 *
 * Register it in `run-chat-turn-sdk.ts` alongside the read-snapshot hook. The
 * two are independent: the snapshot hook observes and always continues, this
 * one decides.
 */
export function createSecretReadGuard(opts: SecretReadGuardOptions): HookCallback {
  return async (input) => {
    if (opts.allowSecretReads === true) return ALLOW
    if (input.hook_event_name !== 'PreToolUse') return ALLOW
    const pre = input as PreToolUseHookInput
    const toolInput = (pre.tool_input ?? {}) as {
      file_path?: unknown
      pattern?: unknown
      glob?: unknown
      path?: unknown
    }

    if (pre.tool_name === 'Read') {
      const filePath = toolInput.file_path
      if (typeof filePath !== 'string' || filePath.length === 0) return ALLOW
      if (isSecretAgentPath(filePath)) return deny(secretPathDenial(filePath))
      // The realpath'd target as well as the model's spelling: an in-repo
      // symlink (`docs/notes.md` -> `.env`) passes containment, because the
      // link and its target are both inside the repository. Best-effort —
      // a path that cannot be resolved has already been refused by the name
      // check above or is not a secret by name, and this hook must never
      // throw into the SDK's tool path.
      try {
        const safe = await resolveRepoPath(opts.worktreeRoot, filePath)
        if (safe.ok && isSecretAgentPath(safe.absolute)) {
          return deny(secretPathDenial(filePath))
        }
      } catch {
        // Fall through: the name check is the policy, this is the extra.
      }
      return ALLOW
    }

    if (pre.tool_name === 'Glob' || pre.tool_name === 'Grep') {
      // For Glob, `pattern` IS the path pattern. For Grep it is the regular
      // expression and the path scope is `glob` / `path`, so Grep's `pattern`
      // is deliberately not tested against a path policy.
      const scopes = [
        pre.tool_name === 'Glob' ? toolInput.pattern : undefined,
        toolInput.glob,
        toolInput.path,
      ]
      for (const scope of scopes) {
        if (typeof scope === 'string' && globPatternTargetsSecret(scope)) {
          return deny(secretPathDenial(scope, 'search'))
        }
      }
      return ALLOW
    }

    return ALLOW
  }
}
