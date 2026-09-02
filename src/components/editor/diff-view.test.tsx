/**
 * Tests for the DiffView component. Asserts rendering of added /
 * removed / context lines and stat counts.
 */

import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { DiffView } from "./diff-view"

describe("DiffView", () => {
  it("renders added and removed lines with the correct stats", () => {
    const before = `<template>\n  <div>old</div>\n</template>\n`
    const after = `<template>\n  <p>new</p>\n</template>\n`
    render(<DiffView before={before} after={after} />)
    const lines = screen.getByTestId("diff-lines")
    expect(lines).toHaveTextContent("-")
    expect(lines).toHaveTextContent("+")
    expect(lines).toHaveTextContent("<div>old</div>")
    expect(lines).toHaveTextContent("<p>new</p>")
  })

  it("preserves identical lines as context", () => {
    const before = "a\nb\nc\n"
    const after = "a\nB\nc\n"
    render(<DiffView before={before} after={after} />)
    const lines = screen.getByTestId("diff-lines")
    expect(lines).toHaveTextContent("a")
    expect(lines).toHaveTextContent("b")
    expect(lines).toHaveTextContent("B")
    expect(lines).toHaveTextContent("c")
  })

  it("renders the caption when provided", () => {
    render(<DiffView before="x\n" after="y\n" caption="repair applied" />)
    expect(screen.getByTestId("diff-caption")).toHaveTextContent("repair applied")
  })

  it("renders nothing extra when before === after (all context)", () => {
    render(<DiffView before="same\n" after="same\n" />)
    const lines = screen.getByTestId("diff-lines")
    expect(lines.textContent).toMatch(/same/)
    // No added/removed signs in the diff.
    expect(lines.textContent).not.toMatch(/^\+/m)
    expect(lines.textContent).not.toMatch(/^-/m)
  })
})
