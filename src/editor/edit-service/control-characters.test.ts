import { describe, expect, it } from "vitest"
import { sanitizeField } from "./build-edit-escalation-prompt"
import { flattenControlCharacters, hasControlCharacters } from "./control-characters"
import { iterationTextProblem } from "./iteration-text-limits"

// Named, and written as escapes, so a diff of this file cannot silently lose
// one of them to an editor that normalises invisible characters.
const NUL = "\u0000"
const BELL = "\u0007"
const DEL = "\u007F"
const C1_NEXT_LINE = "\u0085"
const C1_APC = "\u009F"
const LINE_SEPARATOR = "\u2028"
const PARAGRAPH_SEPARATOR = "\u2029"

describe("the shared control-character class", () => {
  it("covers C0, DEL, C1 and the two Unicode line separators", () => {
    const all = [
      NUL,
      BELL,
      "\n",
      "\r",
      "\t",
      DEL,
      C1_NEXT_LINE,
      C1_APC,
      LINE_SEPARATOR,
      PARAGRAPH_SEPARATOR,
    ]
    for (const ch of all) expect(hasControlCharacters(`a${ch}b`)).toBe(true)
  })

  it("leaves ordinary text alone, including non-ASCII", () => {
    expect(hasControlCharacters("items.map((row) => row.name) ü")).toBe(false)
    expect(flattenControlCharacters("plain")).toBe("plain")
  })

  it("collapses a run to one space", () => {
    expect(flattenControlCharacters(`a\r\n\n${LINE_SEPARATOR}b`)).toBe("a b")
  })

  it("carries no lastIndex state across calls", () => {
    // The flattening regex is global. Two calls in a row must agree.
    expect(hasControlCharacters("a\nb")).toBe(true)
    expect(hasControlCharacters("a\nb")).toBe(true)
    expect(flattenControlCharacters("a\nb")).toBe("a b")
    expect(flattenControlCharacters("a\nb")).toBe("a b")
  })
})

describe("iterationTextProblem uses that same class", () => {
  // It used to cover C0 and DEL only, so a `v-for` expression carrying a
  // Unicode line separator passed the boundary and reached a prompt builder
  // that had to flatten it anyway. The narrower rule was deciding what was
  // safe to send.
  it("refuses a Unicode line separator", () => {
    expect(iterationTextProblem("expression", `items${LINE_SEPARATOR}evil`)).toBe(
      "expression contains control characters",
    )
    expect(iterationTextProblem("expression", `items${PARAGRAPH_SEPARATOR}evil`)).toBe(
      "expression contains control characters",
    )
  })

  it("refuses a C1 control character", () => {
    expect(iterationTextProblem("key", `row${C1_NEXT_LINE}2`)).toBe(
      "key contains control characters",
    )
    expect(iterationTextProblem("key", `row${C1_APC}2`)).toBe("key contains control characters")
  })

  it("still refuses C0 and DEL, and still accepts ordinary text", () => {
    expect(iterationTextProblem("expression", "a\nb")).toBe(
      "expression contains control characters",
    )
    expect(iterationTextProblem("expression", `a${DEL}b`)).toBe(
      "expression contains control characters",
    )
    expect(iterationTextProblem("expression", "item in items")).toBeNull()
  })
})

describe("sanitizeField on a value that is not a string", () => {
  // Every value it renders is typed off a `postMessage` payload, so the type
  // is a claim nothing checked. Throwing halfway through composing a hand-off
  // message is the wrong answer; the empty string is the right one, and the
  // builders turn that into "(none)".
  it("returns the empty string rather than throwing", () => {
    expect(sanitizeField(undefined as never)).toBe("")
    expect(sanitizeField(null as never)).toBe("")
    expect(sanitizeField(42 as never)).toBe("")
    expect(sanitizeField({} as never)).toBe("")
    expect(sanitizeField([] as never)).toBe("")
  })

  it("still flattens and caps a real string", () => {
    expect(sanitizeField(`a\n${LINE_SEPARATOR}b`)).toBe("a b")
    expect(sanitizeField("abcdef", 3)).toBe("abc... (truncated at 3 characters)")
  })
})
