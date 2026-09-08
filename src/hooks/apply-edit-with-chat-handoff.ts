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
  if (!target || !("editTarget" in target) || !target.editTarget) return null
  const scope = edit.kind === "delete" ? (edit.scope ?? "definition") : null
  const location =
    scope === "definition"
      ? ("authoredAt" in target ? target.authoredAt : undefined) ?? target.editTarget
      : target.editTarget
  if (!location) return null
  return {
    kindLabel,
    componentName: "componentName" in target ? (target.componentName ?? null) : null,
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
