import { describe, it, expect } from "vitest"
import { collapseWhitespace, encodeReplacement, formatsForPath, scanCandidates, type TextCandidate } from "./text-encodings"

describe("formatsForPath", () => {
  it("maps .json to json", () => {
    expect(formatsForPath("content/home.json")).toEqual(["json"])
  })

  it("maps .js .ts .mjs .cjs to js-string only", () => {
    expect(formatsForPath("a.js")).toEqual(["js-string"])
    expect(formatsForPath("a.ts")).toEqual(["js-string"])
    expect(formatsForPath("a.mjs")).toEqual(["js-string"])
    expect(formatsForPath("a.cjs")).toEqual(["js-string"])
  })

  it("maps .jsx and .tsx to js-string plus element-text", () => {
    expect(formatsForPath("Card.jsx")).toEqual(["js-string", "element-text"])
    expect(formatsForPath("Card.tsx")).toEqual(["js-string", "element-text"])
  })

  it("maps .vue .svelte .astro .html to js-string plus element-text", () => {
    expect(formatsForPath("App.vue")).toEqual(["js-string", "element-text"])
    expect(formatsForPath("App.svelte")).toEqual(["js-string", "element-text"])
    expect(formatsForPath("page.astro")).toEqual(["js-string", "element-text"])
    expect(formatsForPath("index.html")).toEqual(["js-string", "element-text"])
  })

  it("maps .md and .mdx to markdown", () => {
    expect(formatsForPath("README.md")).toEqual(["markdown"])
    expect(formatsForPath("post.mdx")).toEqual(["markdown"])
  })

  it("maps .yml and .yaml to yaml", () => {
    expect(formatsForPath("locales/en.yml")).toEqual(["yaml"])
    expect(formatsForPath("locales/en.yaml")).toEqual(["yaml"])
  })

  it("returns an empty list for anything else, including dotfiles and no extension", () => {
    expect(formatsForPath("image.png")).toEqual([])
    expect(formatsForPath("Makefile")).toEqual([])
    expect(formatsForPath(".eslintrc")).toEqual([])
  })

  it("is case-insensitive on the extension", () => {
    expect(formatsForPath("DATA.JSON")).toEqual(["json"])
  })
})

describe("collapseWhitespace", () => {
  it("collapses internal whitespace runs to a single space and trims both ends", () => {
    expect(collapseWhitespace("  May 2022  -\n  present \t ")).toBe("May 2022 - present")
  })

  it("leaves already-plain text untouched", () => {
    expect(collapseWhitespace("Save changes")).toBe("Save changes")
  })
})

describe("scanCandidates: json", () => {
  it("finds both a key and a value as candidates", () => {
    const content = `{"title": "Hello"}`
    const candidates = scanCandidates(content, ["json"])
    const decoded = candidates.map((c) => c.decoded)
    expect(decoded).toContain("title")
    expect(decoded).toContain("Hello")
  })

  it("decodes an escaped quote and a curly apostrophe together (fixture with \\\" and ’)", () => {
    const content = `{"text": "She said \\"hi\\" and it’s fine"}`
    const candidates = scanCandidates(content, ["json"])
    const value = candidates.find((c) => c.decoded.startsWith("She said"))
    expect(value).toBeDefined()
    expect(value?.decoded).toBe('She said "hi" and it’s fine')
  })

  it("does not terminate a string at an escaped quote", () => {
    const content = `{"a": "one \\" two"}`
    const candidates = scanCandidates(content, ["json"])
    expect(candidates.some((c) => c.decoded === 'one " two')).toBe(true)
  })

  it("decodes \\n and \\uXXXX escapes", () => {
    const content = `{"a": "line one\\nline two", "b": "\\u0041\\u0042"}`
    const candidates = scanCandidates(content, ["json"])
    expect(candidates.some((c) => c.decoded === "line one\nline two")).toBe(true)
    expect(candidates.some((c) => c.decoded === "AB")).toBe(true)
  })

  it("byte range points exactly at the string content, excluding the quotes", () => {
    const content = `{"a": "hello"}`
    const candidates = scanCandidates(content, ["json"])
    const hello = candidates.find((c) => c.decoded === "hello")
    expect(hello).toBeDefined()
    expect(content.slice(hello!.byteStart, hello!.byteEnd)).toBe("hello")
  })
})

describe("scanCandidates: js-string", () => {
  it("finds single-quoted, double-quoted and backtick strings", () => {
    const content = `const a = 'one'\nconst b = "two"\nconst c = \`three\``
    const candidates = scanCandidates(content, ["js-string"])
    const decoded = candidates.map((c) => c.decoded)
    expect(decoded).toEqual(expect.arrayContaining(["one", "two", "three"]))
  })

  it("records the quote character used as style", () => {
    const content = `const a = 'one'\nconst b = "two"\nconst c = \`three\``
    const candidates = scanCandidates(content, ["js-string"])
    expect(candidates.find((c) => c.decoded === "one")?.style).toBe("'")
    expect(candidates.find((c) => c.decoded === "two")?.style).toBe('"')
    expect(candidates.find((c) => c.decoded === "three")?.style).toBe("`")
  })

  it("skips a template literal containing ${...}", () => {
    const content = "const greeting = `Hello ${name}`"
    const candidates = scanCandidates(content, ["js-string"])
    expect(candidates).toEqual([])
  })

  it("still finds a plain template literal after a skipped interpolated one", () => {
    const content = "const a = `Hi ${name}`\nconst b = `Plain`"
    const candidates = scanCandidates(content, ["js-string"])
    expect(candidates.map((c) => c.decoded)).toEqual(["Plain"])
  })

  it("skips quote-like characters inside a // line comment", () => {
    const content = "// don't match 'this'\nconst a = 'real'"
    const candidates = scanCandidates(content, ["js-string"])
    expect(candidates.map((c) => c.decoded)).toEqual(["real"])
  })

  it("skips quote-like characters inside a block comment", () => {
    const content = "/* skip 'this' and \"this\" */\nconst a = 'real'"
    const candidates = scanCandidates(content, ["js-string"])
    expect(candidates.map((c) => c.decoded)).toEqual(["real"])
  })

  describe("regex literals (P2: a quoted string inside a regex is not a candidate)", () => {
    it("does not find a string that only appears inside a regex literal", () => {
      const content = 'const p = /"Submit"/'
      const candidates = scanCandidates(content, ["js-string"])
      expect(candidates).toEqual([])
    })

    it("still finds a real string after a regex literal", () => {
      const content = "const p = /\"Submit\"/\nconst label = 'real'"
      const candidates = scanCandidates(content, ["js-string"])
      expect(candidates.map((c) => c.decoded)).toEqual(["real"])
    })

    it("recognizes a regex after common regex-preceding punctuation and keywords", () => {
      const cases = [
        "const p = /\"a\"/",
        "if (x) return /\"a\"/",
        "const t = typeof x === /\"a\"/",
        "switch (x) { case /\"a\"/: break }",
        "arr.filter((x) => /\"a\"/.test(x))",
      ]
      for (const content of cases) {
        expect(scanCandidates(content, ["js-string"])).toEqual([])
      }
    })

    it("division after an identifier does not swallow a following string as a regex", () => {
      const content = "const x = a / b\nconst s = 'kept'"
      const candidates = scanCandidates(content, ["js-string"])
      expect(candidates.map((c) => c.decoded)).toEqual(["kept"])
    })

    it("division after a number does not swallow a following string as a regex", () => {
      const content = "const x = 10 / 2\nconst s = 'kept'"
      const candidates = scanCandidates(content, ["js-string"])
      expect(candidates.map((c) => c.decoded)).toEqual(["kept"])
    })

    it("division after a closing paren does not swallow a following string as a regex", () => {
      const content = "const x = fn() / 2\nconst s = 'kept'"
      const candidates = scanCandidates(content, ["js-string"])
      expect(candidates.map((c) => c.decoded)).toEqual(["kept"])
    })

    it("honors a / inside a character class instead of ending the regex there", () => {
      const content = "const p = /[/]-\"not a string\"/\nconst s = 'kept'"
      const candidates = scanCandidates(content, ["js-string"])
      // The whole first line is consumed as one regex literal (the `/` in
      // `[/]` doesn't end it), so "not a string" is never a candidate;
      // only the real string on the next line is found.
      expect(candidates.map((c) => c.decoded)).toEqual(["kept"])
    })

    it("honors a \\/ escape inside a regex instead of ending it there", () => {
      const content = "const p = /a\\/\"not a string\"/\nconst s = 'kept'"
      const candidates = scanCandidates(content, ["js-string"])
      expect(candidates.map((c) => c.decoded)).toEqual(["kept"])
    })
  })
})

describe("scanCandidates: element-text", () => {
  it("finds text between > and <", () => {
    const content = "<p>Save changes</p>"
    const candidates = scanCandidates(content, ["element-text"])
    expect(candidates.map((c) => c.decoded)).toEqual(["Save changes"])
  })

  it("decodes named, decimal and hex entities", () => {
    const content = "<p>Fish &amp; Chips &#39;n&#x27; Stuff &rsquo;</p>"
    const candidates = scanCandidates(content, ["element-text"])
    expect(candidates[0].decoded).toBe("Fish & Chips 'n' Stuff ’")
  })

  describe("P3: the full HTML 4 named entity table (252 names) plus apos", () => {
    it("decodes &copy; (a Latin-1 entity beyond the original 13)", () => {
      const content = "<p>&copy; 2026</p>"
      const candidates = scanCandidates(content, ["element-text"])
      expect(candidates[0].decoded).toBe("© 2026")
    })

    it("decodes a symbol/Greek entity", () => {
      const content = "<p>&hearts; &Alpha; &trade;</p>"
      const candidates = scanCandidates(content, ["element-text"])
      expect(candidates[0].decoded).toBe("♥ Α ™")
    })

    it("decodes a special-character entity", () => {
      const content = "<p>&euro;10 &mdash; &ldquo;quoted&rdquo;</p>"
      const candidates = scanCandidates(content, ["element-text"])
      expect(candidates[0].decoded).toBe("€10 — “quoted”")
    })

    it("decodes &apos; (not HTML 4, but universally supported)", () => {
      const content = "<p>It&apos;s fine</p>"
      const candidates = scanCandidates(content, ["element-text"])
      expect(candidates[0].decoded).toBe("It's fine")
    })

    it("is case-sensitive: &Alpha; and &alpha; decode to different characters", () => {
      const content = "<p>&Alpha;&alpha;</p>"
      const candidates = scanCandidates(content, ["element-text"])
      expect(candidates[0].decoded).toBe("Αα")
    })

    it("leaves an unknown entity name untouched", () => {
      const content = "<p>&notarealentity;</p>"
      const candidates = scanCandidates(content, ["element-text"])
      expect(candidates[0].decoded).toBe("&notarealentity;")
    })
  })

  it("excludes a run containing a brace as a JSX expression", () => {
    const content = "<p>{count} items</p>"
    const candidates = scanCandidates(content, ["element-text"])
    expect(candidates).toEqual([])
  })

  it("does not treat a quoted > or < inside a tag as ending the tag", () => {
    const content = `<div title="a > b">Between tags</div>`
    const candidates = scanCandidates(content, ["element-text"])
    expect(candidates.map((c) => c.decoded)).toEqual(["Between tags"])
  })

  it("does not emit a candidate for text before the first tag", () => {
    const content = "leading text<p>real</p>"
    const candidates = scanCandidates(content, ["element-text"])
    expect(candidates.map((c) => c.decoded)).toEqual(["real"])
  })
})

describe("scanCandidates: markdown", () => {
  it("finds a paragraph line and a heading line, stripping the heading marks and space", () => {
    const content = "# Welcome\n\nThis is a paragraph.\n"
    const candidates = scanCandidates(content, ["markdown"])
    expect(candidates.map((c) => c.decoded)).toEqual(["Welcome", "This is a paragraph."])
  })

  it("skips a fenced code block", () => {
    const content = "Text before.\n```\nconst x = 'not a candidate'\n```\nText after.\n"
    const candidates = scanCandidates(content, ["markdown"])
    expect(candidates.map((c) => c.decoded)).toEqual(["Text before.", "Text after."])
  })

  it("skips YAML front matter", () => {
    const content = "---\ntitle: Not a candidate\n---\n\nReal paragraph.\n"
    const candidates = scanCandidates(content, ["markdown"])
    expect(candidates.map((c) => c.decoded)).toEqual(["Real paragraph."])
  })

  it("decodes a named entity so an &amp; line matches & in page text, and records style: entities", () => {
    const content = "Research &amp; Development\n"
    const candidates = scanCandidates(content, ["markdown"])
    expect(candidates).toHaveLength(1)
    expect(candidates[0].decoded).toBe("Research & Development")
    expect(candidates[0].style).toBe("entities")
  })

  it("decodes decimal and hex entities in a heading line", () => {
    const content = "# Fish &#38; Chips &#x27;n&#x27; Stuff\n"
    const candidates = scanCandidates(content, ["markdown"])
    expect(candidates[0].decoded).toBe("Fish & Chips 'n' Stuff")
    expect(candidates[0].style).toBe("entities")
  })

  it("leaves style unset when the line has no entities", () => {
    const content = "Plain paragraph, no entities here.\n"
    const candidates = scanCandidates(content, ["markdown"])
    expect(candidates[0].style).toBeUndefined()
  })

  it("joins a two-line paragraph block into one candidate, matching what the browser renders", () => {
    // MEASURED (live run, 2026-09-21): the browser collapses this hard-wrapped
    // paragraph's line break to a single space, so the page shows one string.
    // Before this fix, scanMarkdown emitted one candidate per line and
    // findUniqueText could never match it.
    const content =
      "Down in the basement archive, a technician catalogs reels of tape that\n" +
      "nobody has watched since the building changed hands in 1997.\n"
    const candidates = scanCandidates(content, ["markdown"])
    expect(candidates).toHaveLength(1)
    expect(candidates[0].decoded).toBe(
      "Down in the basement archive, a technician catalogs reels of tape that nobody has watched since the building changed hands in 1997.",
    )
  })

  it("joins a three-line paragraph block into one candidate", () => {
    const content = "Line one here.\nLine two here.\nLine three here.\n"
    const candidates = scanCandidates(content, ["markdown"])
    expect(candidates).toHaveLength(1)
    expect(candidates[0].decoded).toBe("Line one here. Line two here. Line three here.")
  })

  it("still finds a single-line paragraph as its own candidate", () => {
    const content = "Just one line.\n"
    const candidates = scanCandidates(content, ["markdown"])
    expect(candidates.map((c) => c.decoded)).toEqual(["Just one line."])
  })

  it("terminates a block at a following heading, so the heading is its own candidate", () => {
    const content = "Paragraph line one.\nParagraph line two.\n## Next section\n"
    const candidates = scanCandidates(content, ["markdown"])
    expect(candidates.map((c) => c.decoded)).toEqual(["Paragraph line one. Paragraph line two.", "Next section"])
  })

  it("records style: entities for a multi-line block when the second line uses an entity", () => {
    const content = "Fish and chips is\ngreat &amp; tasty.\n"
    const candidates = scanCandidates(content, ["markdown"])
    expect(candidates).toHaveLength(1)
    expect(candidates[0].decoded).toBe("Fish and chips is great & tasty.")
    expect(candidates[0].style).toBe("entities")
  })

  it("skips a block that starts with a list item, a blockquote, or a table row", () => {
    const content = "- one\n- two\n\n> quoted line\n\n| a | b |\n| - | - |\n\nReal paragraph.\n"
    const candidates = scanCandidates(content, ["markdown"])
    expect(candidates.map((c) => c.decoded)).toEqual(["Real paragraph."])
  })

  it("byte range for a multi-line block spans the whole block, including the embedded newline", () => {
    const content = "First half of it\nsecond half of it.\n"
    const candidates = scanCandidates(content, ["markdown"])
    expect(candidates).toHaveLength(1)
    const { byteStart, byteEnd } = candidates[0]
    expect(content.slice(byteStart, byteEnd)).toBe("First half of it\nsecond half of it.")
  })
})

describe("scanCandidates: yaml", () => {
  it("finds a plain scalar value from a key: value line", () => {
    const content = "title: Welcome home\n"
    const candidates = scanCandidates(content, ["yaml"])
    expect(candidates).toHaveLength(1)
    expect(candidates[0].decoded).toBe("Welcome home")
    expect(candidates[0].style).toBe("plain")
  })

  it("finds a plain scalar value from a - value list item", () => {
    const content = "items:\n  - First item\n  - Second item\n"
    const candidates = scanCandidates(content, ["yaml"])
    expect(candidates.map((c) => c.decoded)).toEqual(["First item", "Second item"])
  })

  it("finds single- and double-quoted scalars and records their style", () => {
    const content = `single: 'It''s fine'\ndouble: "Say \\"hi\\""\n`
    const candidates = scanCandidates(content, ["yaml"])
    const single = candidates.find((c) => c.style === "single")
    const double = candidates.find((c) => c.style === "double")
    expect(single?.decoded).toBe("It's fine")
    expect(double?.decoded).toBe('Say "hi"')
  })

  it("strips a trailing comment from a plain scalar", () => {
    const content = "title: Welcome home # shown on the landing page\n"
    const candidates = scanCandidates(content, ["yaml"])
    expect(candidates[0].decoded).toBe("Welcome home")
  })

  it("skips a whole-line comment", () => {
    const content = "# title: Not real\ntitle: Real value\n"
    const candidates = scanCandidates(content, ["yaml"])
    expect(candidates.map((c) => c.decoded)).toEqual(["Real value"])
  })
})

describe("scanCandidates + encodeReplacement: yaml round trip guards against a type change", () => {
  // The P1 bug this guards: `title: Hello` replaced with page text `true`
  // used to write `title: true` (a YAML boolean), not the string "true".
  it("replacing a plain scalar with the word true writes a quoted string, not a boolean", () => {
    const content = "title: Hello\n"
    const [found] = scanCandidates(content, ["yaml"])
    const result = encodeReplacement("true", found)
    expect(result).toEqual({ ok: true, bytes: "'true'" })
    const rewritten = content.slice(0, found.byteStart) + (result as { ok: true; bytes: string }).bytes + content.slice(found.byteEnd)
    expect(rewritten).toBe("title: 'true'\n")
  })

  it("replacing a plain scalar with an empty string writes an empty quoted string, not null", () => {
    const content = "title: Hello\n"
    const [found] = scanCandidates(content, ["yaml"])
    const result = encodeReplacement("", found)
    expect(result).toEqual({ ok: true, bytes: "''" })
    const rewritten = content.slice(0, found.byteStart) + (result as { ok: true; bytes: string }).bytes + content.slice(found.byteEnd)
    expect(rewritten).toBe("title: ''\n")
  })

  it("replacing a plain scalar with a number writes a quoted string, not a number", () => {
    const content = "title: Hello\n"
    const [found] = scanCandidates(content, ["yaml"])
    const result = encodeReplacement("42", found)
    expect(result).toEqual({ ok: true, bytes: "'42'" })
  })

  it("replacing a plain scalar with a date-shaped value writes a quoted string, not a date", () => {
    const content = "title: Hello\n"
    const [found] = scanCandidates(content, ["yaml"])
    const result = encodeReplacement("2026-09-21", found)
    expect(result).toEqual({ ok: true, bytes: "'2026-09-21'" })
  })
})

describe("encodeReplacement: json", () => {
  it("escapes quotes and newlines the way JSON.stringify would", () => {
    const candidate: TextCandidate = { byteStart: 0, byteEnd: 0, format: "json", decoded: "" }
    const result = encodeReplacement('Say "hi"\nnext line', candidate)
    expect(result).toEqual({ ok: true, bytes: 'Say \\"hi\\"\\nnext line' })
  })
})

describe("encodeReplacement: js-string", () => {
  const base: TextCandidate = { byteStart: 0, byteEnd: 0, format: "js-string", decoded: "" }

  it("escapes a single quote for single-quoted style", () => {
    const result = encodeReplacement("It's fine", { ...base, style: "'" })
    expect(result).toEqual({ ok: true, bytes: "It\\'s fine" })
  })

  it("escapes a double quote for double-quoted style", () => {
    const result = encodeReplacement('Say "hi"', { ...base, style: '"' })
    expect(result).toEqual({ ok: true, bytes: 'Say \\"hi\\"' })
  })

  it("escapes a backtick and ${ for template-literal style", () => {
    const result = encodeReplacement("Cost: `${5}`", { ...base, style: "`" })
    expect(result).toEqual({ ok: true, bytes: "Cost: \\`\\${5}\\`" })
  })

  it("escapes a newline as \\n for every style", () => {
    const result = encodeReplacement("line one\nline two", { ...base, style: "'" })
    expect(result).toEqual({ ok: true, bytes: "line one\\nline two" })
  })

  it("refuses when the quote style is unknown", () => {
    const result = encodeReplacement("text", base)
    expect(result.ok).toBe(false)
  })
})

describe("encodeReplacement: element-text", () => {
  const candidate: TextCandidate = { byteStart: 0, byteEnd: 0, format: "element-text", decoded: "" }

  it("encodes & < > as entities and leaves everything else literal", () => {
    const result = encodeReplacement("Fish & Chips < 5 > 2", candidate)
    expect(result).toEqual({ ok: true, bytes: "Fish &amp; Chips &lt; 5 &gt; 2" })
  })

  it("refuses when the replacement contains a brace", () => {
    const result = encodeReplacement("{count} items", candidate)
    expect(result.ok).toBe(false)
  })
})

describe("encodeReplacement: markdown", () => {
  const candidate: TextCandidate = { byteStart: 0, byteEnd: 0, format: "markdown", decoded: "" }

  it("writes the replacement literally when the original used no entities", () => {
    const result = encodeReplacement("Fish & Chips <3", candidate)
    expect(result).toEqual({ ok: true, bytes: "Fish & Chips <3" })
  })

  it("refuses when the replacement contains a newline", () => {
    const result = encodeReplacement("line one\nline two", candidate)
    expect(result.ok).toBe(false)
  })

  it("writes & and < as entities when the original candidate line used an entity", () => {
    const withEntities: TextCandidate = { ...candidate, style: "entities" }
    const result = encodeReplacement("Research & Development < 5", withEntities)
    expect(result).toEqual({ ok: true, bytes: "Research &amp; Development &lt; 5" })
  })

  it("round-trips an &amp; line through scanCandidates and encodeReplacement unchanged", () => {
    const content = "Research &amp; Development\n"
    const [found] = scanCandidates(content, ["markdown"])
    expect(found.decoded).toBe("Research & Development")
    const result = encodeReplacement(found.decoded, found)
    expect(result).toEqual({ ok: true, bytes: "Research &amp; Development" })
  })

  it("round-trips a multi-line block: the found candidate's own decoded text re-encodes to a single collapsed line", () => {
    const content = "First line of text\nsecond line of text.\n"
    const [found] = scanCandidates(content, ["markdown"])
    expect(found.decoded).toBe("First line of text second line of text.")
    const result = encodeReplacement(found.decoded, found)
    expect(result).toEqual({ ok: true, bytes: "First line of text second line of text." })
  })

  it("writes a multi-line block's replacement as one line in place of the whole block", () => {
    const content =
      "Down in the basement archive, a technician catalogs reels of tape that\n" +
      "nobody has watched since the building changed hands in 1997.\n"
    const [found] = scanCandidates(content, ["markdown"])
    const result = encodeReplacement("A technician now digitizes the reels instead.", found)
    expect(result).toEqual({ ok: true, bytes: "A technician now digitizes the reels instead." })
    const rewritten = content.slice(0, found.byteStart) + (result as { ok: true; bytes: string }).bytes + content.slice(found.byteEnd)
    expect(rewritten).toBe("A technician now digitizes the reels instead.\n")
  })

  it("still refuses a replacement newline for a multi-line block (it would split into a new markdown line)", () => {
    const content = "First line of text\nsecond line of text.\n"
    const [found] = scanCandidates(content, ["markdown"])
    const result = encodeReplacement("new first\nnew second", found)
    expect(result.ok).toBe(false)
  })
})

describe("encodeReplacement: yaml", () => {
  it("doubles an inner single quote for single-quoted style", () => {
    const candidate: TextCandidate = { byteStart: 0, byteEnd: 0, format: "yaml", decoded: "", style: "single" }
    const result = encodeReplacement("It's fine", candidate)
    expect(result).toEqual({ ok: true, bytes: "It''s fine" })
  })

  it("escapes backslash and quote for double-quoted style", () => {
    const candidate: TextCandidate = { byteStart: 0, byteEnd: 0, format: "yaml", decoded: "", style: "double" }
    const result = encodeReplacement('Say "hi"\\there', candidate)
    expect(result).toEqual({ ok: true, bytes: 'Say \\"hi\\"\\\\there' })
  })

  it("escapes a C0 control character for double-quoted style", () => {
    const candidate: TextCandidate = { byteStart: 0, byteEnd: 0, format: "yaml", decoded: "", style: "double" }
    const result = encodeReplacement("Tab\there", candidate)
    expect(result).toEqual({ ok: true, bytes: "Tab\\there" })
  })

  it("refuses a newline for double-quoted style (a multi-line quoted scalar needs indentation this module does not model)", () => {
    const candidate: TextCandidate = { byteStart: 0, byteEnd: 0, format: "yaml", decoded: "", style: "double" }
    const result = encodeReplacement("line one\nline two", candidate)
    expect(result.ok).toBe(false)
  })

  it("refuses a newline for single-quoted style", () => {
    const candidate: TextCandidate = { byteStart: 0, byteEnd: 0, format: "yaml", decoded: "", style: "single" }
    const result = encodeReplacement("line one\nline two", candidate)
    expect(result.ok).toBe(false)
  })

  it("writes a plain scalar literally when it needs no escaping and stays a string", () => {
    const candidate: TextCandidate = { byteStart: 0, byteEnd: 0, format: "yaml", decoded: "", style: "plain" }
    const result = encodeReplacement("Welcome home", candidate)
    expect(result).toEqual({ ok: true, bytes: "Welcome home" })
  })

  it("single-quotes a plain scalar that starts with an indicator character, instead of refusing", () => {
    const candidate: TextCandidate = { byteStart: 0, byteEnd: 0, format: "yaml", decoded: "", style: "plain" }
    for (const bad of ["- item", "*anchor", "#comment", "@user", "%tag", "!tag", "|literal", ">folded", "'quoted", '"quoted', "`code", "?key", "[a]", "{a}"]) {
      const result = encodeReplacement(bad, candidate)
      expect(result).toEqual({ ok: true, bytes: `'${bad.replace(/'/g, "''")}'` })
    }
  })

  it("single-quotes a plain scalar containing a : sequence, instead of refusing", () => {
    const candidate: TextCandidate = { byteStart: 0, byteEnd: 0, format: "yaml", decoded: "", style: "plain" }
    const result = encodeReplacement("Time: now", candidate)
    expect(result).toEqual({ ok: true, bytes: "'Time: now'" })
  })

  it("single-quotes a plain scalar containing a  # sequence, instead of refusing", () => {
    const candidate: TextCandidate = { byteStart: 0, byteEnd: 0, format: "yaml", decoded: "", style: "plain" }
    const result = encodeReplacement("Room #4", candidate)
    expect(result).toEqual({ ok: true, bytes: "'Room #4'" })
  })

  it("refuses a plain scalar containing a newline (single-quoting can't hold it either)", () => {
    const candidate: TextCandidate = { byteStart: 0, byteEnd: 0, format: "yaml", decoded: "", style: "plain" }
    expect(encodeReplacement("line one\nline two", candidate).ok).toBe(false)
  })

  it("refuses when the scalar style is unknown", () => {
    const candidate: TextCandidate = { byteStart: 0, byteEnd: 0, format: "yaml", decoded: "" }
    expect(encodeReplacement("text", candidate).ok).toBe(false)
  })

  describe("plain scalar: values that would be read as a non-string type get single-quoted", () => {
    const candidate: TextCandidate = { byteStart: 0, byteEnd: 0, format: "yaml", decoded: "", style: "plain" }

    it("an empty replacement (would load as null)", () => {
      expect(encodeReplacement("", candidate)).toEqual({ ok: true, bytes: "''" })
    })

    it.each(["true", "false", "yes", "no", "on", "off", "null", "~", "Null", "NULL", "True", "TRUE", "False", "FALSE"])(
      "the boolean/null token %s",
      (token) => {
        expect(encodeReplacement(token, candidate)).toEqual({ ok: true, bytes: `'${token}'` })
      },
    )

    it.each(["42", "-7", "0x1A", "0o17"])("the integer %s", (value) => {
      expect(encodeReplacement(value, candidate)).toEqual({ ok: true, bytes: `'${value}'` })
    })

    it.each(["3.14", "-0.5", "1e10", ".inf", "-.inf", ".nan"])("the float %s", (value) => {
      expect(encodeReplacement(value, candidate)).toEqual({ ok: true, bytes: `'${value}'` })
    })

    it("an ISO date", () => {
      expect(encodeReplacement("2026-09-21", candidate)).toEqual({ ok: true, bytes: "'2026-09-21'" })
    })

    it("an ISO timestamp", () => {
      expect(encodeReplacement("2026-09-21T10:00:00Z", candidate)).toEqual({
        ok: true,
        bytes: "'2026-09-21T10:00:00Z'",
      })
    })

    it("leading or trailing whitespace", () => {
      expect(encodeReplacement(" Hello", candidate)).toEqual({ ok: true, bytes: "' Hello'" })
      expect(encodeReplacement("Hello ", candidate)).toEqual({ ok: true, bytes: "'Hello '" })
    })

    it("doubles an inner single quote when falling back to single-quoted style", () => {
      // "- It's fine" needs quoting because it STARTS with an indicator
      // character ("-"), not because of the apostrophe; a plain apostrophe
      // needs no escaping on its own. This checks that the fallback still
      // escapes an inner quote correctly once it does kick in.
      expect(encodeReplacement("- It's fine", candidate)).toEqual({ ok: true, bytes: "'- It''s fine'" })
    })

    it("a plain replacement that reads as a string is unaffected (regression check)", () => {
      expect(encodeReplacement("truest", candidate)).toEqual({ ok: true, bytes: "truest" })
      expect(encodeReplacement("42nd Street", candidate)).toEqual({ ok: true, bytes: "42nd Street" })
    })
  })
})

describe("encodeReplacement, gaps from the Fable pass (2026-09-21)", () => {
  it("quotes a YAML plain scalar that would end in a colon", () => {
    const source = "title: Coming soon\n"
    const [c] = scanCandidates(source, ["yaml"])
    const out = encodeReplacement("Coming soon:", c)
    expect(out).toEqual({ ok: true, bytes: "'Coming soon:'" })
  })

  it("refuses a Markdown replacement that starts with a block marker", () => {
    const source = "Plain paragraph here.\n"
    const [c] = scanCandidates(source, ["markdown"])
    for (const after of ["- a list now", "> quoted", "## a heading", "#", "1. numbered", "| cell |"]) {
      const out = encodeReplacement(after, c)
      expect(out.ok).toBe(false)
    }
    expect(encodeReplacement("Still a paragraph: fine.", c)).toEqual({
      ok: true,
      bytes: "Still a paragraph: fine.",
    })
  })
})
