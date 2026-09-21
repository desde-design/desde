/**
 * The children of an element about to be edited inline, and how to put them
 * back exactly.
 *
 * The inspector takes one of these when a double-click edit begins and uses it
 * when the Editor refuses the edit (`captureDirectMutation` returns
 * `"refused"`). Typed text IS the DOM, so no preview machinery owns it; left
 * alone, the page shows words no source file holds (MEASURED 2026-09-21).
 *
 * Restoring the child LIST, not a string, is the point. An edit can split the
 * text node, delete it, or leave a `<br>` placeholder, and Vue holds live
 * references to both the text node and the anchor comments beside it. So the
 * same node objects go back, in the same order, with the same values, and
 * anything the edit added is removed. `isTextEditableLeaf` guarantees the
 * snapshot holds one text node plus comments, so there is no element subtree
 * to worry about.
 */
export interface InlineTextSnapshot {
  readonly children: readonly Node[]
  readonly values: readonly (string | null)[]
}

export function snapshotInlineText(el: Element): InlineTextSnapshot {
  const children = Array.from(el.childNodes)
  return { children, values: children.map((node) => node.nodeValue) }
}

export function restoreInlineText(el: Element, snap: InlineTextSnapshot): void {
  for (const node of Array.from(el.childNodes)) {
    if (!snap.children.includes(node)) el.removeChild(node)
  }
  snap.children.forEach((node, i) => {
    if (node.nodeType === Node.TEXT_NODE || node.nodeType === Node.COMMENT_NODE) {
      node.nodeValue = snap.values[i] ?? ""
    }
    const at = el.childNodes[i] ?? null
    if (at !== node) el.insertBefore(node, at)
  })
}
