import { describe, it, expect } from "vitest"
import { findUniqueText, type SearchFile } from "./find-unique-text"

describe("findUniqueText: empty-before", () => {
  it("refuses an empty string before any search runs", () => {
    const files: SearchFile[] = [{ path: "a.json", content: `{"a": "hello"}` }]
    const result = findUniqueText(files, "")
    expect(result).toEqual({ ok: false, code: "empty-before", reason: expect.any(String) })
  })

  it("refuses a whitespace-only string", () => {
    const files: SearchFile[] = [{ path: "a.json", content: `{"a": "hello"}` }]
    const result = findUniqueText(files, "   \n\t  ")
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe("empty-before")
  })
})

describe("findUniqueText: zero matches", () => {
  it("refuses with no-match when the text is nowhere", () => {
    const files: SearchFile[] = [{ path: "a.json", content: `{"a": "hello"}` }]
    const result = findUniqueText(files, "goodbye")
    expect(result).toEqual({ ok: false, code: "no-match", reason: expect.any(String) })
  })
})

describe("findUniqueText: exactly one match", () => {
  it("finds the single occurrence and reports its file and candidate", () => {
    const files: SearchFile[] = [
      { path: "content/home.json", content: `{"role": "May 2022 - present"}` },
      { path: "content/about.json", content: `{"note": "unrelated"}` },
    ]
    const result = findUniqueText(files, "May 2022 - present")
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.occurrence.path).toBe("content/home.json")
    expect(result.occurrence.candidate.decoded).toBe("May 2022 - present")
  })
})

describe("findUniqueText: many matches", () => {
  it("refuses with many-matches and the count for two occurrences in the same file", () => {
    const files: SearchFile[] = [
      { path: "a.json", content: `{"a": "Email", "b": "Email"}` },
    ]
    const result = findUniqueText(files, "Email")
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe("many-matches")
    expect(result.count).toBe(2)
    expect(result.paths).toEqual(["a.json"])
  })

  it("refuses with many-matches and every distinct path for occurrences across files", () => {
    const files: SearchFile[] = [
      { path: "b.json", content: `{"a": "Email"}` },
      { path: "a.json", content: `{"a": "Email"}` },
    ]
    const result = findUniqueText(files, "Email")
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe("many-matches")
    expect(result.count).toBe(2)
    // Deterministic order regardless of input order: sorted.
    expect(result.paths).toEqual(["a.json", "b.json"])
  })
})

describe("findUniqueText: the whole-value rule", () => {
  it("does not match text that is only a substring of a longer candidate", () => {
    const files: SearchFile[] = [{ path: "a.json", content: `{"role": "Role: May 2022 - present"}` }]
    const result = findUniqueText(files, "May 2022 - present")
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe("no-match")
  })

  it("matches the surrounding text exactly when that is what's asked for", () => {
    const files: SearchFile[] = [{ path: "a.json", content: `{"role": "Role: May 2022 - present"}` }]
    const result = findUniqueText(files, "Role: May 2022 - present")
    expect(result.ok).toBe(true)
  })
})

describe("findUniqueText: whitespace collapse", () => {
  it("matches a JSON string whose escaped newlines decode differently than a spaced before", () => {
    const files: SearchFile[] = [
      { path: "a.json", content: `{"a": "a string\\nwith embedded\\nnewlines"}` },
    ]
    const result = findUniqueText(files, "a string with embedded newlines")
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.occurrence.candidate.decoded).toBe("a string\nwith embedded\nnewlines")
  })
})

describe("findUniqueText: one match per format", () => {
  it("js-string", () => {
    const files: SearchFile[] = [{ path: "a.ts", content: "export const label = 'Save changes'" }]
    const result = findUniqueText(files, "Save changes")
    expect(result.ok).toBe(true)
  })

  it("element-text", () => {
    const files: SearchFile[] = [{ path: "Card.tsx", content: "<button>Save changes</button>" }]
    const result = findUniqueText(files, "Save changes")
    expect(result.ok).toBe(true)
  })

  it("markdown", () => {
    const files: SearchFile[] = [{ path: "README.md", content: "# Welcome\n\nSave changes.\n" }]
    const result = findUniqueText(files, "Save changes.")
    expect(result.ok).toBe(true)
  })

  it("yaml", () => {
    const files: SearchFile[] = [{ path: "locales/en.yaml", content: "cta: Save changes\n" }]
    const result = findUniqueText(files, "Save changes")
    expect(result.ok).toBe(true)
  })
})

describe("findUniqueText: deadline", () => {
  it("returns a timeout when the deadline has already passed before scanning a later file", () => {
    const files: SearchFile[] = [
      { path: "a.json", content: '{"a": "first"}' },
      { path: "b.json", content: '{"a": "Email"}' },
    ]
    // The first file's check passes (now() is still before the deadline);
    // by the time the loop reaches the second file, the fake clock has
    // jumped past it.
    const clock = [0, 10_000]
    const now = () => clock.shift() ?? 10_000
    const result = findUniqueText(files, "Email", { now, at: 500 })
    expect(result).toEqual({ ok: false, code: "timeout", reason: "Searching the project took too long." })
  })

  it("does not time out when the deadline has not passed", () => {
    const files: SearchFile[] = [{ path: "a.json", content: `{"a": "Email"}` }]
    const result = findUniqueText(files, "Email", { now: () => 0, at: 500 })
    expect(result.ok).toBe(true)
  })

  it("is unaffected when no deadline is passed at all", () => {
    const files: SearchFile[] = [{ path: "a.json", content: `{"a": "Email"}` }]
    const result = findUniqueText(files, "Email")
    expect(result.ok).toBe(true)
  })
})

describe("findUniqueText: files with no searchable format are skipped", () => {
  it("ignores a file whose extension maps to no format", () => {
    const files: SearchFile[] = [
      { path: "logo.png", content: "Save changes" },
      { path: "a.ts", content: "export const label = 'Save changes'" },
    ]
    const result = findUniqueText(files, "Save changes")
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.occurrence.path).toBe("a.ts")
  })
})
