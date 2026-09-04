/**
 * `MentionInput` — the shared @-mention composer.
 *
 * The defect these tests exist for: for months every reply box in the
 * product rendered the placeholder "Reply… (@ to mention)" over a plain
 * `Textarea` with no picker behind it. The promise was a hardcoded string at
 * four call sites and the capability was wired at none of them, so nothing in
 * typecheck, lint or the suite could see that they disagreed.
 *
 * So the first two cases here are about the PLACEHOLDER, not the picker: the
 * hint has to be derived from the directory, or the same thing happens again
 * the next time a surface mounts this input without one.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { useState } from "react"
import { MentionInput } from "./mention-input"
import type { MentionParticipant } from "./mention-encoding"

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const PARTICIPANTS: MentionParticipant[] = [
  { id: "p_rin", displayName: "Rin Adeyemi", email: "rin@example.com" },
  { id: "p_sam", displayName: "Sam Okafor" },
  { id: "p_mo", displayName: "Mo Chang", email: "mo@example.com" },
  // Email shares nothing with the display name, so it can prove that the
  // filter really reads the address and is not just matching the name.
  { id: "p_dana", displayName: "Dana Whitfield", email: "dw@example.com" },
]

/** Controlled wrapper: the real call sites all own the text. */
function Harness({
  participants,
  onInvite,
  onKeyDown,
  onValue,
}: {
  participants?: MentionParticipant[]
  onInvite?: (email: string) => Promise<MentionParticipant | null>
  onKeyDown?: (e: React.KeyboardEvent) => void
  onValue?: (v: string) => void
}) {
  const [value, setValue] = useState("")
  return (
    <div className="relative">
      <MentionInput
        placeholder="Reply"
        value={value}
        onChange={(v) => {
          setValue(v)
          onValue?.(v)
        }}
        onKeyDown={onKeyDown}
        participants={participants}
        onInvite={onInvite}
      />
    </div>
  )
}

function type(text: string, cursor = text.length) {
  fireEvent.change(screen.getByRole("combobox"), {
    target: { value: text, selectionStart: cursor },
  })
}

describe("the placeholder tracks the directory, not a hardcoded string", () => {
  it("offers @ only when somebody is mentionable", () => {
    render(<Harness participants={PARTICIPANTS} />)
    expect(screen.getByPlaceholderText("Reply… (@ to mention)")).toBeTruthy()
  })

  it("drops the hint when there is no directory and no invite path", () => {
    render(<Harness />)
    expect(screen.getByPlaceholderText("Reply…")).toBeTruthy()
    expect(screen.queryByPlaceholderText(/@ to mention/)).toBeNull()
  })

  it("keeps the hint when the directory is empty but inviting is possible", () => {
    render(<Harness participants={[]} onInvite={async () => null} />)
    expect(screen.getByPlaceholderText("Reply… (@ to mention)")).toBeTruthy()
  })
})

describe("the picker", () => {
  it("opens on @ and lists the directory", () => {
    render(<Harness participants={PARTICIPANTS} />)
    type("@")
    expect(screen.getByRole("listbox")).toBeTruthy()
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Rin Adeyemirin@example.com",
      "Sam Okafor",
      "Mo Changmo@example.com",
      "Dana Whitfielddw@example.com",
    ])
  })

  it("filters on display name and on email", () => {
    render(<Harness participants={PARTICIPANTS} />)
    type("@rin")
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Rin Adeyemirin@example.com",
    ])
    type("@dw")
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Dana Whitfielddw@example.com",
    ])
  })

  // The token is the text after the LAST `@` before the caret, so typing a
  // whole address searches the part after its `@`. Worth pinning: it is the
  // rule that keeps "@rin @sam" from being read as one long token.
  it("reads the token from the last @ before the caret", () => {
    render(<Harness participants={PARTICIPANTS} />)
    type("@mo@example")
    expect(screen.getAllByRole("option")).toHaveLength(3)
  })

  // `email` is omitted for non-insiders (security audit S3). An unguarded
  // `.toLowerCase()` on it once threw and took the whole picker down for
  // anonymous reviewers, so a participant WITHOUT an email must survive a
  // query that only the others can match.
  it("survives a participant with no email", () => {
    render(<Harness participants={PARTICIPANTS} />)
    type("@example.com")
    expect(screen.getAllByRole("option")).toHaveLength(3)
  })

  // The options live in a combobox popup: the textarea keeps focus and its
  // arrows move the highlight, so a Tab stop on each row is both wrong for the
  // pattern and a dead end (Enter on a focused button fires `click`, and
  // selection is bound to `mousedown` to preserve the caret).
  it("keeps the option rows out of the tab order", () => {
    render(<Harness participants={PARTICIPANTS} />)
    type("@")
    for (const option of screen.getAllByRole("option")) {
      expect(option.getAttribute("tabindex")).toBe("-1")
    }
  })

  it("never opens when nobody is mentionable", () => {
    render(<Harness />)
    type("@")
    expect(screen.queryByRole("listbox")).toBeNull()
  })

  it("closes once whitespace ends the token", () => {
    render(<Harness participants={PARTICIPANTS} />)
    type("@rin")
    expect(screen.getByRole("listbox")).toBeTruthy()
    type("@rin ")
    expect(screen.queryByRole("listbox")).toBeNull()
  })

  it("shows the invite row only when the surface can invite", () => {
    const { unmount } = render(<Harness participants={PARTICIPANTS} />)
    type("@")
    expect(screen.queryByPlaceholderText("Invite by email…")).toBeNull()
    unmount()

    render(<Harness participants={PARTICIPANTS} onInvite={async () => null} />)
    type("@")
    expect(screen.getByPlaceholderText("Invite by email…")).toBeTruthy()
  })
})

// The card these inputs live in is positioned against a comment pin. A pin in
// the TOP half of the screen anchors the card by its `top`, which puts the
// composer near the top edge — and an upward-opening list then renders
// entirely off-screen, which is a picker that cannot be used at all.
describe("which side the list opens on", () => {
  function stubTextareaRect(top: number, height = 44) {
    vi.spyOn(HTMLTextAreaElement.prototype, "getBoundingClientRect").mockReturnValue({
      top,
      bottom: top + height,
      height,
      left: 0,
      right: 320,
      width: 320,
      x: 0,
      y: top,
      toJSON: () => ({}),
    })
  }

  function popupClasses() {
    return screen.getByRole("listbox").parentElement!.className
  }

  it("opens upward when the composer sits low on the screen", () => {
    vi.stubGlobal("innerHeight", 720)
    stubTextareaRect(600)
    render(<Harness participants={PARTICIPANTS} />)
    type("@")
    expect(popupClasses()).toContain("bottom-full")
  })

  it("flips below when there is no room above it", () => {
    vi.stubGlobal("innerHeight", 720)
    stubTextareaRect(24)
    render(<Harness participants={PARTICIPANTS} />)
    type("@")
    expect(popupClasses()).toContain("top-full")
  })

  // A viewport with no height is a page that is not being SHOWN (a hidden
  // pane, an offscreen capture), not a cramped one. Believing it flipped the
  // list to the wrong side, where it stayed, since the side is decided once
  // when the list opens.
  it("keeps the default rather than believe a zero-height viewport", () => {
    vi.stubGlobal("innerHeight", 0)
    stubTextareaRect(-64)
    render(<Harness participants={PARTICIPANTS} />)
    type("@")
    expect(popupClasses()).toContain("bottom-full")
  })
})

describe("inviting by email", () => {
  it("keeps the address, and says so, when the invite is refused", async () => {
    render(<Harness participants={PARTICIPANTS} onInvite={async () => null} />)
    type("@")

    const field = screen.getByPlaceholderText("Invite by email…") as HTMLInputElement
    fireEvent.change(field, { target: { value: "typo@" } })
    fireEvent.click(screen.getByRole("button", { name: "Invite" }))

    // Clearing the field on a refusal took away the one thing the person
    // needed in order to correct it, and said nothing had gone wrong.
    await screen.findByText(/did not go through/)
    expect(field.value).toBe("typo@")
  })

  it("drops the failure notice as soon as the invite is retried", async () => {
    let attempt = 0
    render(
      <Harness
        participants={PARTICIPANTS}
        onInvite={async () => (++attempt === 1 ? null : { id: "p_new", displayName: "New" })}
      />,
    )
    type("@")
    const field = screen.getByPlaceholderText("Invite by email…")
    fireEvent.change(field, { target: { value: "someone@example.com" } })
    fireEvent.click(screen.getByRole("button", { name: "Invite" }))
    await screen.findByText(/did not go through/)

    fireEvent.click(screen.getByRole("button", { name: "Invite" }))
    await waitFor(() => expect(screen.queryByText(/did not go through/)).toBeNull())
  })

  it("mentions the new person as soon as the invite lands", async () => {
    const onValue = vi.fn()
    render(
      <Harness
        participants={PARTICIPANTS}
        onValue={onValue}
        onInvite={async () => ({ id: "p_new", displayName: "New Person" })}
      />,
    )
    type("hey @", 5)
    fireEvent.change(screen.getByPlaceholderText("Invite by email…"), {
      target: { value: "new@example.com" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Invite" }))

    await waitFor(() =>
      expect(onValue).toHaveBeenLastCalledWith("hey @[New Person](p_new) "),
    )
  })
})

describe("choosing a name", () => {
  it("writes the wire format and closes the picker", () => {
    const onValue = vi.fn()
    render(<Harness participants={PARTICIPANTS} onValue={onValue} />)
    type("hey @rin", 8)
    fireEvent.click(screen.getByRole("option"))

    expect(onValue).toHaveBeenLastCalledWith("hey @[Rin Adeyemi](p_rin) ")
    expect(screen.queryByRole("listbox")).toBeNull()
  })

  // Selection hangs off `click`, not `mousedown`, so that a screen reader or
  // voice control (which dispatches only `click`) can activate a row. A real
  // pointer sends both, and must still insert exactly one mention.
  it("inserts once for a full pointer press, not twice", () => {
    const onValue = vi.fn()
    render(<Harness participants={PARTICIPANTS} onValue={onValue} />)
    type("@rin")
    const option = screen.getByRole("option")
    const before = onValue.mock.calls.length
    fireEvent.mouseDown(option)
    fireEvent.click(option)

    expect(onValue.mock.calls.length - before).toBe(1)
    expect(onValue).toHaveBeenLastCalledWith("@[Rin Adeyemi](p_rin) ")
  })

  it("replaces only the token, keeping text after the caret", () => {
    const onValue = vi.fn()
    render(<Harness participants={PARTICIPANTS} onValue={onValue} />)
    type("@sam, thoughts?", 4)
    fireEvent.click(screen.getByRole("option"))

    expect(onValue).toHaveBeenLastCalledWith("@[Sam Okafor](p_sam) , thoughts?")
  })

  it("takes a bare Enter, and lets a modified Enter reach the parent's submit", () => {
    const onValue = vi.fn()
    const onKeyDown = vi.fn()
    render(<Harness participants={PARTICIPANTS} onValue={onValue} onKeyDown={onKeyDown} />)

    type("@sam")
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" })
    expect(onValue).toHaveBeenLastCalledWith("@[Sam Okafor](p_sam) ")
    expect(onKeyDown).not.toHaveBeenCalled()

    // Cmd+Enter is the submit at every call site. It must keep working even
    // while a mention token happens to be open, or sending silently stops.
    type("@sam")
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter", metaKey: true })
    expect(onKeyDown).toHaveBeenCalledTimes(1)
  })

  it("moves the highlight with the arrow keys", () => {
    const onValue = vi.fn()
    render(<Harness participants={PARTICIPANTS} onValue={onValue} />)
    type("@")
    const box = screen.getByRole("combobox")
    fireEvent.keyDown(box, { key: "ArrowDown" })
    fireEvent.keyDown(box, { key: "ArrowDown" })
    fireEvent.keyDown(box, { key: "Enter" })
    expect(onValue).toHaveBeenLastCalledWith("@[Mo Chang](p_mo) ")
  })

  // A stale highlight is worse than no highlight: Enter would insert somebody
  // the user never saw offered. The index is carried WITH the query it was
  // chosen against, so it cannot follow the user into a different list.
  it("returns the highlight to the top when the query changes", () => {
    const onValue = vi.fn()
    render(<Harness participants={PARTICIPANTS} onValue={onValue} />)
    const box = screen.getByRole("combobox")

    type("@")
    fireEvent.keyDown(box, { key: "ArrowDown" })
    fireEvent.keyDown(box, { key: "ArrowDown" })

    // A different query, whose list happens to hold the same people in the
    // same order. Enter must take the FIRST row, not the third.
    type("@a")
    expect(screen.getAllByRole("option")).toHaveLength(4)
    fireEvent.keyDown(box, { key: "Enter" })
    expect(onValue).toHaveBeenLastCalledWith("@[Rin Adeyemi](p_rin) ")
  })

  // Narrowing and widening back to the SAME query is not a new list, so the
  // place the user had picked is kept rather than thrown away.
  it("keeps the highlight when the query returns to what it was", () => {
    const onValue = vi.fn()
    render(<Harness participants={PARTICIPANTS} onValue={onValue} />)
    const box = screen.getByRole("combobox")

    type("@")
    fireEvent.keyDown(box, { key: "ArrowDown" })
    fireEvent.keyDown(box, { key: "ArrowDown" })
    type("@rin")
    type("@")
    fireEvent.keyDown(box, { key: "Enter" })
    expect(onValue).toHaveBeenLastCalledWith("@[Mo Chang](p_mo) ")
  })

  // The highlight belongs to ONE token. Abandoning a token you had arrowed
  // down in and starting a fresh one elsewhere gave both the empty query, so
  // the new picker opened on the old row and Enter inserted a name chosen for
  // a sentence the user had already moved on from.
  it("does not carry the highlight into a token started elsewhere", () => {
    const onValue = vi.fn()
    render(<Harness participants={PARTICIPANTS} onValue={onValue} />)
    const box = screen.getByRole("combobox")

    type("@")
    fireEvent.keyDown(box, { key: "ArrowDown" })
    fireEvent.keyDown(box, { key: "ArrowDown" })
    // Abandon that token with whitespace, then open a new one further along.
    type("hello @")
    fireEvent.keyDown(box, { key: "Enter" })
    expect(onValue).toHaveBeenLastCalledWith("hello @[Rin Adeyemi](p_rin) ")
  })

  it("wraps past the end of the list", () => {
    const onValue = vi.fn()
    render(<Harness participants={PARTICIPANTS} onValue={onValue} />)
    type("@")
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowUp" })
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" })
    expect(onValue).toHaveBeenLastCalledWith("@[Dana Whitfield](p_dana) ")
  })
})

// An IME (Japanese, Korean, Chinese) uses Enter to commit its candidate and
// the arrows to move through its own list. If the picker eats those, composing
// an `@` query replaces half-finished text with a mention nobody chose.
describe("while an IME is composing", () => {
  it("leaves Enter to the composition instead of picking a name", () => {
    const onValue = vi.fn()
    render(<Harness participants={PARTICIPANTS} onValue={onValue} />)
    type("@sam")
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter", isComposing: true })
    expect(onValue).not.toHaveBeenCalledWith("@[Sam Okafor](p_sam) ")
    expect(screen.getByRole("listbox")).toBeTruthy()
  })

  it("leaves the arrows to the IME's own candidate list", () => {
    const onValue = vi.fn()
    render(<Harness participants={PARTICIPANTS} onValue={onValue} />)
    type("@")
    const box = screen.getByRole("combobox")
    fireEvent.keyDown(box, { key: "ArrowDown", isComposing: true })
    fireEvent.keyDown(box, { key: "ArrowDown", isComposing: true })
    // Highlight never moved, so a later commit still offers the first row.
    fireEvent.keyDown(box, { key: "Enter" })
    expect(onValue).toHaveBeenLastCalledWith("@[Rin Adeyemi](p_rin) ")
  })

  // The pending caret used to be CONSUMED before the composition guard, so a
  // name picked while an IME was open lost its caret with nothing left to put
  // it back. A composition ending does not re-render on its own, so the
  // request has to be held and drained explicitly.
  it("defers the caret until the composition ends, rather than dropping it", () => {
    render(<Harness participants={PARTICIPANTS} />)
    const box = screen.getByRole("combobox") as HTMLTextAreaElement
    fireEvent.compositionStart(box)
    type("over to @rin")
    fireEvent.click(screen.getByRole("option"))

    // Still composing: the caret must not have been written yet.
    expect(box.value).toBe("over to @Rin Adeyemi ")
    fireEvent.compositionEnd(box)
    expect(box.selectionStart).toBe("over to @Rin Adeyemi ".length)
  })

  it("leaves Escape to cancel the composition, not the picker", () => {
    render(<Harness participants={PARTICIPANTS} />)
    type("@rin")
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape", isComposing: true })
    expect(screen.getByRole("listbox")).toBeTruthy()
  })
})

// The whole point of the projection. `value` stays the storage format the
// parents submit, but the writer must never see the id: a 36-character UUID
// mid-sentence is startling, and the textarea carries `field-sizing-content`,
// so it grew the box by a line or two per mention as well.
describe("what the writer sees", () => {
  function field() {
    return screen.getByRole("combobox") as HTMLTextAreaElement
  }

  it("shows the name, never the id", () => {
    const onValue = vi.fn()
    render(<Harness participants={PARTICIPANTS} onValue={onValue} />)
    type("over to @rin")
    fireEvent.click(screen.getByRole("option"))

    expect(field().value).toBe("over to @Rin Adeyemi ")
    expect(field().value).not.toContain("p_rin")
    expect(field().value).not.toContain("[")
    // The parent still receives the storage format, unchanged.
    expect(onValue).toHaveBeenLastCalledWith("over to @[Rin Adeyemi](p_rin) ")
  })

  it("leaves the caret after the inserted name, in display coordinates", () => {
    render(<Harness participants={PARTICIPANTS} onValue={vi.fn()} />)
    type("over to @rin")
    fireEvent.click(screen.getByRole("option"))
    expect(field().selectionStart).toBe("over to @Rin Adeyemi ".length)
  })

  it("keeps the mention when the writer types on after it", () => {
    const onValue = vi.fn()
    render(<Harness participants={PARTICIPANTS} onValue={onValue} />)
    type("@rin")
    fireEvent.click(screen.getByRole("option"))
    type("@Rin Adeyemi please")

    expect(field().value).toBe("@Rin Adeyemi please")
    expect(onValue).toHaveBeenLastCalledWith("@[Rin Adeyemi](p_rin) please")
  })

  it("drops the mention when the writer edits the name", () => {
    const onValue = vi.fn()
    render(<Harness participants={PARTICIPANTS} onValue={onValue} />)
    type("@rin")
    fireEvent.click(screen.getByRole("option"))
    // Backspace the last letter of the name.
    type("@Rin Adeyem")

    expect(onValue).toHaveBeenLastCalledWith("@Rin Adeyem")
    expect(field().value).toBe("@Rin Adeyem")
  })

  // Left unguarded, clicking after the first word of a resolved mention
  // reopened the picker on it, and choosing a name replaced half the name and
  // stranded the rest in the sentence.
  it("does not reopen the picker inside a mention it already resolved", () => {
    render(<Harness participants={PARTICIPANTS} />)
    type("@rin")
    fireEvent.click(screen.getByRole("option"))
    expect(screen.queryByRole("listbox")).toBeNull()

    // Caret parked just after "@Rin", inside the resolved mention.
    fireEvent.click(field())
    fireEvent.keyUp(field(), { target: { selectionStart: 4 } })
    expect(screen.queryByRole("listbox")).toBeNull()
  })

  // Control for the case above: the SAME caret move on the same characters,
  // with no mention resolved, does open the picker. Without this the test
  // above would pass just as well if moving the caret did nothing at all.
  it("does open on the same caret move when the text is not a mention", () => {
    render(<Harness participants={PARTICIPANTS} />)
    type("@Rin Adeyemi", 12)
    expect(screen.queryByRole("listbox")).toBeNull() // whitespace closed it
    fireEvent.keyUp(screen.getByRole("combobox"), { target: { selectionStart: 4 } })
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Rin Adeyemirin@example.com",
    ])
  })

  it("still opens for a fresh @ typed after a mention", () => {
    render(<Harness participants={PARTICIPANTS} />)
    type("@rin")
    fireEvent.click(screen.getByRole("option"))
    type("@Rin Adeyemi @sa")
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Sam Okafor"])
  })

  it("carries two mentions independently", () => {
    const onValue = vi.fn()
    render(<Harness participants={PARTICIPANTS} onValue={onValue} />)
    type("@rin")
    fireEvent.click(screen.getByRole("option"))
    type("@Rin Adeyemi and @sam")
    fireEvent.click(screen.getByRole("option"))

    expect(field().value).toBe("@Rin Adeyemi and @Sam Okafor ")
    expect(onValue).toHaveBeenLastCalledWith(
      "@[Rin Adeyemi](p_rin) and @[Sam Okafor](p_sam) ",
    )
  })
})

// The projection took a signal away: while the id was in the field, a live
// mention looked different from text that merely reads like one. Showing the
// name alone made them identical, and only one of them notifies anybody.
describe("the live-mention highlight", () => {
  function layer() {
    return document.querySelector('[data-slot="mention-highlight"]') as HTMLElement | null
  }
  function highlighted() {
    return [...(layer()?.querySelectorAll("span") ?? [])]
      .filter((el) => el.className.includes("text-primary"))
      .map((el) => el.textContent)
  }

  it("marks a resolved mention and leaves lookalike text alone", () => {
    render(<Harness participants={PARTICIPANTS} />)
    type("@rin")
    fireEvent.click(screen.getByRole("option"))
    type("@Rin Adeyemi and @Rin Adeyemi typed by hand")

    // The first is a real mention; the second is the same characters, typed.
    expect(highlighted()).toEqual(["@Rin Adeyemi"])
  })

  it("is not rendered at all when there is nothing live to mark", () => {
    render(<Harness participants={PARTICIPANTS} />)
    type("no mentions here")
    expect(layer()).toBeNull()
    type("@Rin Adeyemi by hand only")
    expect(layer()).toBeNull()
  })

  it("marks every mention when there are several", () => {
    render(<Harness participants={PARTICIPANTS} />)
    type("@rin")
    fireEvent.click(screen.getByRole("option"))
    type("@Rin Adeyemi and @sam")
    fireEvent.click(screen.getByRole("option"))
    expect(highlighted()).toEqual(["@Rin Adeyemi", "@Sam Okafor"])
  })

  it("is hidden from assistive tech and from the pointer", () => {
    render(<Harness participants={PARTICIPANTS} />)
    type("@rin")
    fireEvent.click(screen.getByRole("option"))
    const el = layer()!
    // The textarea already carries this text; announcing it twice is noise.
    expect(el.getAttribute("aria-hidden")).toBe("true")
    // It sits ON TOP of the field, so it must not swallow clicks.
    expect(el.className).toContain("pointer-events-none")
  })

  // The layer paints ONLY the mention runs. The words the writer reads stay
  // the textarea's own, so a layer that ever failed to line up would misplace
  // a tint rather than garble the draft, and the caret, the selection and the
  // placeholder are never anything but native.
  it("never takes the field's own text away from it", () => {
    render(<Harness participants={PARTICIPANTS} />)
    const field = screen.getByRole("combobox")
    type("@rin")
    fireEvent.click(screen.getByRole("option"))

    expect(field.className).not.toContain("text-transparent")
    // Only the mention runs carry a colour; everything else is invisible here.
    const runs = [...layer()!.querySelectorAll("span")]
    expect(runs.filter((el) => el.className.includes("text-primary"))).toHaveLength(1)
    expect(layer()!.className).toContain("text-transparent")
  })

  // `field-sizing-content` is Chromium-only. In Safari and Firefox the field
  // stays at its min-height and scrolls, and since its own text is transparent
  // while the layer is up, an unsynced layer shows the wrong part of the draft
  // rather than merely looking off.
  it("follows the field when it scrolls", () => {
    render(<Harness participants={PARTICIPANTS} />)
    type("@rin")
    fireEvent.click(screen.getByRole("option"))
    const field = screen.getByRole("combobox")

    field.scrollTop = 24
    fireEvent.scroll(field)
    expect(layer()!.scrollTop).toBe(24)
  })

  // The metrics sync is keyed on the layer EXISTING, not just on `className`.
  // Keyed on className alone it ran once at mount while the ref was still
  // null and never again, and the highlight rendered as one bar across the
  // whole line because the layer had no padding and no `pre-wrap`.
  it("copies the field's metrics once the layer appears", () => {
    render(<Harness participants={PARTICIPANTS} />)
    type("@rin")
    fireEvent.click(screen.getByRole("option"))
    // Whatever the environment computes, the sync must have written it here.
    expect(layer()!.style.getPropertyValue("white-space")).toBe(
      window.getComputedStyle(screen.getByRole("combobox")).getPropertyValue("white-space"),
    )
    expect(layer()!.style.length).toBeGreaterThan(0)
  })
})

describe("Escape", () => {
  it("dismisses the picker and does not reach the parent", () => {
    const onKeyDown = vi.fn()
    render(<Harness participants={PARTICIPANTS} onKeyDown={onKeyDown} />)
    type("@rin")
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" })

    expect(screen.queryByRole("listbox")).toBeNull()
    // The card's own Escape handler closes the reply box (or the thread).
    // Dismissing a picker must not also do that.
    expect(onKeyDown).not.toHaveBeenCalled()
  })

  it("stays dismissed while the same token grows, and reopens on a new one", () => {
    render(<Harness participants={PARTICIPANTS} />)
    type("@rin")
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" })
    type("@rina")
    expect(screen.queryByRole("listbox")).toBeNull()

    type("@rina @sa")
    expect(screen.getByRole("listbox")).toBeTruthy()
  })

  // Keying the dismissal on the token's START ALONE left this stuck: delete
  // the `@` and type a fresh one at the same offset, and the picker stayed
  // silent with no way back.
  it("reopens once the dismissed query is edited back down", () => {
    render(<Harness participants={PARTICIPANTS} />)
    type("@rin")
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" })
    expect(screen.queryByRole("listbox")).toBeNull()

    type("@sam")
    expect(screen.getByRole("listbox")).toBeTruthy()
  })

  it("reaches the parent when there is no picker to dismiss", () => {
    const onKeyDown = vi.fn()
    render(<Harness participants={PARTICIPANTS} onKeyDown={onKeyDown} />)
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" })
    expect(onKeyDown).toHaveBeenCalledTimes(1)
  })
})
