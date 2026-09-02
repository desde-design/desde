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
 * Framework-neutral. Mentions of "v-for" / ".map()" stay out — the
 * agent reads the source file and recognizes idioms from there. The
 * `iterationContext.source` enum (`v-for | map | each | unknown`) is
 * included as a hint when present, since the type already anticipates
 * cross-framework values.
 */

import type { TableEdgeContextMenuPayload } from "@/types/bridge"

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
  return `${loc.file}:${loc.line}:${loc.column}`
}

function formatFingerprints(strings: string[], totalCount: number): string {
  if (strings.length === 0) return "(no visible text in cells)"
  const list = strings.map((s) => `"${s}"`).join(", ")
  if (totalCount > strings.length) {
    return `${list} (showing first ${strings.length} of ${totalCount} cells)`
  }
  return list
}

export function buildTableEdgeInstruction(
  action: TableEdgeAction,
  payload: TableEdgeContextMenuPayload,
): string {
  const verb = actionLabel(action, payload.kind)
  const lines: string[] = []
  lines.push(`[Table edge action]`)
  lines.push(`Action: ${verb}`)
  lines.push(
    `Targeted band: ${payload.kind} index ${payload.index} of ${payload.totalBands}`,
  )
  lines.push(`Container selector: ${payload.containerSelector || "(none)"}`)
  lines.push(`Container source: ${formatLocation(payload.containerEditTarget)}`)
  lines.push(`Target selector: ${payload.targetSelector || "(none)"}`)
  lines.push(`Target source: ${formatLocation(payload.editTarget)}`)
  if (payload.iterationContext) {
    const ic = payload.iterationContext
    lines.push(
      `Iteration context: source=${ic.source}, key=${JSON.stringify(ic.key)}, index=${ic.index}, siblingCount=${ic.siblingCount}`,
    )
  } else {
    lines.push(
      `Iteration context: none (target is not produced by a detected iteration)`,
    )
  }
  lines.push(
    `Visible cell text: ${formatFingerprints(payload.cellFingerprints, payload.cellCount)}`,
  )
  lines.push("")
  lines.push(
    "Read the indicated source file to confirm how this row/column is produced (literal markup, iteration over data, or component-in-loop) before proposing the edit. Edit at the right level: if rows come from iteration, row edits usually belong on the data; columns are typically template-bound.",
  )
  return lines.join("\n")
}
