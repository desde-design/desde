import { describe, it, expect } from "vitest"
import { applyUniqueTextEdit } from "./apply-unique-text-edit"
import { scanCandidates, type TextCandidate } from "./text-encodings"
import { findUniqueText } from "./find-unique-text"

/** Find the one candidate in `source` whose decoded value is `before`. */
function locate(source: string, format: TextCandidate["format"], before: string): TextCandidate {
  const candidate = scanCandidates(source, [format]).find((c) => c.decoded === before)
  if (!candidate) throw new Error(`Fixture bug: no ${format} candidate decodes to ${JSON.stringify(before)}`)
  return candidate
}

describe("applyUniqueTextEdit: success per format, with a scan -> apply -> scan round trip", () => {
  it("json", () => {
    const source = `{"greeting": "Hello world"}`
    const candidate = locate(source, "json", "Hello world")
    const result = applyUniqueTextEdit({ source, candidate, before: "Hello world", after: "Hi there" })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.source).toBe(`{"greeting": "Hi there"}`)
    const found = findUniqueText([{ path: "a.json", content: result.source }], "Hi there")
    expect(found.ok).toBe(true)
  })

  it("js-string, single-quoted", () => {
    const source = "export const label = 'Hello world'"
    const candidate = locate(source, "js-string", "Hello world")
    const result = applyUniqueTextEdit({ source, candidate, before: "Hello world", after: "Hi there" })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.source).toBe("export const label = 'Hi there'")
    const found = findUniqueText([{ path: "a.ts", content: result.source }], "Hi there")
    expect(found.ok).toBe(true)
  })

  it("js-string, double-quoted", () => {
    const source = 'export const label = "Hello world"'
    const candidate = locate(source, "js-string", "Hello world")
    const result = applyUniqueTextEdit({ source, candidate, before: "Hello world", after: 'Say "hi"' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.source).toBe('export const label = "Say \\"hi\\""')
    const found = findUniqueText([{ path: "a.ts", content: result.source }], 'Say "hi"')
    expect(found.ok).toBe(true)
  })

  it("js-string, template literal with no expression", () => {
    const source = "export const label = `Hello world`"
    const candidate = locate(source, "js-string", "Hello world")
    const result = applyUniqueTextEdit({ source, candidate, before: "Hello world", after: "Hi there" })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.source).toBe("export const label = `Hi there`")
    const found = findUniqueText([{ path: "a.ts", content: result.source }], "Hi there")
    expect(found.ok).toBe(true)
  })

  it("element-text", () => {
    const source = "<button>Hello world</button>"
    const candidate = locate(source, "element-text", "Hello world")
    const result = applyUniqueTextEdit({ source, candidate, before: "Hello world", after: "Hi there" })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.source).toBe("<button>Hi there</button>")
    const found = findUniqueText([{ path: "Card.tsx", content: result.source }], "Hi there")
    expect(found.ok).toBe(true)
  })

  it("markdown, a paragraph line", () => {
    const source = "Hello world\n"
    const candidate = locate(source, "markdown", "Hello world")
    const result = applyUniqueTextEdit({ source, candidate, before: "Hello world", after: "Hi there" })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.source).toBe("Hi there\n")
    const found = findUniqueText([{ path: "README.md", content: result.source }], "Hi there")
    expect(found.ok).toBe(true)
  })

  it("markdown, a heading line", () => {
    const source = "## Hello world\n"
    const candidate = locate(source, "markdown", "Hello world")
    const result = applyUniqueTextEdit({ source, candidate, before: "Hello world", after: "Hi there" })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.source).toBe("## Hi there\n")
  })

  it("yaml, plain scalar", () => {
    const source = "title: Hello world\n"
    const candidate = locate(source, "yaml", "Hello world")
    const result = applyUniqueTextEdit({ source, candidate, before: "Hello world", after: "Hi there" })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.source).toBe("title: Hi there\n")
    const found = findUniqueText([{ path: "en.yaml", content: result.source }], "Hi there")
    expect(found.ok).toBe(true)
  })

  it("yaml, single-quoted scalar", () => {
    const source = "title: 'Hello world'\n"
    const candidate = locate(source, "yaml", "Hello world")
    const result = applyUniqueTextEdit({ source, candidate, before: "Hello world", after: "It's fine" })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.source).toBe("title: 'It''s fine'\n")
    const found = findUniqueText([{ path: "en.yaml", content: result.source }], "It's fine")
    expect(found.ok).toBe(true)
  })

  it("yaml, double-quoted scalar", () => {
    const source = 'title: "Hello world"\n'
    const candidate = locate(source, "yaml", "Hello world")
    const result = applyUniqueTextEdit({ source, candidate, before: "Hello world", after: 'Say "hi"' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.source).toBe('title: "Say \\"hi\\""\n')
    const found = findUniqueText([{ path: "en.yaml", content: result.source }], 'Say "hi"')
    expect(found.ok).toBe(true)
  })
})

describe("applyUniqueTextEdit: refusals", () => {
  it("refuses when the byte range no longer fits inside the file", () => {
    const source = "short"
    const candidate: TextCandidate = { byteStart: 0, byteEnd: 100, format: "markdown", decoded: "short" }
    const result = applyUniqueTextEdit({ source, candidate, before: "short", after: "long" })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason.length).toBeGreaterThan(0)
  })

  it("refuses when the source no longer holds that text at the candidate's position", () => {
    const original = "Hello world\n"
    const candidate = locate(original, "markdown", "Hello world")
    // The file changed underneath the candidate before the edit was applied.
    const changedSource = "Something else\n"
    const result = applyUniqueTextEdit({ source: changedSource, candidate, before: "Hello world", after: "Hi there" })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason.length).toBeGreaterThan(0)
  })

  it("propagates an encode refusal for element-text (after contains a brace)", () => {
    const source = "<button>Hello world</button>"
    const candidate = locate(source, "element-text", "Hello world")
    const result = applyUniqueTextEdit({ source, candidate, before: "Hello world", after: "{count} items" })
    expect(result.ok).toBe(false)
  })

  it("propagates an encode refusal for markdown (after contains a newline)", () => {
    const source = "Hello world\n"
    const candidate = locate(source, "markdown", "Hello world")
    const result = applyUniqueTextEdit({ source, candidate, before: "Hello world", after: "line one\nline two" })
    expect(result.ok).toBe(false)
  })

  it("single-quotes a plain YAML scalar replacement that starts with a special character, instead of refusing", () => {
    const source = "title: Hello world\n"
    const candidate = locate(source, "yaml", "Hello world")
    const result = applyUniqueTextEdit({ source, candidate, before: "Hello world", after: "- not a list item" })
    expect(result).toEqual({ ok: true, source: "title: '- not a list item'\n" })
  })

  it("single-quotes a plain YAML scalar replacement that would otherwise read as a boolean (P1 type-change guard)", () => {
    const source = "title: Hello world\n"
    const candidate = locate(source, "yaml", "Hello world")
    const result = applyUniqueTextEdit({ source, candidate, before: "Hello world", after: "true" })
    expect(result).toEqual({ ok: true, source: "title: 'true'\n" })
    const found = findUniqueText([{ path: "en.yaml", content: (result as { ok: true; source: string }).source }], "true")
    expect(found.ok).toBe(true)
  })

  it("propagates an encode refusal for a plain YAML scalar (after contains a newline)", () => {
    const source = "title: Hello world\n"
    const candidate = locate(source, "yaml", "Hello world")
    const result = applyUniqueTextEdit({ source, candidate, before: "Hello world", after: "line one\nline two" })
    expect(result.ok).toBe(false)
  })

  it("refusal reasons read as plain English: no em dash, no first person", () => {
    const source = "Hello world\n"
    const candidate = locate(source, "markdown", "Hello world")
    const result = applyUniqueTextEdit({ source, candidate, before: "Hello world", after: "a\nb" })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).not.toMatch(/—/)
    expect(result.reason).not.toMatch(/\bI\b/)
  })
})
