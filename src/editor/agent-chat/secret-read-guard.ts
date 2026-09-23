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
 * before the tool. On the SDK lane a `Glob` that enumerates `.env` therefore
 * reports the NAME — the neutral lane, which owns its own Glob, omits it with
 * a note. Names are not contents, and every path that returns contents is
 * closed here instead of filtered.
 *
 * **That is what FX17 item 3b had to fix, and the old wording of this
 * paragraph is why it was missed.** It said "the content paths (Read, and a
 * Grep scoped at the file) are both closed here", which quietly assumed a
 * content-returning Grep is always scoped at a file. It is not: `Grep` in
 * `output_mode: "content"` with no `glob` and no `path` returns matching
 * LINES from the whole tree, `.env` included, and every branch above passed
 * it. A content-mode Grep is now refused unless its scope is provably free of
 * credential files — see `grepContentScopeIsSecretFree`, which can prove that
 * for exactly one shape, a `path` naming a single non-credential file.
 *
 * **FX20 item 1 narrowed the name paragraph above from "a broad Glob" to any
 * Glob.** Until then this hook also refused a pattern an analyser judged to
 * be AIMED at a credential name, and that analysis is gone. It decided reach
 * by SPELLING, and glob syntax has unbounded spellings for identical reach:
 * an independent measurement found seven of eight brace and character-class
 * spellings of a secret directory passing where the literal spelling was
 * refused, and five consecutive review rounds each bought exactly one more
 * spelling. Keeping it would have left a rule that reads like a control and
 * is not one.
 *
 * So on this lane, name-level enumeration of credential files is NOT refused,
 * for any pattern. What would close it is not a better pattern test but a
 * `PostToolUse` filter on Glob's OUTPUT, which is a list of paths and can be
 * filtered exactly, per resolved path, the way the neutral lane already
 * filters its own. That is a real option — the installed SDK contracts
 * `updatedToolOutput` — and it is not taken here only because the same
 * mechanism cannot be trusted for Grep, where deciding which line came from
 * which file is a parse, and a parse that is wrong serves the credential it
 * was meant to remove. A refusal costs the model one round trip and cannot be
 * wrong in that direction, which is why Grep's content shape is refused
 * rather than redacted.
 *
 * The gate keeps its own copy of the same check. That is the both-ends rule,
 * not redundancy: this hook is registered per turn in `run-chat-turn-sdk.ts`,
 * and a future caller that constructs a query without it must still hit the
 * policy somewhere.
 */

import type { HookCallback, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk'

import { resolveRepoPath } from '../agent-tools/read-tools'
import { isSecretAgentPath, secretPathDenial } from './protected-paths'
import {
  editorToolSecretRefusal,
  grepContentDenial,
  grepContentScopeIsSecretFree,
} from './secret-scope'

export interface SecretReadGuardOptions {
  /** Absolute path to the worktree the SDK is running against. */
  worktreeRoot: string
  /**
   * The per-project setting. Default OFF — an omitted value blocks nothing,
   * on the same `=== true` discipline as every other opt-in gate in the
   * product. When it is off this hook allows every call it sees, which is
   * what the Editor did before the policy existed.
   */
  blockSecretReads?: boolean
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
 * A `PreToolUse` hook that refuses to let the agent read a credential.
 *
 * Register it in `run-chat-turn-sdk.ts` alongside the read-snapshot hook,
 * with NO matcher: it covers the built-in read tools and Editor's own
 * `mcp__editor__*` tools, and a matcher list is the thing that left the
 * second group out until FX17. It returns allow immediately for any tool it
 * has no rule for. The two hooks are independent: the snapshot hook observes
 * and always continues, this one decides.
 */
export function createSecretReadGuard(opts: SecretReadGuardOptions): HookCallback {
  return async (input) => {
    if (opts.blockSecretReads !== true) return ALLOW
    if (input.hook_event_name !== 'PreToolUse') return ALLOW
    const pre = input as PreToolUseHookInput
    const toolInput = (pre.tool_input ?? {}) as {
      file_path?: unknown
      pattern?: unknown
      glob?: unknown
      path?: unknown
      output_mode?: unknown
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
      // A pattern AIMED at a credential file used to be refused here by a
      // glob analyser. FX20 item 1 removed it — see the module header's
      // "What it does NOT do", which now says what that leaves. Contents
      // are still closed on this lane by the content-mode rule below; what
      // an aimed pattern can reach is a NAME, which a broad pattern could
      // already reach and which no `PreToolUse` hook can filter out.
      if (pre.tool_name === 'Grep' && toolInput.output_mode === 'content') {
        const free = await grepContentScopeIsSecretFree(opts.worktreeRoot, toolInput)
        if (!free) return deny(grepContentDenial())
      }
      return ALLOW
    }

    // FX17 item 4 + item 5. Editor's own tools are namespaced
    // `mcp__editor__*` and this hook used to be registered for
    // `Read|Glob|Grep` only, so `read_file_at_commit`, `diff_file`,
    // `session_diff` and `rename_file` reached neither guard. It is now
    // registered UNMATCHED — see `run-chat-turn-sdk.ts` — which is why this
    // branch is reachable at all. FX19 item 2: the SCOPED forms of those
    // were covered; `session_diff` with no `path` was not, and this comment
    // claimed it was.
    if (pre.tool_name.startsWith('mcp__editor__')) {
      const refusal = await editorToolSecretRefusal(opts.worktreeRoot, pre.tool_input)
      if (refusal !== null) return deny(refusal)
      return ALLOW
    }

    return ALLOW
  }
}
