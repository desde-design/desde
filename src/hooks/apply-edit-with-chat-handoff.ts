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

/** How much of an inserted snippet the prompt carries before it is cut. */
const SNIPPET_LIMIT = 200

function locationText(l: { file: string; line: number; column: number }): string {
  return `${l.file}:${l.line}:${l.column}`
}

/**
 * The payload of the edit, in the user's voice, for the kinds where the
 * element alone does not say what was asked. `delete`, `detach` and `unwrap`
 * return undefined: for those the element IS the whole request.
 */
function detailForHandoff(edit: StructuralEdit): string | undefined {
  switch (edit.kind) {
    case "move": {
      const parent = edit.destination.parentEditTarget
      if (!parent) return "move it within the page"
      const at = `the element at ${locationText(parent)}`
      return edit.destination.index < 0
        ? `append it to ${at}`
        : `move it to be child index ${edit.destination.index} of ${at}`
    }
    case "insert": {
      const snippet = edit.snippet.trim()
      const shown = snippet.length > SNIPPET_LIMIT ? `${snippet.slice(0, SNIPPET_LIMIT)}...` : snippet
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
  const location = scope === "definition" ? (target.authoredAt ?? target.editTarget) : target.editTarget
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
  handOff: ((prompt: string) => boolean) | undefined,
): Promise<{ result: EditResult; handoff: ChatHandoffOutcome }> {
  const initial = await adapter.applyEdit(edit)
  if (initial.kind !== "failed") {
    return { result: initial, handoff: { attempted: false, started: false } }
  }
  const described = describeStructuralEditForHandoff(edit, initial.reason)
  if (!described || !handOff) {
    return { result: initial, handoff: { attempted: false, started: false, originalReason: initial.reason } }
  }
  const started = handOff(buildStructuralEditHandoffPrompt(described))
  return { result: initial, handoff: { attempted: true, started, originalReason: initial.reason } }
}
