/**
 * Deterministic apply, then chat. Wraps `adapter.applyEdit` for the
 * structural edits (move / delete / detach / insert / swap / unwrap /
 * flatten-conditional). When the deterministic applicator refuses, the
 * refusal is handed to the chat agent as a new session, with the selector,
 * the source position and the refusal text, and the user watches it work.
 *
 * This replaced `applyEditWithLLMFallback` on 2026-09-08. That helper posted
 * a one-file repair intent to `/api/editor/llm-fallback` and wrote whatever
 * came back; the model saw one file and a line number, could not read the
 * usages, could not ask, and once deleted the wrong function. The agent has
 * the repo and `ask_user_question`.
 *
 * Pure module: no React, no status text. Callers read `handoff.started` and
 * write their own banner through `describeEditOutcome`.
 */
import type { EditResult, StructuralEdit } from "@/editor/core"
import type { BridgeFrameworkAdapter } from "@/editor/adapters/bridge"
import {
  buildStructuralEditHandoffPrompt,
  describeMoveDestination,
  type StructuralEditHandoff,
} from "@/editor/edit-service/build-edit-escalation-prompt"

export interface ChatHandoffOutcome {
  /** A hand-off was possible (the edit has a source position and a chat transport existed). */
  attempted: boolean
  /** The chat transport accepted the prompt. */
  started: boolean
  /** The deterministic refusal, kept for the status banner. */
  originalReason?: string
}

const KIND_LABELS: Record<string, string> = {
  move: "Move",
  delete: "Delete",
  detach: "Detach",
  insert: "Insert",
  swap: "Swap",
  unwrap: "Unwrap",
  "flatten-conditional": "Flatten conditional",
}

/**
 * Labels that read wrong in the prompt under their status name. An insert's
 * `target` is the destination PARENT, not the new content, so "Insert <Card>"
 * names the wrong element; "Insert into <Card>" is what happened. Status text
 * keeps the plain label, which is built at the call site, not here.
 */
const HANDOFF_LABELS: Record<string, string> = {
  insert: "Insert into",
}

/**
 * How much of an inserted snippet the prompt carries before it is cut.
 *
 * 2000, not the 200 this started at. The omitted tail exists nowhere else:
 * the deterministic applicator refused, so nothing was written, and the agent
 * has only this message to work from. At 200 characters it could not apply
 * any realistic insert faithfully. 2000 matches the cap the prompt builder
 * enforces on copied fields.
 */
const SNIPPET_LIMIT = 2000

/**
 * Refusals that are POLICY, not capability. The agent cannot fix these by
 * reading more source: a dormant lane is off by configuration, and library
 * source under `node_modules` is never an edit target. Handing one to an
 * agent told to make the edit happen invites it to work around the rule.
 *
 * Kept deliberately short. Each pattern pins a message that a colocated test
 * on the producing side already holds stable:
 *  - `lanes.<id>` from `dormantLaneRefusal` in `editor-cli/src/server/enabled-lanes.ts`
 *  - "never rewrites node_modules" from `build-edit-request.ts`
 *  - "installed library" from the iteration and llm-fallback handlers
 */
export function isPolicyRefusal(reason: string): boolean {
  return (
    /\blanes\.[a-z-]+\b/.test(reason) ||
    /never rewrites node_modules/i.test(reason) ||
    /installed library/i.test(reason)
  )
}

/**
 * The payload of the edit, in the user's voice, for the kinds where the
 * element alone does not say what was asked. `delete`, `detach` and `unwrap`
 * return undefined: for those the element IS the whole request.
 */
function detailForHandoff(edit: StructuralEdit): string | undefined {
  switch (edit.kind) {
    case "move":
      return describeMoveDestination(edit.destination.parentEditTarget, edit.destination.index)
    case "insert": {
      const snippet = edit.snippet.trim()
      const shown =
        snippet.length > SNIPPET_LIMIT
          ? `${snippet.slice(0, SNIPPET_LIMIT)}... (truncated)`
          : snippet
      const content = edit.contentKind === "text" ? `the text ${JSON.stringify(shown)}` : shown
      const where = edit.destIndex < 0 ? "at the end" : `at child index ${edit.destIndex}`
      return `insert ${content} ${where}`
    }
    case "swap":
      return `replace <${edit.fromComponentName}> with <${edit.toComponentName}>`
    case "flatten-conditional":
      return edit.branchToKeep === "else"
        ? "keep the else branch"
        : `keep branch ${edit.branchToKeep} of the conditional chain`
    default:
      return undefined
  }
}

/**
 * The hand-off description for a refused structural edit, or null when the
 * kind carries no source position (overwrite, llm-patch, prop, styles, text
 * ranges, tokens: each has its own path and none of them belongs here).
 */
export function describeStructuralEditForHandoff(
  edit: StructuralEdit,
  reason: string,
): StructuralEditHandoff | null {
  const kindLabel = KIND_LABELS[edit.kind]
  if (!kindLabel) return null
  const target = edit.target
  // The `!location` check below is the only position guard needed, and it is
  // broader than the `!target.editTarget` clause it replaces: a
  // definition-scope delete carrying an `authoredAt` but no `editTarget` has
  // a position to hand over, and used to be dropped here.
  if (!target) return null
  const scope = edit.kind === "delete" ? (edit.scope ?? "definition") : null
  // No `?? target.editTarget` fallback for definition scope. `editTarget` is
  // the CALLSITE, so the fallback labelled a callsite position "the
  // component's own file" and sent the agent to the wrong place. The adapter
  // refuses that edit anyway ("DeleteEdit requires target.authoredAt"), so a
  // plain failure status is the honest outcome.
  const location = scope === "definition" ? target.authoredAt : target.editTarget
  if (!location) return null
  return {
    kindLabel: HANDOFF_LABELS[edit.kind] ?? kindLabel,
    detail: detailForHandoff(edit),
    componentName: target.componentName ?? null,
    tagName: null,
    selector: target.selector,
    location: { file: location.file, line: location.line, column: location.column },
    scope,
    reason,
  }
}

export async function applyEditWithChatHandoff(
  edit: StructuralEdit,
  adapter: Pick<BridgeFrameworkAdapter, "applyEdit">,
  // Asynchronous, and awaited below. The hand-off is an HTTP POST that starts
  // a chat turn, and the server can refuse it after the client-side guard has
  // already said yes. A synchronous `true` here was a promise the transport
  // had not made, and every caller cleared its buffer on it.
  handOff: ((prompt: string) => Promise<boolean>) | undefined,
): Promise<{ result: EditResult; handoff: ChatHandoffOutcome }> {
  const initial = await adapter.applyEdit(edit)
  if (initial.kind !== "failed") {
    return { result: initial, handoff: { attempted: false, started: false } }
  }
  // A policy refusal is not something the agent can read its way out of, and
  // the hand-off tells the agent to make the edit happen. Report it as a
  // plain failure instead.
  if (isPolicyRefusal(initial.reason)) {
    return { result: initial, handoff: { attempted: false, started: false, originalReason: initial.reason } }
  }
  const described = describeStructuralEditForHandoff(edit, initial.reason)
  if (!described || !handOff) {
    return { result: initial, handoff: { attempted: false, started: false, originalReason: initial.reason } }
  }
  const started = await handOff(buildStructuralEditHandoffPrompt(described))
  return { result: initial, handoff: { attempted: true, started, originalReason: initial.reason } }
}
