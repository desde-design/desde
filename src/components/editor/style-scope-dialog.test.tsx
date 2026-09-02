/**
 * Tests for the StyleScopeDialog (Phase 2).
 */
import { describe, expect, it, vi } from "vitest"
import { render, screen, fireEvent, within } from "@testing-library/react"
import { StyleScopeDialog } from "./style-scope-dialog"
import type { StyleOrigin } from "@/types/bridge"

const origin: StyleOrigin = {
  property: "background-color",
  computedValue: "rgb(247,247,247)",
  winningRule: {
    selector: ".acme-empty-state",
    stylesheet: { href: "http://x/node_modules/@acme/design-system/s.css", package: "@acme/design-system" },
    declaration: "background-color: var(--acme-color-background-disabled)",
    specificity: [0, 1, 0],
  },
  varChain: [
    {
      name: "--acme-color-background-disabled",
      value: "#f7f7f7",
      definedAt: { selector: ":root", stylesheet: { href: "http://x/tokens.css" } },
    },
  ],
}

function renderDialog(over: Partial<React.ComponentProps<typeof StyleScopeDialog>> = {}) {
  const onConfirm = vi.fn()
  const onCancel = vi.fn()
  render(
    <StyleScopeDialog
      open
      property="background-color"
      origin={origin}
      scopes={["element", "page", "token"]}
      enabledScopes={["element"]}
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...over}
    />,
  )
  return { onConfirm, onCancel }
}

describe("StyleScopeDialog", () => {
  it("renders only the available scopes", () => {
    renderDialog()
    expect(screen.getByTestId("style-scope-element")).toBeInTheDocument()
    expect(screen.getByTestId("style-scope-page")).toBeInTheDocument()
    expect(screen.getByTestId("style-scope-token")).toBeInTheDocument()
    // component not in scopes → not rendered
    expect(screen.queryByTestId("style-scope-component")).not.toBeInTheDocument()
  })

  it("enables only the wired scopes; disables the rest with a coming-soon note", () => {
    renderDialog()
    expect(within(screen.getByTestId("style-scope-element")).getByRole("radio", { hidden: true })).toBeEnabled()
    expect(within(screen.getByTestId("style-scope-page")).getByRole("radio", { hidden: true })).toBeDisabled()
    expect(within(screen.getByTestId("style-scope-token")).getByRole("radio", { hidden: true })).toBeDisabled()
    // Both disabled scopes carry the coming-soon note.
    expect(screen.getAllByText(/coming soon/i)).toHaveLength(2)
  })

  // See iteration-scope-dialog.test.tsx — the remember checkbox is dormant
  // behind EDITOR_REMEMBER_SCOPE_CHOICE; `remember` is wired but always false,
  // so `rememberedScopeRef` in inspector-panel.tsx is never written.
  it("does not offer the remember checkbox, and always confirms remember=false", () => {
    const { onConfirm } = renderDialog()
    expect(screen.queryByTestId("style-scope-remember")).toBeNull()
    fireEvent.click(screen.getByTestId("style-scope-element"))
    fireEvent.click(screen.getByTestId("style-scope-confirm"))
    expect(onConfirm).toHaveBeenCalledExactlyOnceWith("element", false)
  })

  it("shows the provenance grounding (token name) inline", () => {
    renderDialog()
    // Appears in both the "From:" grounding row and the token-scope hint.
    expect(
      screen.getAllByText(/--acme-color-background-disabled/).length,
    ).toBeGreaterThanOrEqual(1)
  })

  it("cancels via the Cancel button, without confirming", () => {
    const { onCancel, onConfirm } = renderDialog()
    // No confirm click here on purpose: clicking both made this pass even if
    // Cancel did nothing, because the confirm path also closes the dialog.
    fireEvent.click(screen.getByTestId("style-scope-cancel"))
    expect(onCancel).toHaveBeenCalledOnce()
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it("reports the literal usage count (blast radius) when tokenUsageCount is known", () => {
    renderDialog({ origin: { ...origin, tokenUsageCount: 4 } })
    expect(screen.getByText(/used in 4 places across the prototype/i)).toBeInTheDocument()
  })

  it("singularizes at exactly one usage site", () => {
    renderDialog({ origin: { ...origin, tokenUsageCount: 1 } })
    expect(screen.getByText(/used in 1 place\b/i)).toBeInTheDocument()
  })

  it("falls back to the generic token warning when the count is absent", () => {
    renderDialog() // origin has no tokenUsageCount
    expect(screen.getByText(/affects every use of the token/i)).toBeInTheDocument()
  })
})

describe("StyleScopeDialog — outranked element scope (rec 3)", () => {
  it("renders scopes in the order given, so a deprioritised element lands last", () => {
    renderDialog({ scopes: ["token", "page", "element"] })
    const tiles = screen.getAllByTestId(/^style-scope-(element|page|token)$/)
    expect(tiles.map((t) => t.getAttribute("data-testid"))).toEqual([
      "style-scope-token",
      "style-scope-page",
      "style-scope-element",
    ])
  })

  it("annotates the element tile with why it probably won't take effect", () => {
    renderDialog({ scopes: ["token", "element"], elementScopeOutranked: true })
    expect(screen.getByTestId("style-scope-element")).toHaveTextContent(
      /unlikely to take effect/i,
    )
    // Still selectable — deprioritised, not removed.
    expect(within(screen.getByTestId("style-scope-element")).getByRole("radio", { hidden: true })).toBeEnabled()
  })

  it("carries no such annotation on an ordinary substrate", () => {
    renderDialog()
    expect(screen.getByTestId("style-scope-element")).not.toHaveTextContent(
      /unlikely to take effect/i,
    )
  })
})
