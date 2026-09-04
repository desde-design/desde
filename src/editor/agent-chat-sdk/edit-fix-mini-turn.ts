/**
 * Headless "edit-fix" mini-turn (WS4, tasks/edit-pipeline-rearchitecture.md).
 *
 * Replaces the one-shot source-aware LLM fallback for refused prop edits.
 * When a deterministic applicator refuses with a PropEditFallbackHint
 * (bound-binding / v-model / dynamic-vbind), the edit handler runs a
 * budget-bounded turn — Read/Grep to trace the binding (cross-file
 * included), the manifest/token tools for design-system grounding,
 * Edit/Write to land the fix.
 *
 * Runs on the SAME runtime chat uses for the project's default provider —
 * the CLI caller resolves it through `resolveChatRuntime` and hands it in
 * as `deps.runTurn`. That closes the "the fallback failed but asking chat
 * worked" gap by construction, and it closes a second one: an OpenAI-only
 * customer's prop-edit fallback no longer reaches for Anthropic
 * credentials they never provided.
 *
 * Headless mechanics (proven by tasks/scripts/agent-live-smoke.mts):
 *  - stub BridgeClient (no shell round-trips; selection/page reads return
 *    null; verify_edit degrades to skipped),
 *  - throwaway in-memory session, never saveSession'd (no chat-tab
 *    pollution), Read-snapshot sidecar dir removed on completion,
 *  - no-op emit (no SSE, no transcript),
 *  - awaitEditAck omitted → SDK Write/Edit apply directly.
 *
 * Write safety (audit Task 13). SDK built-in writes still bypass
 * FileLockManager — they execute inside the SDK runtime — but they are no
 * longer unjournalled: `run-chat-turn-sdk`'s PreToolUse write guard
 * (`sdk-write-guard.ts`) backs the original up to `.desde/backups/`
 * before each one. What this lane deliberately does NOT get is the guard's
 * per-file EDIT LOCK: `runChatTurnSdk` only takes it when a caller injects
 * `acquireWriteLock`, and we pass none, because the CLI edit route already
 * re-enters under the EXCLUSIVE tree gate (`withTreeLock`) before running the
 * mini-turn — acquiring the SHARED gate from inside that exclusive holder
 * would deadlock against ourselves. Exclusivity gives this lane strictly
 * stronger serialization than a per-file lock would, and the handler keeps
 * owning pre/post `git status` snapshots, the no-op guard, and rollback.
 *
 * Budget: maxTurns + costCeilingUsd + a wall-clock AbortController. The
 * caller (edit-handler) blocks the HTTP request on this, same as the old
 * one-shot lane's 5–95s Opus rewrite — comparable wall-clock, far higher
 * hit rate.
 *
 * Outcome contract: the prompt instructs a final line of
 * `EDIT_APPLIED: <summary>` or `EDIT_REFUSED: <reason>`. The caller must
 * NOT trust EDIT_APPLIED alone — it re-checks the working tree actually
 * changed (no-op guard at the handler level).
 */

import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { makeEmptySession } from '../agent-chat/types'
import type { PropEditFallbackHint } from '../edit-service/apply-prop-edit'
import type { ProjectKnowledge } from '../core/project-knowledge'
import type { RunChatTurn, RunChatTurnOpts, RunChatTurnResult } from '../agent-chat/run-chat-turn'
import { runChatTurnSdk } from './run-chat-turn-sdk'

export interface EditFixMiniTurnInput {
  repoRoot: string
  /** Repo-relative path of the file whose prop edit was refused. */
  file: string
  line: number
  column: number
  propName: string
  newValue: string
  /** The deterministic applicator's refusal. */
  fallback: PropEditFallbackHint
  deterministicReason: string
  projectKnowledge?: ProjectKnowledge
  /** Design-system grounding provider — same object the chat route uses. */
  getGrounding?: RunChatTurnOpts['getGrounding']
  /**
   * Headless Playwright review surface (process-local, driven against the
   * CLI's own prototype URL). When present, the agent's verify_edit does a
   * GENUINE rendered-DOM check instead of degrading to skipped — the
   * honest post-fix verification the one-shot lane never had. Caller owns
   * dispose().
   */
  reviewSurface?: RunChatTurnOpts['reviewSurface']
  /** Wall-clock cap. Default 90s. */
  timeoutMs?: number
  /** SDK conversation-turn cap. Default 12. */
  maxTurns?: number
  /** Dollar ceiling for the turn. Default 1.0. */
  costCeilingUsd?: number
  /**
   * Model for the mini-turn. Omitted lets the resolved runtime pick its own
   * default, which is the right answer when the caller has no opinion. The CLI
   * caller DOES have one: it passes the default model of the project's default
   * provider, because a Claude model id sent to OpenAI is a 400 deep inside a
   * save flow.
   */
  model?: string
  /**
   * Provider the resolved runtime belongs to. Carried so the runtime can reach
   * its own descriptor for effort mapping and error copy. Purely informational
   * to this module: WHICH runtime runs is decided by `deps.runTurn`, and this
   * field never picks one.
   */
  providerId?: string
}

export interface EditFixMiniTurnResult {
  /**
   * 'applied'/'refused' — the agent's explicit verdict. 'no-verdict' — the
   * turn ended without a sentinel line; the CALLER's file-diff decides
   * (changes landed and validate → accept; nothing changed → refuse).
   * Errors/timeouts report 'refused' — partial work from an interrupted
   * turn can't be trusted and must roll back.
   */
  outcome: 'applied' | 'refused' | 'no-verdict'
  /** EDIT_APPLIED summary / EDIT_REFUSED reason (or a synthesized one). */
  notes: string
}

/**
 * Tools stripped from the mini-turn's context. Interactive tools would
 * stall with no UI to answer; structural/scaffolding tools are out of
 * scope for "fix one refused prop edit"; propose_prop_edit is a DOM
 * overlay, not a source write — an agent reaching for it here would
 * "succeed" without changing any file.
 */
const MINI_TURN_DISALLOWED_TOOLS = [
  'mcp__editor__ask_user_question',
  'mcp__editor__propose_prop_edit',
  'mcp__editor__insert_component',
  'mcp__editor__insert_element',
  'mcp__editor__scaffold_route',
  'mcp__editor__delete_file',
  'mcp__editor__rename_file',
  'mcp__editor__manage_package',
  'mcp__editor__save_screenshot_plan',
  'mcp__editor__heal_plan_step',
  'mcp__editor__pin_selections',
  'mcp__editor__session_diff',
  'mcp__editor__session_status',
]

const MINI_TURN_BUILTIN_TOOLS = ['Read', 'Edit', 'Write', 'Glob', 'Grep']

function describeHint(hint: PropEditFallbackHint): string {
  switch (hint.kind) {
    case 'bound-binding':
      return `the prop is bound to the expression \`${hint.expression}\` — the value must change at the binding's SOURCE (a ref/computed/store/prop default, possibly in another file), not by overwriting the binding`
    case 'v-model':
      return 'the prop is supplied by a v-model two-way binding — change the bound state at its source, never replace the directive with a literal'
    case 'dynamic-vbind':
      return 'the element carries a v-bind spread or dynamic-key binding — find where that object/key is defined and change the value there'
  }
}

function buildPrompt(input: EditFixMiniTurnInput): string {
  return [
    `A designer changed a prop in the visual editor, but the deterministic edit pipeline refused to splice it because the source is not a literal. Land the change in source for them.`,
    ``,
    `Target: prop \`${input.propName}\` on the element at ${input.file}:${input.line}:${input.column}`,
    `Desired value: ${JSON.stringify(input.newValue)}`,
    `Why the deterministic lane refused: ${input.deterministicReason}`,
    `Refusal kind: ${input.fallback.kind} — ${describeHint(input.fallback)}`,
    ``,
    `Rules:`,
    `- Trace the binding to where the VALUE actually lives (same file or another) and change it there. Preserve the binding structure — do not replace expressions with literals unless the expression is itself a self-contained literal.`,
    `- If the bound value is used in multiple places and changing it would visibly affect more than this element, prefer the narrowest correct change; if there is no unambiguous narrow change, refuse.`,
    `- Use the design-system grounding tools when the value must match component APIs or tokens.`,
    `- Make the smallest change that achieves the designer's intent. No refactors, no formatting churn.`,
    `- After your change, if the verify_edit tool is available, use it to confirm the element now renders the desired value, and mention the verification result in your summary.`,
    `- End your reply with exactly one line: \`EDIT_APPLIED: <one-line summary of what changed and where>\` or \`EDIT_REFUSED: <one-line reason>\`.`,
  ].join('\n')
}

/** Stub bridge: no shell attached — selection/page reads return null and
 *  anything else resolves null (verify_edit degrades to skipped). */
function makeStubBridge(): RunChatTurnOpts['bridge'] {
  return {
    send: async () => null,
  } as unknown as RunChatTurnOpts['bridge']
}

export async function runEditFixMiniTurn(
  input: EditFixMiniTurnInput,
  deps: { runTurn?: RunChatTurn } = {},
): Promise<EditFixMiniTurnResult> {
  const runTurn = deps.runTurn ?? runChatTurnSdk
  const sessionId = `mini-edit-fix-${randomUUID().slice(0, 8)}`
  const controller = new AbortController()
  const timeout = setTimeout(
    () => controller.abort(new Error('edit-fix mini-turn timed out')),
    input.timeoutMs ?? 90_000,
  )

  try {
    const result = await runTurn({
      bridge: makeStubBridge(),
      worktreeRoot: input.repoRoot,
      session: makeEmptySession(sessionId, sessionId),
      userMessage: buildPrompt(input),
      emit: () => {},
      projectKnowledge: input.projectKnowledge,
      getGrounding: input.getGrounding,
      reviewSurface: input.reviewSurface,
      signal: controller.signal,
      maxTurns: input.maxTurns ?? 12,
      costCeilingUsd: input.costCeilingUsd ?? 1.0,
      builtinTools: MINI_TURN_BUILTIN_TOOLS,
      disallowedTools: MINI_TURN_DISALLOWED_TOOLS,
      model: input.model,
      providerId: input.providerId,
      // The write guard must NOT record undo history for this lane's writes
      // — they're provisional until the CLI handler's post-turn validation
      // passes; a refused/unparseable outcome rolls them back via
      // `cleanupAllWrites`, which would leave a guard-recorded step whose
      // "after" bytes never existed durably. The handler records its own
      // consolidated step on success instead (see `recordHistory` on
      // `RunChatTurnOpts`).
      recordHistory: false,
    })
    const text = finalAssistantText(result)
    const applied = text.match(/^EDIT_APPLIED:\s*(.+)$/m)
    if (applied) return { outcome: 'applied', notes: applied[1].trim() }
    const refused = text.match(/^EDIT_REFUSED:\s*(.+)$/m)
    if (refused) return { outcome: 'refused', notes: refused[1].trim() }
    // No sentinel — hand the decision to the caller's file-diff (codex
    // round-12: a correct fix must not be rolled back over the agent's
    // final-line formatting).
    return {
      outcome: 'no-verdict',
      notes: 'Agent ended without an EDIT_APPLIED/EDIT_REFUSED verdict.',
    }
  } catch (err) {
    return {
      outcome: 'refused',
      notes: `Agent mini-turn error: ${(err as Error).message}`,
    }
  } finally {
    clearTimeout(timeout)
    // Read-snapshot sidecars accumulate under the throwaway session dir
    // regardless of saveSession — remove them BEFORE returning (awaited:
    // the caller snapshots git status immediately after, and in a repo
    // where .desde/ isn't gitignored a lingering sidecar would count
    // as a "change" and defeat the no-op guard — codex follow-up P2).
    await rm(join(input.repoRoot, '.desde', 'chat-sessions', sessionId), {
      recursive: true,
      force: true,
    }).catch(() => {})
  }
}

function finalAssistantText(result: RunChatTurnResult): string {
  // ChatTurn.assistantContent interleaves text and tool-use blocks in
  // stream order; the sentinel line is in the trailing text blocks.
  const blocks = (result.turn.assistantContent ?? []) as Array<{ text?: unknown }>
  return blocks
    .map((b) => (typeof b.text === 'string' ? b.text : ''))
    .filter((t) => t.length > 0)
    .join('\n')
}
