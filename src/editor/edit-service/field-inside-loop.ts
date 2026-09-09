/**
 * "Is this second position inside the loop we just verified?"
 *
 * The "this item" text lane takes TWO positions. `templateLocation` is the
 * loop; `fieldLocation` is the nested element the designer actually retyped,
 * and the server reads the property behind the text at that position.
 *
 * Nothing tied the two together. `fieldLocation` was shape-validated — a line
 * and a column — and then extraction ran wherever it pointed. A request could
 * therefore verify a loop here, name a field in a DIFFERENT loop in the same
 * file, and have the patch applied to THIS loop's array: a field the designer
 * never touched, written with a value from a row that does not contain it.
 *
 * Pure: no I/O. The CLI reads the file and calls this.
 */
import { locateLoopAt, type LoopPosition } from "./locate-loop"

export type FieldConfinement = { ok: true } | { ok: false; reason: string }

export function fieldLocationInsideLoop(input: {
  /** Repo-relative path, used only to pick the parser and the column base. */
  file: string
  source: string
  templateLocation: LoopPosition
  fieldLocation: LoopPosition
}): FieldConfinement {
  const { file, source, templateLocation, fieldLocation } = input
  const loop = locateLoopAt({ file, source, templateLocation })
  if (!loop.found) {
    return { ok: false, reason: `No loop at templateLocation: ${loop.reason}` }
  }
  if (!loop.range) {
    // A locator that found the loop but could not give its span. Refusing is
    // the only safe answer: the whole point is that an unconfined position is
    // not trusted, so "no range" cannot mean "allow it".
    return { ok: false, reason: "The loop's source range could not be determined" }
  }
  // Babel reports 0-based columns for JSX; Vue's template columns are 1-based.
  // Same split `locateLoopAt` makes for the parser, and the same convention
  // `templateLocation` already travels in.
  const columnBase = file.endsWith(".tsx") || file.endsWith(".jsx") ? 0 : 1
  const offset = offsetOfPosition(source, fieldLocation.line, fieldLocation.column, columnBase)
  if (offset === null) {
    return { ok: false, reason: "fieldLocation is not a position in this file" }
  }
  if (offset < loop.range.startOffset || offset >= loop.range.endOffset) {
    return {
      ok: false,
      reason: "fieldLocation must be inside the loop at templateLocation",
    }
  }
  return { ok: true }
}

/** Character offset of a 1-based line and a column in the given base. */
function offsetOfPosition(
  source: string,
  line: number,
  column: number,
  columnBase: 0 | 1,
): number | null {
  if (!Number.isInteger(line) || line < 1) return null
  let offset = 0
  for (let current = 1; current < line; current++) {
    const newline = source.indexOf("\n", offset)
    if (newline === -1) return null
    offset = newline + 1
  }
  return offset + Math.max(0, column - columnBase)
}
