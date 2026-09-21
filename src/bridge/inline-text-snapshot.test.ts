/**
 * Putting an inline-edited element back exactly as it was.
 *
 * Needed when the Editor refuses a double-click text edit: the typed text IS the
 * DOM, so nothing else takes it back. A codex review (2026-09-21) found the first
 * fix too narrow: it rewrote only the first text node, so an edit that split the
 * text left pieces behind ("Af" + "ter" became "Beforeter"), and an edit that
 * deleted the text put the new node after any anchor comment.
 */
import { describe, expect, it } from "vitest"
import { restoreInlineText, snapshotInlineText } from "./inline-text-snapshot"

function mount(html: string): HTMLElement {
  document.body.innerHTML = `<div>${html}</div>`
  return document.body.firstElementChild as HTMLElement
}

describe("restoreInlineText", () => {
  it("restores the original value into the original text node", () => {
    const el = mount("Before")
    const original = el.firstChild!
    const snap = snapshotInlineText(el)
    original.nodeValue = "After"

    restoreInlineText(el, snap)

    expect(el.textContent).toBe("Before")
    expect(el.firstChild).toBe(original)
  })

  it("removes the pieces an edit split off", () => {
    const el = mount("Before")
    const snap = snapshotInlineText(el)
    el.firstChild!.nodeValue = "Af"
    el.appendChild(document.createTextNode("ter"))

    restoreInlineText(el, snap)

    expect(el.textContent).toBe("Before")
    expect(el.childNodes).toHaveLength(1)
  })

  it("brings back a deleted text node in its place, before an anchor", () => {
    const el = mount("Before<!--v-if-->")
    const [text, anchor] = Array.from(el.childNodes)
    const snap = snapshotInlineText(el)
    el.removeChild(text!)

    restoreInlineText(el, snap)

    expect(Array.from(el.childNodes)).toEqual([text, anchor])
    expect(el.textContent).toBe("Before")
  })

  it("brings back a deleted text node in its place, after an anchor", () => {
    const el = mount("<!--v-if-->Before")
    const [anchor, text] = Array.from(el.childNodes)
    const snap = snapshotInlineText(el)
    el.removeChild(text!)
    el.appendChild(document.createElement("br"))

    restoreInlineText(el, snap)

    expect(Array.from(el.childNodes)).toEqual([anchor, text])
  })

  it("keeps the SAME anchor comment objects, which Vue holds references to", () => {
    const el = mount("<!--a-->Before<!--b-->")
    const before = Array.from(el.childNodes)
    const snap = snapshotInlineText(el)
    // What a select-all overwrite can do in some engines.
    el.textContent = "After"

    restoreInlineText(el, snap)

    expect(Array.from(el.childNodes)).toEqual(before)
    expect(el.textContent).toBe("Before")
  })
})
