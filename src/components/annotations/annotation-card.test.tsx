/**
 * `AnnotationCard` — the thread card both surfaces mount (the Viewer's review
 * popup, the Editor's comment popup, the notes popup, the canvas nodes).
 *
 * These cover the REPLY box specifically. It shipped for months with the
 * placeholder "Reply… (@ to mention)" over an input that had no picker, so
 * the guard that matters is that the card's directory actually reaches the
 * reply composer and that a chosen name survives into `onReply`.
 */

import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { AnnotationCard } from "./annotation-card"
import type { MentionParticipant } from "./mention-encoding"

const PARTICIPANTS: MentionParticipant[] = [
  { id: "p_rin", displayName: "Rin Adeyemi", email: "rin@example.com" },
  { id: "p_sam", displayName: "Sam Okafor" },
]

function renderCard(overrides: Partial<React.ComponentProps<typeof AnnotationCard>> = {}) {
  const onReply = vi.fn()
  render(
    <AnnotationCard
      variant="comment"
      body="the header is misaligned"
      author={{ displayName: "Mo Chang" }}
      replies={[]}
      resolved={false}
      onReply={onReply}
      onResolve={() => {}}
      onDelete={() => {}}
      onClose={() => {}}
      {...overrides}
    />,
  )
  return { onReply }
}

function openReply() {
  fireEvent.click(screen.getByRole("button", { name: "Reply" }))
}

function typeReply(text: string, cursor = text.length) {
  fireEvent.change(screen.getByRole("combobox"), {
    target: { value: text, selectionStart: cursor },
  })
}

describe("the reply box", () => {
  it("offers @ only when the card was given a directory", () => {
    renderCard({ participants: PARTICIPANTS })
    openReply()
    expect(screen.getByPlaceholderText("Reply… (@ to mention)")).toBeTruthy()
  })

  it("stops offering @ when there is no directory behind the card", () => {
    renderCard()
    openReply()
    expect(screen.getByPlaceholderText("Reply…")).toBeTruthy()
    expect(screen.queryByPlaceholderText(/@ to mention/)).toBeNull()
  })

  it("opens the picker and sends the chosen name in the wire format", () => {
    const { onReply } = renderCard({ participants: PARTICIPANTS })
    openReply()
    typeReply("over to @rin")
    fireEvent.click(screen.getByRole("option", { name: /Rin Adeyemi/ }))
    // Cmd+Enter is the card's submit.
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter", metaKey: true })

    expect(onReply).toHaveBeenCalledWith("over to @[Rin Adeyemi](p_rin)")
  })

  it("never opens a picker on a card with no directory", () => {
    renderCard()
    openReply()
    typeReply("@rin")
    expect(screen.queryByRole("listbox")).toBeNull()
  })

  // The card closes the reply box on Escape. Dismissing the picker must not
  // also throw away the draft the user is halfway through writing.
  it("keeps the reply box open when Escape only dismissed the picker", () => {
    renderCard({ participants: PARTICIPANTS })
    openReply()
    typeReply("over to @rin")
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" })

    expect(screen.queryByRole("listbox")).toBeNull()
    expect(screen.getByRole("combobox")).toHaveProperty("value", "over to @rin")
  })

  // Focus can be INSIDE the picker (the invite field, an option button), where
  // the textarea's own handler never runs. That Escape reached the card's
  // window listener and took the draft with it.
  it("keeps the draft when Escape is pressed inside the picker", () => {
    renderCard({ participants: PARTICIPANTS, onInvite: async () => null })
    openReply()
    typeReply("over to @rin")
    fireEvent.keyDown(screen.getByPlaceholderText("Invite by email…"), { key: "Escape" })

    expect(screen.queryByRole("listbox")).toBeNull()
    expect(screen.getByRole("combobox")).toHaveProperty("value", "over to @rin")
  })

  it("keeps the draft when Escape is pressed on a highlighted option", () => {
    renderCard({ participants: PARTICIPANTS })
    openReply()
    typeReply("over to @rin")
    fireEvent.keyDown(screen.getByRole("option", { name: /Rin Adeyemi/ }), { key: "Escape" })

    expect(screen.queryByRole("listbox")).toBeNull()
    expect(screen.getByRole("combobox")).toHaveProperty("value", "over to @rin")
  })
})
