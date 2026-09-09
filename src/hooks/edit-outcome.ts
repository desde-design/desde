/**
 * Status-banner copy for the eleven `applyEditWithChatHandoff(edit, adapter,
 * handOff).then(({ result, handoff }) => ...)` call sites in
 * `useEditorEditing` (handleLayerMove, handleDragMove, handleSwapConfirm,
 * handlePickIcon, handleDetach, handleLayerInsert, handleInsertAtPoint,
 * dispatchDeleteEdit, handleLayerUnwrap, handleLayerFlattenConditional,
 * handleLayerDetach). One decision, parameterised by the human label.
 */
import type { EditResult } from "@/editor/core"
import type { ChatHandoffOutcome } from "./apply-edit-with-chat-handoff"

export type EditOutcomeMessage =
  | { kind: "failed"; message: string }
  | { kind: "handed-off"; message: string }
  | { kind: "success"; message: null }

export function describeEditOutcome(
  kindLabel: string,
  result: EditResult,
  handoff: ChatHandoffOutcome,
): EditOutcomeMessage {
  if (result.kind !== "failed") {
    return { kind: "success", message: null }
  }
  if (handoff.started) {
    return { kind: "handed-off", message: `${kindLabel} needs a decision. Sent to chat.` }
  }
  // "Chat is not available" was wrong more often than right: the common
  // cause of a declined hand-off is a refusal (a chat turn is already
  // running and detached sessions are off), not a missing chat.
  const tail = handoff.attempted ? ". The edit could not be sent to chat, so nothing was changed." : ""
  return { kind: "failed", message: `${kindLabel} failed: ${result.reason}${tail}` }
}
