/**
 * "Is the element at this source position rendered by a loop?"
 *
 * The bridge classifies a click as an iteration row when several DOM nodes
 * share one `data-desde-src` stamp. That is also what N hand-written usages
 * of one component look like (each instance's root carries the component's
 * own line). The DOM cannot tell the two apart; source can. The client asks
 * this before it offers "this item or all items", and hands the edit to chat
 * when the answer is no.
 *
 * Pure: no I/O. The CLI reads the file and calls this.
 */
import { locateJsxLoopAt } from "./resolve-iteration-data-jsx"
import { locateVueLoopAt } from "./resolve-iteration-data-vue"

export interface LoopPosition {
  /** 1-based line. */
  line: number
  /** Babel 0-based column for JSX; Vue 1-based column for SFCs. Same convention as `templateLocation` everywhere else. */
  column: number
}

export type LocateLoopResult =
  | {
      found: true
      kind: "map" | "v-for"
      expression: string
      /**
       * Where the LOOP is, in the same coordinate convention as the input:
       * the element carrying `v-for` for Vue, the JSX element the `.map()`
       * callback returns for JSX.
       *
       * Not the same as the position asked about. Both locators walk up from
       * the clicked element to the enclosing loop, so a `<span>` inside an
       * `<li v-for>` verifies as a loop; without this, "this item" then
       * dispatched the SPAN's position to the data resolver, which matches
       * the loop element exactly and answered "No v-for element at ...".
       */
      location: LoopPosition
      /**
       * The loop element's own span in `source`, as absolute character
       * offsets: the element carrying `v-for` for Vue, the JSX element the
       * `.map()` callback returns for JSX. `[startOffset, endOffset)`.
       *
       * The caller needs it to confine a SECOND position to this loop. The
       * "this item" text lane takes a `fieldLocation` — the nested element the
       * designer actually retyped — and reads the property behind the text at
       * that position. Nothing tied that position to the loop, so a request
       * could verify a loop here and extract a field from a different loop in
       * the same file, and the patch would then be applied to THIS loop's
       * array.
       *
       * Optional so a locator that cannot produce it stays usable; a caller
       * with no range refuses rather than guessing.
       */
      range?: { startOffset: number; endOffset: number }
    }
  | { found: false; reason: string }

export interface LocateLoopInput {
  /** Repo-relative path, used only to pick the parser by extension. */
  file: string
  source: string
  templateLocation: LoopPosition
}

export function locateLoopAt(input: LocateLoopInput): LocateLoopResult {
  const { file, source, templateLocation } = input
  if (file.endsWith(".tsx") || file.endsWith(".jsx")) {
    return locateJsxLoopAt(source, templateLocation)
  }
  if (file.endsWith(".vue")) {
    return locateVueLoopAt(source, templateLocation)
  }
  return { found: false, reason: "Only .vue, .tsx, and .jsx files can be checked for a loop" }
}
