/**
 * Build the structured chat message sent to the Editor agent when
 * the user picks a row/column action from the edge context menu.
 *
 * The instruction is plain text — the chat orchestrator's existing
 * input shape — but it carries a clear `[Table edge action]` header so
 * the agent's system-prompt stanza for this feature can recognize and
 * handle it consistently. All fields the bridge captures are passed
 * through; the agent decides what's actually load-bearing.
 *
 * **Everything it copies comes from the page**, including the visible cell
 * text, the selectors, the source locations and the iteration numbers. So it
 * is written like the other hand-offs: the marker line first, every copied
 * field flattened to one line, the facts inside a per-message random envelope,
 * and the instruction sentences outside it. It used to interpolate all of it
 * raw into a message that starts a write-capable turn.
 *
 * Framework-neutral. Mentions of "v-for" / ".map()" stay out — the
 * agent reads the source file and recognizes idioms from there. The
 * `iterationContext.source` enum (`v-for | map | each | unknown`) is
 * included as a hint when present, since the type already anticipates
 * cross-framework values.
 */

import type { TableEdgeContextMenuPayload } from "@/types/bridge"
import {
  DETAIL_LIMIT,
  EDIT_HANDOFF_MARKER,
  fenceHandoffFacts,
  HANDOFF_FENCE_NOTE,
  safeCount,
  sanitizeField,
} from "@/editor/edit-service/build-edit-escalation-prompt"

export type TableEdgeAction =
  | "delete"
  | "duplicate"
  | "addBefore" // above for row, left for column
  | "addAfter" //  below for row, right for column

const ACTION_VERBS: Record<TableEdgeAction, { row: string; column: string }> = {
  delete: { row: "Delete row", column: "Delete column" },
  duplicate: { row: "Duplicate row", column: "Duplicate column" },
  addBefore: { row: "Add row above", column: "Add column to the left" },
  addAfter: { row: "Add row below", column: "Add column to the right" },
}

export function actionLabel(
  action: TableEdgeAction,
  kind: "row" | "column",
): string {
  return ACTION_VERBS[action][kind]
}

function formatLocation(
  loc: { file: string; line: number; column: number } | undefined,
): string {
  if (!loc) return "(no source location available)"
  // The two numbers are typed but never checked on the wire, same as
  // everywhere else a bridge coordinate is rendered.
  return `${sanitizeField(loc.file)}:${String(safeCount(loc.line))}:${String(safeCount(loc.column))}`
}

/**
 * The cells' visible text, which is the most page-controlled field here: a
 * prototype can put anything in a table cell. Each entry is flattened and
 * capped on its own, then the whole list rides one bullet inside the envelope.
 */
function formatFingerprints(strings: readonly string[], totalCount: number): string {
  // The payload is cast off `postMessage`, so `cellFingerprints` being an
  // array is a claim nothing checked. `sanitizeField` handles each ENTRY not
  // being a string; this handles the list itself not being a list.
  const shown = Array.isArray(strings) ? strings.slice(0, 50) : []
  if (shown.length === 0) return "(no visible text in cells)"
  const list = shown.map((s) => `"${sanitizeField(s)}"`).join(", ")
  const total = safeCount(totalCount)
  if (total > shown.length) {
    return `${list} (showing first ${String(shown.length)} of ${String(total)} cells)`
  }
  return list
}

export function buildTableEdgeInstruction(
  action: TableEdgeAction,
  payload: TableEdgeContextMenuPayload,
): string {
  // Normalise the kind FIRST and label off the normalised value. `kind` is
  // typed `"row" | "column"` but arrives off `postMessage`, and
  // `ACTION_VERBS[action][kind]` on any third value is `undefined`, which used
  // to reach `sanitizeField` and throw partway through building the message.
  const kind = payload.kind === "column" ? "column" : "row"
  const verb = actionLabel(action, kind)
  const facts: string[] = [
    `- Action: ${verb}`,
    `- Targeted band: ${kind} index ${String(safeCount(payload.index))} of ${String(safeCount(payload.totalBands))}`,
    `- Container selector: ${sanitizeField(payload.containerSelector) || "(none)"}`,
    `- Container source: ${formatLocation(payload.containerEditTarget)}`,
    `- Target selector: ${sanitizeField(payload.targetSelector) || "(none)"}`,
    `- Target source: ${formatLocation(payload.editTarget)}`,
  ]
  if (payload.iterationContext) {
    const ic = payload.iterationContext
    // `key` is a string or a number. `JSON.stringify` of a string keeps its
    // escapes, so a newline inside it survives as `\n` rather than as a line
    // break; sanitize anyway, so the rule does not depend on that.
    const key = typeof ic.key === "string" ? `"${sanitizeField(ic.key)}"` : String(safeCount(ic.key))
    facts.push(
      `- Iteration context: source=${sanitizeField(ic.source, 20)}, key=${key}, index=${String(safeCount(ic.index))}, siblingCount=${String(safeCount(ic.siblingCount))}`,
    )
  } else {
    facts.push(
      "- Iteration context: none (target is not produced by a detected iteration)",
    )
  }
  facts.push(
    `- Visible cell text: ${sanitizeField(formatFingerprints(payload.cellFingerprints, payload.cellCount), DETAIL_LIMIT)}`,
  )
  return [
    EDIT_HANDOFF_MARKER,
    "",
    "[Table edge action]",
    `I picked "${sanitizeField(verb, 60)}" from the ${kind} edge menu in the prototype.`,
    "",
    HANDOFF_FENCE_NOTE,
    "",
    ...fenceHandoffFacts(facts),
    "",
    "Read the indicated source file to confirm how this row/column is produced (literal markup, iteration over data, or component-in-loop) before proposing the edit. Edit at the right level: if rows come from iteration, row edits usually belong on the data; columns are typically template-bound.",
  ].join("\n")
}
