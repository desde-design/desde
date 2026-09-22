/**
 * Per-format decode and encode for the unique-text edit step
 * (`docs/superpowers/specs/2026-09-21-unique-text-edit-design.md`).
 *
 * A prototype's visible text lives in the file the way that file's format
 * stores strings: a JSON string escape, a JS string or template literal, raw
 * HTML text between tags, a Markdown line, or a YAML scalar. This module
 * knows how to find every candidate string in a file's content (`scanCandidates`)
 * and decode it to the plain text a user would read on the page, and how to
 * turn a user's replacement text back into that format's bytes
 * (`encodeReplacement`).
 *
 * Pure and filesystem-free: it only ever sees `content: string`. Finding
 * files, applying limits, and writing the result back to disk are the job of
 * `editor-cli/src/server/collect-search-files.ts` and `unique-text-step.ts`.
 */

export type TextFormat = "json" | "js-string" | "element-text" | "markdown" | "yaml"

export interface TextCandidate {
  /** Byte offset (inclusive) in `content` where the candidate's raw bytes start. */
  byteStart: number
  /** Byte offset (exclusive) in `content` where the candidate's raw bytes end. */
  byteEnd: number
  format: TextFormat
  /** The candidate decoded to plain text, as a page would render it. */
  decoded: string
  /**
   * How the candidate is written in source, when the format has more than
   * one way to write a scalar: the quote character for `js-string`
   * (`'`, `"`, or `` ` ``), the scalar style for `yaml`
   * (`"plain"`, `"single"`, or `"double"`), or, for `markdown`, the literal
   * string `"entities"` when the original line wrote HTML entities (so
   * `encodeReplacement` writes `<` and `&` back as entities instead of
   * literally). Unused for `json` and `element-text`, which each have
   * exactly one written form.
   */
  style?: string
}

export type EncodeReplacementResult = { ok: true; bytes: string } | { ok: false; reason: string }

/**
 * Collapse every run of whitespace (spaces, tabs, newlines) to a single
 * space and trim both ends. Used to compare "the same text" across a
 * hard-wrapped JSON string, a multi-line JSX text node, and a plain
 * `before` typed by a user, none of which agree on where the line breaks
 * fall.
 */
export function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim()
}

/**
 * Which formats a file's extension makes searchable, and in what order
 * `scanCandidates` should look for them. `[]` means the file is not
 * searchable at all (binary, config, or an extension this step doesn't
 * understand yet).
 */
export function formatsForPath(path: string): TextFormat[] {
  switch (extname(path)) {
    case ".json":
      return ["json"]
    case ".js":
    case ".ts":
    case ".mjs":
    case ".cjs":
      return ["js-string"]
    case ".jsx":
    case ".tsx":
      return ["js-string", "element-text"]
    case ".vue":
    case ".svelte":
    case ".astro":
    case ".html":
      return ["js-string", "element-text"]
    case ".md":
    case ".mdx":
      return ["markdown"]
    case ".yml":
    case ".yaml":
      return ["yaml"]
    default:
      return []
  }
}

function extname(filePath: string): string {
  const base = filePath.split(/[\\/]/).pop() ?? filePath
  const dot = base.lastIndexOf(".")
  // A dotfile like ".eslintrc" has no extension in this sense; `dot === 0`
  // means the dot is the leading character, not a separator.
  if (dot <= 0) return ""
  return base.slice(dot).toLowerCase()
}

/**
 * Find every candidate string of the given formats in `content`. Formats
 * scan independently of each other (a `.vue` file's `js-string` candidates
 * and its `element-text` candidates come from two separate passes) and the
 * combined result is sorted by position for deterministic output.
 */
export function scanCandidates(content: string, formats: TextFormat[]): TextCandidate[] {
  const candidates: TextCandidate[] = []
  for (const format of formats) {
    switch (format) {
      case "json":
        candidates.push(...scanJson(content))
        break
      case "js-string":
        candidates.push(...scanJsString(content))
        break
      case "element-text":
        candidates.push(...scanElementText(content))
        break
      case "markdown":
        candidates.push(...scanMarkdown(content))
        break
      case "yaml":
        candidates.push(...scanYaml(content))
        break
    }
  }
  return candidates.sort((a, b) => a.byteStart - b.byteStart)
}

/**
 * Encode a user's replacement text (`after`) back into the bytes the
 * candidate's format expects at `candidate`'s position. The caller splices
 * the result directly into `source.slice(0, byteStart) + bytes +
 * source.slice(byteEnd)` — it never re-wraps in quotes or brackets that
 * `byteStart`/`byteEnd` already excluded.
 */
export function encodeReplacement(after: string, candidate: TextCandidate): EncodeReplacementResult {
  switch (candidate.format) {
    case "json":
      return { ok: true, bytes: JSON.stringify(after).slice(1, -1) }
    case "js-string":
      return encodeJsStringReplacement(after, candidate.style)
    case "element-text":
      return encodeElementTextReplacement(after)
    case "markdown":
      return encodeMarkdownReplacement(after, candidate.style)
    case "yaml":
      return encodeYamlReplacement(after, candidate.style)
  }
}

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

/**
 * Walk the raw text looking for JSON string literals (double-quoted only —
 * JSON has no other string form). Both object keys and values are
 * candidates; this never parses the document as JSON, it only needs to find
 * where each string literal starts and ends, honoring `\"` so an escaped
 * quote doesn't end the literal early.
 */
function scanJson(content: string): TextCandidate[] {
  const candidates: TextCandidate[] = []
  const n = content.length
  let i = 0
  while (i < n) {
    if (content[i] === '"') {
      const start = i + 1
      const end = findStringEnd(content, start, '"')
      if (end === -1) {
        // Unterminated on this line — not valid JSON, skip past it rather
        // than let one bad quote swallow the rest of the file.
        i = start
        continue
      }
      const raw = content.slice(start, end)
      const decoded = decodeJsonStringContent(raw)
      if (decoded !== null) {
        candidates.push({ byteStart: start, byteEnd: end, format: "json", decoded })
      }
      i = end + 1
      continue
    }
    i++
  }
  return candidates
}

function decodeJsonStringContent(raw: string): string | null {
  try {
    return JSON.parse(`"${raw}"`) as string
  } catch {
    return null
  }
}

/**
 * Scan forward from `start` (just past an opening quote) for the matching
 * unescaped `quote`. A backslash always consumes the next character, so
 * `\"` and `\\` never terminate the string early. An unescaped newline ends
 * the search without a match — a single-line string can't legitimately
 * contain one.
 */
function findStringEnd(content: string, start: number, quote: string): number {
  let i = start
  const n = content.length
  while (i < n) {
    const c = content[i]
    if (c === "\\") {
      i += 2
      continue
    }
    if (c === quote) return i
    if (c === "\n") return -1
    i++
  }
  return -1
}

// ---------------------------------------------------------------------------
// JS / TS strings and template literals
// ---------------------------------------------------------------------------

/**
 * Punctuation tokens after which a `/` starts a regex literal rather than
 * meaning division — a plain "previous significant character" heuristic,
 * not a real parser: it's the set a regex can legally follow (an operand
 * cannot precede it there).
 */
const REGEX_PRECEDING_PUNCTUATION = new Set([
  "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^",
])

/**
 * Keywords after which a `/` starts a regex literal. Not exhaustive of
 * every JS keyword — just the ones that commonly precede a regex literal
 * in practice.
 */
const REGEX_PRECEDING_KEYWORDS = new Set([
  "return", "typeof", "case", "delete", "in", "instanceof", "new", "throw", "void", "yield", "else", "do",
])

/**
 * Whether a `/` right after `prevToken` (the last significant, non-comment
 * token this scanner has seen — `""` at the start of the file) opens a
 * regex literal. After an identifier, a number, a string, a closing `)` or
 * `]`, or nothing on this list, `/` is division instead.
 */
function startsRegexContext(prevToken: string): boolean {
  return prevToken === "" || REGEX_PRECEDING_PUNCTUATION.has(prevToken) || REGEX_PRECEDING_KEYWORDS.has(prevToken)
}

/**
 * Scan a regex literal's body starting at its opening `/` (`start`).
 * Honors `\` escapes and `[...]` character classes (where an unescaped `/`
 * doesn't end the regex) and stops at the first unescaped `/` outside a
 * class, then consumes any trailing flag letters. Returns `null` for an
 * unterminated regex (a bare `/` that never closes on this line), so the
 * caller can fall back to treating the `/` as division.
 */
function scanRegexLiteral(content: string, start: number): { end: number } | null {
  const n = content.length
  let i = start + 1
  let inClass = false
  while (i < n) {
    const c = content[i]
    if (c === "\\") {
      i += 2
      continue
    }
    if (c === "\n") return null
    if (inClass) {
      if (c === "]") inClass = false
      i++
      continue
    }
    if (c === "[") {
      inClass = true
      i++
      continue
    }
    if (c === "/") {
      i++
      while (i < n && /[a-zA-Z]/.test(content[i])) i++
      return { end: i }
    }
    i++
  }
  return null
}

/**
 * A small state machine over the raw text: single- and double-quoted
 * strings, template literals that contain no `${…}` (one that does is an
 * interpolation, not a plain string, and is not a candidate), and regex
 * literals (recognized but never emitted as candidates — a regex's body is
 * pattern syntax, not page text, and a string that merely LOOKS like it's
 * inside a regex, e.g. `/"Submit"/`, must not be mistaken for one). Skips
 * `//` and `/* *‍/` comments so characters inside them don't get mistaken
 * for string or regex delimiters, on a best-effort basis rather than a
 * full tokenizer.
 *
 * `prevToken` tracks the last significant token (an identifier/keyword, a
 * single punctuation character, or a marker like `"string"`/`"number"`/
 * `"regex"`) so a bare `/` can be told apart as regex-literal-start versus
 * division — see `startsRegexContext`. Comments never update it: a comment
 * between two tokens shouldn't change whether a following `/` reads as
 * regex or division.
 */
function scanJsString(content: string): TextCandidate[] {
  const candidates: TextCandidate[] = []
  const n = content.length
  let i = 0
  let prevToken = ""
  while (i < n) {
    const ch = content[i]
    const next = content[i + 1]

    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i++
      continue
    }

    if (ch === "/" && next === "/") {
      i += 2
      while (i < n && content[i] !== "\n") i++
      continue
    }
    if (ch === "/" && next === "*") {
      i += 2
      while (i < n && !(content[i] === "*" && content[i + 1] === "/")) i++
      i += 2
      continue
    }

    if (ch === "'" || ch === '"') {
      const start = i + 1
      const end = findStringEnd(content, start, ch)
      if (end === -1) {
        i = start
        continue
      }
      const raw = content.slice(start, end)
      candidates.push({
        byteStart: start,
        byteEnd: end,
        format: "js-string",
        decoded: decodeJsEscapes(raw),
        style: ch,
      })
      i = end + 1
      prevToken = "string"
      continue
    }

    if (ch === "`") {
      const result = scanTemplateLiteral(content, i + 1)
      if (result.terminated && !result.hasExpression) {
        const raw = content.slice(i + 1, result.end)
        candidates.push({
          byteStart: i + 1,
          byteEnd: result.end,
          format: "js-string",
          decoded: decodeJsEscapes(raw),
          style: "`",
        })
      }
      i = result.terminated ? result.end + 1 : result.end
      prevToken = "string"
      continue
    }

    if (ch === "/") {
      if (startsRegexContext(prevToken)) {
        const regex = scanRegexLiteral(content, i)
        if (regex) {
          i = regex.end
          prevToken = "regex"
          continue
        }
      }
      prevToken = "/"
      i++
      continue
    }

    if (/[A-Za-z_$]/.test(ch)) {
      let j = i + 1
      while (j < n && /[A-Za-z0-9_$]/.test(content[j])) j++
      prevToken = content.slice(i, j)
      i = j
      continue
    }

    if (/[0-9]/.test(ch)) {
      let j = i + 1
      while (j < n && /[0-9.]/.test(content[j])) j++
      prevToken = "number"
      i = j
      continue
    }

    prevToken = ch
    i++
  }
  return candidates
}

function scanTemplateLiteral(
  content: string,
  start: number,
): { terminated: boolean; end: number; hasExpression: boolean } {
  const n = content.length
  let i = start
  let hasExpression = false
  let exprDepth = 0
  while (i < n) {
    const c = content[i]
    if (exprDepth > 0) {
      if (c === "\\") {
        i += 2
        continue
      }
      if (c === "{") exprDepth++
      else if (c === "}") exprDepth--
      i++
      continue
    }
    if (c === "\\") {
      i += 2
      continue
    }
    if (c === "$" && content[i + 1] === "{") {
      hasExpression = true
      exprDepth = 1
      i += 2
      continue
    }
    if (c === "`") {
      return { terminated: true, end: i, hasExpression }
    }
    i++
  }
  return { terminated: false, end: i, hasExpression }
}

/**
 * Decode the common JS string/template escape sequences to the characters
 * they represent. An escape this doesn't recognize falls back to the
 * escaped character itself, matching how JS treats an unknown `\x` escape.
 */
function decodeJsEscapes(raw: string): string {
  let out = ""
  let i = 0
  const n = raw.length
  while (i < n) {
    const c = raw[i]
    if (c !== "\\") {
      out += c
      i++
      continue
    }
    const next = raw[i + 1]
    switch (next) {
      case "n":
        out += "\n"
        i += 2
        break
      case "r":
        out += "\r"
        i += 2
        break
      case "t":
        out += "\t"
        i += 2
        break
      case "b":
        out += "\b"
        i += 2
        break
      case "f":
        out += "\f"
        i += 2
        break
      case "v":
        out += "\v"
        i += 2
        break
      case "0":
        out += "\0"
        i += 2
        break
      case "\n":
        // Line continuation: the backslash-newline pair disappears.
        i += 2
        break
      case "u": {
        if (raw[i + 2] === "{") {
          const closeBrace = raw.indexOf("}", i + 3)
          if (closeBrace !== -1) {
            const code = parseInt(raw.slice(i + 3, closeBrace), 16)
            out += Number.isNaN(code) ? "" : String.fromCodePoint(code)
            i = closeBrace + 1
            break
          }
        }
        const hex = raw.slice(i + 2, i + 6)
        const code = parseInt(hex, 16)
        if (hex.length === 4 && !Number.isNaN(code)) {
          out += String.fromCharCode(code)
          i += 6
        } else {
          out += "u"
          i += 2
        }
        break
      }
      case "x": {
        const hex = raw.slice(i + 2, i + 4)
        const code = parseInt(hex, 16)
        if (hex.length === 2 && !Number.isNaN(code)) {
          out += String.fromCharCode(code)
          i += 4
        } else {
          out += "x"
          i += 2
        }
        break
      }
      default:
        out += next ?? ""
        i += 2
        break
    }
  }
  return out
}

function encodeJsStringReplacement(after: string, style: string | undefined): EncodeReplacementResult {
  let escaped = after.replace(/\\/g, "\\\\")
  if (style === "'") {
    escaped = escaped.replace(/'/g, "\\'")
  } else if (style === '"') {
    escaped = escaped.replace(/"/g, '\\"')
  } else if (style === "`") {
    escaped = escaped.replace(/`/g, "\\`").replace(/\$\{/g, "\\${")
  } else {
    return { ok: false, reason: "The original string's quote style could not be determined." }
  }
  escaped = escaped.replace(/\n/g, "\\n")
  return { ok: true, bytes: escaped }
}

// ---------------------------------------------------------------------------
// Element text (JSX / templates / HTML)
// ---------------------------------------------------------------------------

/**
 * The full HTML 4 named character reference set (252 names), plus `apos`
 * (HTML5, but universally supported and needed to decode a single-quoted
 * attribute's escaped apostrophe). Stored as code points rather than
 * characters so the table stays a flat, skimmable literal instead of a
 * page of escaped Unicode string literals; `decodeHtmlEntities` converts
 * with `String.fromCodePoint`.
 *
 * Names are case-sensitive, matching real HTML (`&Alpha;` and `&alpha;`
 * are different characters) -- do not lowercase the lookup key.
 */
const NAMED_ENTITY_CODEPOINTS: Record<string, number> = {
  // Latin-1 (ISO 8859-1), code points 160-255.
  nbsp: 160, iexcl: 161, cent: 162, pound: 163, curren: 164, yen: 165, brvbar: 166, sect: 167,
  uml: 168, copy: 169, ordf: 170, laquo: 171, not: 172, shy: 173, reg: 174, macr: 175,
  deg: 176, plusmn: 177, sup2: 178, sup3: 179, acute: 180, micro: 181, para: 182, middot: 183,
  cedil: 184, sup1: 185, ordm: 186, raquo: 187, frac14: 188, frac12: 189, frac34: 190, iquest: 191,
  Agrave: 192, Aacute: 193, Acirc: 194, Atilde: 195, Auml: 196, Aring: 197, AElig: 198, Ccedil: 199,
  Egrave: 200, Eacute: 201, Ecirc: 202, Euml: 203, Igrave: 204, Iacute: 205, Icirc: 206, Iuml: 207,
  ETH: 208, Ntilde: 209, Ograve: 210, Oacute: 211, Ocirc: 212, Otilde: 213, Ouml: 214, times: 215,
  Oslash: 216, Ugrave: 217, Uacute: 218, Ucirc: 219, Uuml: 220, Yacute: 221, THORN: 222, szlig: 223,
  agrave: 224, aacute: 225, acirc: 226, atilde: 227, auml: 228, aring: 229, aelig: 230, ccedil: 231,
  egrave: 232, eacute: 233, ecirc: 234, euml: 235, igrave: 236, iacute: 237, icirc: 238, iuml: 239,
  eth: 240, ntilde: 241, ograve: 242, oacute: 243, ocirc: 244, otilde: 245, ouml: 246, divide: 247,
  oslash: 248, ugrave: 249, uacute: 250, ucirc: 251, uuml: 252, yacute: 253, thorn: 254, yuml: 255,
  // Symbols, mathematical symbols, and Greek letters.
  fnof: 402,
  Alpha: 913, Beta: 914, Gamma: 915, Delta: 916, Epsilon: 917, Zeta: 918, Eta: 919, Theta: 920,
  Iota: 921, Kappa: 922, Lambda: 923, Mu: 924, Nu: 925, Xi: 926, Omicron: 927, Pi: 928,
  Rho: 929, Sigma: 931, Tau: 932, Upsilon: 933, Phi: 934, Chi: 935, Psi: 936, Omega: 937,
  alpha: 945, beta: 946, gamma: 947, delta: 948, epsilon: 949, zeta: 950, eta: 951, theta: 952,
  iota: 953, kappa: 954, lambda: 955, mu: 956, nu: 957, xi: 958, omicron: 959, pi: 960,
  rho: 961, sigmaf: 962, sigma: 963, tau: 964, upsilon: 965, phi: 966, chi: 967, psi: 968, omega: 969,
  thetasym: 977, upsih: 978, piv: 982,
  bull: 8226, hellip: 8230, prime: 8242, Prime: 8243, oline: 8254, frasl: 8260,
  weierp: 8472, image: 8465, real: 8476, trade: 8482, alefsym: 8501,
  larr: 8592, uarr: 8593, rarr: 8594, darr: 8595, harr: 8596, crarr: 8629,
  lArr: 8656, uArr: 8657, rArr: 8658, dArr: 8659, hArr: 8660,
  forall: 8704, part: 8706, exist: 8707, empty: 8709, nabla: 8711, isin: 8712, notin: 8713, ni: 8715,
  prod: 8719, sum: 8721, minus: 8722, lowast: 8727, radic: 8730, prop: 8733, infin: 8734, ang: 8736,
  and: 8743, or: 8744, cap: 8745, cup: 8746, int: 8747, there4: 8756, sim: 8764, cong: 8773,
  asymp: 8776, ne: 8800, equiv: 8801, le: 8804, ge: 8805, sub: 8834, sup: 8835, nsub: 8836,
  sube: 8838, supe: 8839, oplus: 8853, otimes: 8855, perp: 8869, sdot: 8901,
  lceil: 8968, rceil: 8969, lfloor: 8970, rfloor: 8971, lang: 9001, rang: 9002, loz: 9674,
  spades: 9824, clubs: 9827, hearts: 9829, diams: 9830,
  // Special characters.
  quot: 34, amp: 38, lt: 60, gt: 62,
  OElig: 338, oelig: 339, Scaron: 352, scaron: 353, Yuml: 376,
  circ: 710, tilde: 732,
  ensp: 8194, emsp: 8195, thinsp: 8201, zwnj: 8204, zwj: 8205, lrm: 8206, rlm: 8207,
  ndash: 8211, mdash: 8212,
  lsquo: 8216, rsquo: 8217, sbquo: 8218, ldquo: 8220, rdquo: 8221, bdquo: 8222,
  dagger: 8224, Dagger: 8225, permil: 8240,
  lsaquo: 8249, rsaquo: 8250, euro: 8364,
  // Not HTML 4, but universally supported and needed for a single-quoted
  // attribute's escaped apostrophe.
  apos: 39,
}

/**
 * Matches a named, decimal, or hex HTML entity — shared by the decoder below
 * and by `hasHtmlEntity`, which `scanMarkdown` uses to record whether a line
 * used entity notation at all (see `TextCandidate.style`).
 */
const HTML_ENTITY_PATTERN = /&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g

/**
 * Whether `raw` contains at least one HTML entity in the notation
 * `HTML_ENTITY_PATTERN` recognizes, decodable or not. The pattern is global
 * (reused by `decodeHtmlEntities`'s `replace`), so `lastIndex` is reset
 * before testing — `RegExp#test` advances it on a match, unlike `replace`,
 * which resets it for you.
 */
function hasHtmlEntity(raw: string): boolean {
  HTML_ENTITY_PATTERN.lastIndex = 0
  return HTML_ENTITY_PATTERN.test(raw)
}

function decodeHtmlEntities(raw: string): string {
  return raw.replace(HTML_ENTITY_PATTERN, (match, body: string) => {
    if (body[0] === "#") {
      const isHex = body[1] === "x" || body[1] === "X"
      const code = isHex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      if (Number.isNaN(code)) return match
      try {
        return String.fromCodePoint(code)
      } catch {
        return match
      }
    }
    // Names are case-sensitive (`&Alpha;` != `&alpha;`) — no lowercasing.
    const code = NAMED_ENTITY_CODEPOINTS[body]
    if (code === undefined) return match
    try {
      return String.fromCodePoint(code)
    } catch {
      return match
    }
  })
}

/**
 * Find text runs between `>` and `<` — the plain-text children of an
 * element — tracking whether we're inside a tag's quoted attribute value so
 * a `>` in `title=">"` doesn't get mistaken for the end of the tag. A run
 * containing `{` or `}` is a JSX/template expression, not literal text, and
 * is skipped.
 */
function scanElementText(content: string): TextCandidate[] {
  const candidates: TextCandidate[] = []
  const n = content.length
  let i = 0
  let mode: "text" | "tag" = "text"
  let textStart = 0
  let quote: string | null = null
  let afterTag = false

  while (i < n) {
    const ch = content[i]
    if (mode === "text") {
      if (ch === "<") {
        if (afterTag) {
          const raw = content.slice(textStart, i)
          if (raw.length > 0 && !raw.includes("{") && !raw.includes("}")) {
            candidates.push({
              byteStart: textStart,
              byteEnd: i,
              format: "element-text",
              decoded: decodeHtmlEntities(raw),
            })
          }
        }
        mode = "tag"
        quote = null
      }
      i++
      continue
    }
    // mode === "tag"
    if (quote) {
      if (ch === quote) quote = null
      i++
    } else if (ch === '"' || ch === "'") {
      quote = ch
      i++
    } else if (ch === ">") {
      mode = "text"
      textStart = i + 1
      afterTag = true
      i++
    } else {
      i++
    }
  }
  return candidates
}

function encodeElementTextReplacement(after: string): EncodeReplacementResult {
  if (after.includes("{") || after.includes("}")) {
    return {
      ok: false,
      reason: "The replacement text contains a brace, which would turn into an expression here.",
    }
  }
  const bytes = after.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  return { ok: true, bytes }
}

// ---------------------------------------------------------------------------
// Markdown / MDX
// ---------------------------------------------------------------------------

interface Line {
  start: number
  text: string
}

function splitLinesWithOffsets(content: string): Line[] {
  const lines: Line[] = []
  let start = 0
  for (let i = 0; i <= content.length; i++) {
    if (i === content.length || content[i] === "\n") {
      lines.push({ start, text: content.slice(start, i) })
      start = i + 1
    }
  }
  return lines
}

function trimRange(s: string): { start: number; end: number } {
  let start = 0
  let end = s.length
  while (start < end && /\s/.test(s[start])) start++
  while (end > start && /\s/.test(s[end - 1])) end--
  return { start, end }
}

/**
 * Build a markdown candidate from a line's raw (undecoded) slice: decode its
 * HTML entities with the same table `element-text` uses, and record `style:
 * "entities"` when the raw slice used any entity, so `encodeMarkdownReplacement`
 * knows to write `<`/`&` back as entities instead of literally.
 */
function markdownCandidate(byteStart: number, byteEnd: number, raw: string): TextCandidate {
  const candidate: TextCandidate = {
    byteStart,
    byteEnd,
    format: "markdown",
    decoded: decodeHtmlEntities(raw),
  }
  if (hasHtmlEntity(raw)) candidate.style = "entities"
  return candidate
}

/**
 * A block whose first line starts one of these ways is skipped entirely —
 * not turned into a candidate at all. List items (`- `, `* `, `1. `),
 * blockquotes (`>`) and table rows (`|`) each have their own line-wrapping
 * and inline-syntax rules that a plain "join the lines with a space" would
 * get wrong (a table row's `|` cells aren't prose to join, a blockquote's
 * `>` markers would end up in the middle of the joined text). Skipping them
 * keeps the scanner simple; it costs unique-text matching inside a list,
 * blockquote or table, which nothing here has needed yet.
 */
const BLOCK_SKIP_PATTERN = /^(?:[-*]\s|\d+\.\s|>|\|)/

/**
 * A markdown "block" is a run of consecutive non-blank lines, outside a
 * fenced code block or front matter, ending at a blank line, a heading, a
 * fence, front matter, or end of file. A heading line is always its own
 * candidate (its text starts after the `#` marks and the space that follows
 * them). Everything else in a block is ONE candidate: the browser collapses
 * a hard-wrapped paragraph's line breaks into single spaces when it renders
 * the page, so `scanMarkdown` joins the block's lines the same way — with a
 * single space — rather than emitting one candidate per line, which would
 * never match the one string the page actually shows
 * (`docs/superpowers/specs/2026-09-21-unique-text-edit-design.md`, the
 * basement-archive paragraph that motivated this).
 *
 * A block whose first line matches `BLOCK_SKIP_PATTERN` (a list item,
 * blockquote, or table row) is skipped instead of joined — see that
 * constant's comment.
 *
 * HTML entities in the raw (pre-join) text are decoded the same way
 * `element-text` does (`Research &amp; Development` matches page text
 * `Research & Development`), after the join, so an entity on any line of a
 * multi-line block sets `style: "entities"` for the whole candidate.
 */
function scanMarkdown(content: string): TextCandidate[] {
  const candidates: TextCandidate[] = []
  const lines = splitLinesWithOffsets(content)

  let index = 0
  let inFrontMatter = false
  if (lines.length > 0 && lines[0].text.trim() === "---") {
    inFrontMatter = true
    index = 1
  }

  let inFence = false
  let block: Line[] = []

  const flushBlock = () => {
    if (block.length === 0) return
    const current = block
    block = []
    if (BLOCK_SKIP_PATTERN.test(current[0].text.trim())) return

    const trimmed = current.map((line) => ({ line, ...trimRange(line.text) }))
    const blockStart = trimmed[0].line.start + trimmed[0].start
    const last = trimmed[trimmed.length - 1]
    const blockEnd = last.line.start + last.end
    if (blockEnd <= blockStart) return

    const raw = trimmed.map((t) => t.line.text.slice(t.start, t.end)).join(" ")
    candidates.push(markdownCandidate(blockStart, blockEnd, raw))
  }

  for (; index < lines.length; index++) {
    const line = lines[index]
    const trimmedText = line.text.trim()

    if (inFrontMatter) {
      if (trimmedText === "---" || trimmedText === "...") inFrontMatter = false
      continue
    }
    if (/^(```|~~~)/.test(trimmedText)) {
      flushBlock()
      inFence = !inFence
      continue
    }
    if (inFence) continue
    if (trimmedText.length === 0) {
      flushBlock()
      continue
    }

    const headingMatch = /^(#{1,6})(\s+)/.exec(line.text)
    if (headingMatch) {
      flushBlock()
      const markerEnd = headingMatch[0].length
      const rest = line.text.slice(markerEnd)
      const { start, end } = trimRange(rest)
      if (end > start) {
        candidates.push(
          markdownCandidate(line.start + markerEnd + start, line.start + markerEnd + end, rest.slice(start, end)),
        )
      }
      continue
    }

    block.push(line)
  }
  flushBlock()
  return candidates
}

function encodeMarkdownReplacement(after: string, style: string | undefined): EncodeReplacementResult {
  if (after.includes("\n")) {
    return {
      ok: false,
      reason: "The replacement text contains a line break, which would split into a new markdown line.",
    }
  }
  // A paragraph or heading that starts with a block marker becomes a list,
  // a quote, a table row or a heading of another level. Markdown has no way
  // to quote the marker, so the edit goes to chat (Fable pass, 2026-09-21).
  if (/^(#{1,6}(\s|$)|[-*+]\s|\d+[.)]\s|>|\||```|~~~|---|\*\*\*|___)/.test(after)) {
    return {
      ok: false,
      reason: "The replacement text starts with a markdown block marker, which would change what kind of block this is.",
    }
  }
  if (style === "entities") {
    const bytes = after.replace(/&/g, "&amp;").replace(/</g, "&lt;")
    return { ok: true, bytes }
  }
  return { ok: true, bytes: after }
}

// ---------------------------------------------------------------------------
// YAML
// ---------------------------------------------------------------------------

function findClosingDoubleQuote(s: string): number {
  let i = 1
  while (i < s.length) {
    if (s[i] === "\\") {
      i += 2
      continue
    }
    if (s[i] === '"') return i
    i++
  }
  return -1
}

function findClosingSingleQuote(s: string): number {
  let i = 1
  while (i < s.length) {
    if (s[i] === "'") {
      if (s[i + 1] === "'") {
        i += 2
        continue
      }
      return i
    }
    i++
  }
  return -1
}

function decodeYamlDouble(raw: string): string {
  // YAML's double-quoted escapes are a subset of JS's; the shared decoder
  // covers every sequence YAML actually uses and falls back to the literal
  // character for anything else, same as the JS decoder does.
  return decodeJsEscapes(raw)
}

function decodeYamlSingle(raw: string): string {
  // The only escape in a single-quoted YAML scalar is a doubled quote.
  return raw.replace(/''/g, "'")
}

function stripYamlComment(rest: string): string {
  if (rest[0] === "#") return ""
  const idx = rest.indexOf(" #")
  return idx === -1 ? rest : rest.slice(0, idx)
}

/**
 * Try to read `line` as a YAML `key: value` mapping entry or a `- value`
 * list item, and return its value as a candidate. Only the value is a
 * candidate — the key is not searched, since a YAML key is structural in a
 * way a JSON key isn't.
 */
function scanYamlLine(line: Line): TextCandidate | null {
  const text = line.text
  let rest: string
  let baseOffset: number

  const listMatch = /^\s*-\s+/.exec(text)
  if (listMatch) {
    baseOffset = listMatch[0].length
    rest = text.slice(baseOffset)
  } else {
    const sepIndex = text.indexOf(": ")
    if (sepIndex === -1) return null
    const key = text.slice(0, sepIndex)
    if (key.trim().length === 0 || /^\s*#/.test(key)) return null
    baseOffset = sepIndex + 2
    rest = text.slice(baseOffset)
  }

  if (rest.length === 0) return null

  if (rest[0] === '"') {
    const closing = findClosingDoubleQuote(rest)
    if (closing === -1) return null
    const raw = rest.slice(1, closing)
    return {
      byteStart: line.start + baseOffset + 1,
      byteEnd: line.start + baseOffset + closing,
      format: "yaml",
      decoded: decodeYamlDouble(raw),
      style: "double",
    }
  }

  if (rest[0] === "'") {
    const closing = findClosingSingleQuote(rest)
    if (closing === -1) return null
    const raw = rest.slice(1, closing)
    return {
      byteStart: line.start + baseOffset + 1,
      byteEnd: line.start + baseOffset + closing,
      format: "yaml",
      decoded: decodeYamlSingle(raw),
      style: "single",
    }
  }

  const withoutComment = stripYamlComment(rest)
  const { start, end } = trimRange(withoutComment)
  if (end <= start) return null
  return {
    byteStart: line.start + baseOffset + start,
    byteEnd: line.start + baseOffset + end,
    format: "yaml",
    decoded: withoutComment.slice(start, end),
    style: "plain",
  }
}

function scanYaml(content: string): TextCandidate[] {
  const candidates: TextCandidate[] = []
  for (const line of splitLinesWithOffsets(content)) {
    if (/^\s*#/.test(line.text)) continue
    if (line.text.trim().length === 0) continue
    const candidate = scanYamlLine(line)
    if (candidate) candidates.push(candidate)
  }
  return candidates
}

const YAML_PLAIN_LEADING_SPECIAL = /^[-?:[\]{}#&*!|>'"%@`]/

/**
 * The YAML 1.2 core schema's non-string scalars, spelled exactly as the
 * schema (and the unique-text spec) enumerates them. A plain scalar that
 * reads as one of these is not a string once YAML parses it — `title: true`
 * loads as the boolean `true`, not the three-character string `"true"` —
 * so a plain-style replacement that matches must be quoted instead of
 * written literally.
 */
const YAML_PLAIN_NON_STRING_TOKENS = new Set([
  "true", "false", "yes", "no", "on", "off",
  "null", "~", "Null", "NULL", "True", "TRUE", "False", "FALSE",
])
const YAML_PLAIN_INT_RE = /^[-+]?(0x[0-9a-fA-F]+|0o[0-7]+|[0-9]+)$/
const YAML_PLAIN_FLOAT_RE = /^[-+]?(\d+\.\d*|\.\d+)([eE][-+]?\d+)?$|^[-+]?\d+[eE][-+]?\d+$/
const YAML_PLAIN_SPECIAL_FLOAT_RE = /^[-+]?\.(inf|Inf|INF)$|^\.(nan|NaN|NAN)$/
const YAML_PLAIN_DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const YAML_PLAIN_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/

/**
 * True when writing `after` as a plain (unquoted) YAML scalar would not
 * round-trip as the string `after` — either because YAML would parse it as
 * some other type, or because it needs syntax (an indicator character, a
 * `: ` / ` #` sequence, a newline) a plain scalar cannot carry, or because
 * it's empty or has leading/trailing whitespace a plain scalar would not
 * preserve.
 */
function yamlPlainWouldChangeMeaning(after: string): boolean {
  if (after.length === 0) return true
  if (/^\s/.test(after) || /\s$/.test(after)) return true
  if (after.includes("\n")) return true
  if (after.includes(": ") || after.includes(" #")) return true
  // A trailing colon reads as a mapping key with no value. MEASURED with
  // js-yaml: `title: Coming soon:` throws "bad indentation of a mapping
  // entry" (Fable pass, 2026-09-21).
  if (after.endsWith(":")) return true
  if (YAML_PLAIN_LEADING_SPECIAL.test(after)) return true
  if (YAML_PLAIN_NON_STRING_TOKENS.has(after)) return true
  if (YAML_PLAIN_INT_RE.test(after)) return true
  if (YAML_PLAIN_FLOAT_RE.test(after)) return true
  if (YAML_PLAIN_SPECIAL_FLOAT_RE.test(after)) return true
  if (YAML_PLAIN_DATE_RE.test(after)) return true
  if (YAML_PLAIN_TIMESTAMP_RE.test(after)) return true
  return false
}

const YAML_QUOTED_NEWLINE_REFUSAL =
  "The replacement text contains a line break, which a quoted YAML scalar here would need indentation rules this module does not model."

function encodeYamlReplacement(after: string, style: string | undefined): EncodeReplacementResult {
  if (style === "double") {
    if (after.includes("\n")) {
      return { ok: false, reason: YAML_QUOTED_NEWLINE_REFUSAL }
    }
    return { ok: true, bytes: encodeYamlDoubleQuotedContent(after) }
  }
  if (style === "single") {
    if (after.includes("\n")) {
      return { ok: false, reason: YAML_QUOTED_NEWLINE_REFUSAL }
    }
    return { ok: true, bytes: after.replace(/'/g, "''") }
  }
  if (style !== "plain") {
    return { ok: false, reason: "The original scalar's style could not be determined." }
  }
  if (!yamlPlainWouldChangeMeaning(after)) {
    return { ok: true, bytes: after }
  }
  // A style change from plain to single-quoted is legal YAML and keeps
  // the value a string. The candidate's byte range for a plain scalar
  // excludes any quote characters (there weren't any), so the quotes are
  // added here rather than left for the splice.
  if (after.includes("\n")) {
    return { ok: false, reason: YAML_QUOTED_NEWLINE_REFUSAL }
  }
  return { ok: true, bytes: `'${after.replace(/'/g, "''")}'` }
}

/**
 * Escape backslash, double quote, and any C0 control character (other than
 * a newline, which the caller has already refused) for a double-quoted
 * YAML scalar. YAML's double-quoted style supports named escapes for the
 * common controls and a `\xNN` escape for the rest.
 */
function encodeYamlDoubleQuotedContent(after: string): string {
  const NAMED_C0_ESCAPES: Record<string, string> = {
    "\0": "\\0",
    "\x07": "\\a",
    "\b": "\\b",
    "\t": "\\t",
    "\v": "\\v",
    "\f": "\\f",
    "\r": "\\r",
    "\x1b": "\\e",
  }
  let out = ""
  for (const ch of after) {
    const code = ch.codePointAt(0) ?? 0
    if (ch === "\\") {
      out += "\\\\"
    } else if (ch === '"') {
      out += '\\"'
    } else if (ch in NAMED_C0_ESCAPES) {
      out += NAMED_C0_ESCAPES[ch]
    } else if (code < 0x20) {
      out += `\\x${code.toString(16).padStart(2, "0")}`
    } else {
      out += ch
    }
  }
  return out
}
