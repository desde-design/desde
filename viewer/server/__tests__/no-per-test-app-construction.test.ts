/**
 * Static guard against reintroducing per-test server churn.
 *
 * `supertest-reuse.ts` memoizes one listening server per app OBJECT, so handing
 * `request()` a freshly-constructed app opens a new ephemeral-port server.
 * Enough of those in a parallel run and requests start reaching the wrong
 * server — the suite's documented flakiness. Build the app once per file (see
 * `swappable-app.ts`) and pass the stable object instead.
 *
 * Measured when this guard was written: the suite went from 447 listening
 * servers per run to 31.
 *
 * ## Why two rules and not one
 *
 * The obvious rule — "never write `request(createApp(...))`" — was true of
 * exactly ONE call site in the whole repo. The churn was almost entirely the
 * indirect shape:
 *
 *     const app = createApp({ ... })   // in a beforeEach, or inside an `it`
 *     await request(app).get(...)
 *
 * A guard that only catches the inline form would have passed cleanly against
 * the 447-server tree it was supposed to prevent. So rule 2 follows the
 * variable: an identifier that is handed to `request()` may not be assigned
 * from a direct app construction anywhere in its file.
 *
 * `const inner = express()` stays legal precisely because `inner` is never
 * passed to `request()` — it is installed with `stable.use(inner)`.
 *
 * ## Opting out
 *
 * A test that must own its server — one driving a raw `http.get` against an SSE
 * stream, say, where supertest would wait forever for a body that never ends —
 * marks the construction with a reason:
 *
 *     // desde-allow-own-server: SSE never ends; drives a raw http.get
 *     const streamApp = createApp({ ... })
 *
 * The marker must sit on the construction line or the one above it.
 */
import { readFileSync, readdirSync, statSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const thisFile = fileURLToPath(import.meta.url)
const serverDir = resolve(dirname(thisFile), "..")

function testFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      out.push(...testFiles(full))
    } else if (entry.endsWith(".test.ts")) {
      out.push(full)
    }
  }
  return out
}

/**
 * `request(` immediately wrapping a construction — the inline form.
 *
 * Scanned over the WHOLE source, not line by line: `request(\n  express()\n)`
 * is the same defect formatted differently, and a per-line scan misses it.
 * `express()` in particular has no other rule that would catch it there —
 * rule 2 covers only `createApp`/`createServeRouter`, and rule 3 only sees
 * `express()` bound to a name.
 */
const INLINE = /request\(\s*(createApp|express|createServeRouter)\s*\(/g

/** A full app construction, wherever it appears. */
const APP_CONSTRUCTION = /\b(?:createApp|createServeRouter)\s*\(/g

/**
 * A bare `express()` call, wherever it appears.
 *
 * `express.json()` and the `express.Express` type do NOT match — they are
 * `express.` followed by a member, not `express(`.
 */
const EXPRESS_CALL = /\bexpress\s*\(/g

/** The `name =` / `name:` immediately preceding a construction on the same line. */
const BOUND_NAME = /(?:(?:const|let|var)\s+)?\b([A-Za-z_$][\w$]*)\s*[=:]\s*$/

/** `something.use(name)` — the name being installed AS an inner app. */
const INSTALLED_NAME = /\.\s*use\(\s*([A-Za-z_$][\w$]*)\s*\)/g

/** `request(name)` — a bare identifier handed to supertest. */
const REQUESTED_NAME = /request\(\s*([A-Za-z_$][\w$]*)\s*\)/g

const OPT_OUT = "desde-allow-own-server"

/**
 * Is the construction on `lines[i]` opted out?
 *
 * Scans the whole contiguous comment block above it, not just one line. An
 * opt-out worth granting usually needs a sentence or two of reason, and a
 * marker that only works on the immediately-preceding line quietly stops
 * applying the moment someone explains themselves properly — the same trap
 * CLAUDE.md documents for misplaced eslint-disable directives.
 */
function optedOut(lines: string[], i: number): boolean {
  if (lines[i].includes(OPT_OUT)) return true
  for (let j = i - 1; j >= 0; j--) {
    const line = lines[j].trim()
    if (!line.startsWith("//") && !line.startsWith("*") && !line.startsWith("/*")) return false
    if (line.includes(OPT_OUT)) return true
  }
  return false
}

/** 1-based line number of a character offset. */
function lineOf(src: string, index: number): number {
  return src.slice(0, index).split("\n").length
}

/**
 * Blank out comments, preserving length and line offsets so reported line
 * numbers stay correct.
 *
 * Every rule matches against this rather than the raw source. These files
 * discuss `express()` and `createApp()` at length in their own doc comments —
 * prose that says "a `setup()` returning a fresh `express()` per call" is not a
 * construction — and, in the other direction, a comment mentioning
 * `stable.use(inner)` must not be able to satisfy an installation check.
 * `optedOut` deliberately still reads the RAW lines, since markers live in
 * comments.
 */
function maskComments(src: string): string {
  return src
    .split("\n")
    .map((line) => {
      const t = line.trim()
      if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return " ".repeat(line.length)
      const slash = line.indexOf("//")
      return slash === -1 ? line : line.slice(0, slash) + " ".repeat(line.length - slash)
    })
    .join("\n")
}

/**
 * Is this construction installed — i.e. is it a direct argument to `.use(`?
 *
 * Walks back over whitespace from the construction so the multi-line form
 * counts too:
 *
 *     stable.use(
 *       createApp({ ... }),
 *     )
 */
function isInstalled(src: string, index: number): boolean {
  let i = index - 1
  while (i >= 0 && /\s/.test(src[i])) i--
  return src.slice(Math.max(0, i - 4), i + 1).endsWith(".use(")
}

function offendersIn(file: string, raw: string): string[] {
  const lines = raw.split("\n")
  // All matching happens against the comment-masked view; `optedOut` reads the
  // raw lines, because markers live in comments.
  const src = maskComments(raw)
  // Keyed by line: `request(createApp(...))` trips rules 1 and 2 at once, and
  // one defect should be reported once.
  const byLine = new Map<number, string>()
  const found = {
    push(entry: string) {
      const line = Number(entry.split(":")[1])
      if (!byLine.has(line)) byLine.set(line, entry)
    },
  }
  const rel = relative(serverDir, file)

  // Rule 1 — the inline form: `request(createApp(...))`, however it is wrapped.
  //
  // Offsets of the constructor calls this rule already accounts for, so rules 2
  // and 3 do not report the same defect a second time on a different line when
  // the call is wrapped:  request(\n  express()\n)
  const coveredByInline = new Set<number>()
  for (const m of src.matchAll(INLINE)) {
    coveredByInline.add(m.index + m[0].lastIndexOf(m[1]))
    const line = lineOf(src, m.index)
    found.push(`${rel}:${line}: ${lines[line - 1].trim()}`)
  }

  // Rule 2 — EVERY app construction must be installed via `.use(...)`.
  //
  // This is deliberately phrased over the construction rather than over
  // whatever receives it. Two earlier versions chased the receiving side —
  // first "is it declared with const/let", then "is the receiving identifier
  // passed to request()" — and each time review found another shape that
  // slipped past: a bare reassignment in `beforeEach`, then `request(ctx.app)`
  // and `const { app: app2 } = ...` aliases, neither of which is a bare
  // identifier. Chasing aliases through a regex is unwinnable. Requiring the
  // CONSTRUCTION to be installed makes the question local and alias-proof:
  // `stable.use(createApp(...))` passes, and every way of binding a fresh app
  // to a name fails, however it is later spelled.
  for (const m of src.matchAll(APP_CONSTRUCTION)) {
    if (coveredByInline.has(m.index) || isInstalled(src, m.index)) continue
    const line = lineOf(src, m.index)
    if (optedOut(lines, line - 1)) continue
    found.push(`${rel}:${line}: ${lines[line - 1].trim()}`)
  }

  // Rule 3 — every bare `express()` must end up installed, one way or another.
  //
  // Three legal shapes, and nothing else:
  //   a) a direct argument to `.use(...)`  — `stable.use(express().use(h))`
  //   b) bound to a name that is later installed — `const inner = express()`
  //      … `stable.use(inner)`
  //   c) opted out with a reason
  //
  // Phrased over the CALL rather than over a binding, because review defeated
  // both narrower versions in turn: first `request(ident)` where the binding
  // was renamed inside a helper, then a line-scoped binding rule which missed
  // `const makeApp = () => express().use(router)` and `const apps = [express()]`
  // — neither is a `name = express()` line, and both open a fresh server per
  // call. Asking "did this call get installed" has no such gaps.
  for (const m of src.matchAll(EXPRESS_CALL)) {
    if (coveredByInline.has(m.index) || isInstalled(src, m.index)) continue
    const line = lineOf(src, m.index)
    if (optedOut(lines, line - 1)) continue
    // Shape (b): bound to a name that something later `.use()`s.
    const before = src.slice(0, m.index).split("\n").pop() ?? ""
    const bound = BOUND_NAME.exec(before)
    if (bound && new RegExp(`\\.\\s*use\\(\\s*${bound[1]}\\b`).test(src)) continue
    found.push(`${rel}:${line}: ${lines[line - 1].trim()}`)
  }

  // Rule 4 — an INNER app must never be requested directly.
  //
  //     const inner = express()
  //     stable.use(inner)
  //     await request(inner).get("/")   // <- opens a server on `inner`
  //
  // Rules 2 and 3 both pass here: the construction IS installed. But supertest
  // binds a server to whatever object it is handed, so requesting the inner app
  // rather than `stable.app` reintroduces exactly the churn — and it is a
  // one-character-class typo away from correct in every migrated file that uses
  // the `const inner = express()` shape.
  const installed = new Set<string>()
  for (const m of src.matchAll(INSTALLED_NAME)) installed.add(m[1])
  for (const m of src.matchAll(REQUESTED_NAME)) {
    if (!installed.has(m[1])) continue
    const line = lineOf(src, m.index)
    if (optedOut(lines, line - 1)) continue
    found.push(`${rel}:${line}: ${lines[line - 1].trim()}`)
  }

  return [...byLine.entries()].sort((a, b) => a[0] - b[0]).map(([, entry]) => entry)
}

describe("no per-test app construction", () => {
  it("never hands request() a freshly-built app", () => {
    const offenders: string[] = []
    for (const file of testFiles(serverDir)) {
      // Skip this file: its own prose and its synthetic fixtures below contain
      // the very patterns it hunts for, and it would report itself forever.
      if (file === thisFile) continue
      offenders.push(...offendersIn(file, readFileSync(file, "utf8")))
    }
    expect(offenders, offenders.join("\n")).toEqual([])
  })

  // A guard nobody has watched fail is not a guard. These run the same
  // detector over synthetic sources, so the failure path is exercised on every
  // run rather than once by hand at review time.
  it("catches the inline form", () => {
    const src = `const res = await request(createApp({ storage })).get("/")`
    expect(offendersIn("/x/fake.test.ts", src)).toHaveLength(1)
  })

  it("catches the indirect form the real churn actually took", () => {
    const declared = ["const app = createApp({ storage })", 'await request(app).get("/")'].join("\n")
    expect(offendersIn("/x/fake.test.ts", declared)).toHaveLength(1)
  })

  /**
   * Regression test for a hole in THIS guard, found by review.
   *
   * The first version required a `const`/`let`/`var` declarator on the
   * assignment, which made it blind to the single most common shape in the
   * tree it was written to protect: a variable declared once at describe scope
   * and REASSIGNED in `beforeEach`. That is where most of the 447 servers came
   * from, so the guard would have passed against the exact code it exists to
   * prevent.
   */
  it("catches a bare reassignment in beforeEach, not just a declaration", () => {
    const reassigned = [
      "let app: express.Express",
      "beforeEach(() => {",
      "  app = createApp({ storage })",
      "})",
      'it("x", async () => { await request(app).get("/") })',
    ].join("\n")
    expect(offendersIn("/x/fake.test.ts", reassigned)).toHaveLength(1)
  })

  it("catches an app returned as an object property from a helper", () => {
    const property = [
      "function setup() {",
      "  return { deps, app: createApp(deps) }",
      "}",
      "const { app } = setup()",
      'await request(app).get("/")',
    ].join("\n")
    expect(offendersIn("/x/fake.test.ts", property)).toHaveLength(1)
  })

  /**
   * Second hole found by review, and the reason rule 2 is phrased over the
   * CONSTRUCTION rather than over whatever receives it.
   *
   * The tree requests apps as `request(ctx.app)` and destructures them as
   * `const { app: app2 } = ...`. Neither is a bare identifier, so a rule keyed
   * on "is the requested name assigned from a constructor" could never fire for
   * them — a helper regressing to `return { app: createApp(deps) }` would have
   * gone unnoticed. Requiring the construction itself to be installed makes the
   * alias irrelevant.
   */
  it("catches a helper regression regardless of how the app is later aliased", () => {
    const viaCtxProperty = [
      "function setup() { return { app: createApp(deps) } }",
      "ctx = setup()",
      'await request(ctx.app).get("/")',
    ].join("\n")
    const viaRenamedDestructure = [
      "function setup() { return { app: createApp(deps) } }",
      "const { app: app2 } = setup()",
      'await request(app2).get("/")',
    ].join("\n")
    // Not requested by ANY name — still churn, still caught.
    const neverRequestedDirectly = [
      "const solo = createApp(deps)",
      "const server = solo.listen(0)",
    ].join("\n")
    expect(offendersIn("/x/fake.test.ts", viaCtxProperty)).toHaveLength(1)
    expect(offendersIn("/x/fake.test.ts", viaRenamedDestructure)).toHaveLength(1)
    expect(offendersIn("/x/fake.test.ts", neverRequestedDirectly)).toHaveLength(1)
  })

  it("allows the multi-line installed form", () => {
    const src = ["stable.use(", "  createApp({ storage }),", ")", 'await request(stable.app).get("/")'].join("\n")
    expect(offendersIn("/x/fake.test.ts", src)).toEqual([])
  })

  it("catches a bare express() bound to a name that is then requested", () => {
    const bad = ["const app = express()", "app.use(router)", 'await request(app).get("/")'].join("\n")
    expect(offendersIn("/x/fake.test.ts", bad)).toHaveLength(1)
  })

  /**
   * Third hole found by review — the express() half of the aliasing problem.
   *
   * A receiving-side rule missed `function setup() { const inner = express();
   * return { app: inner } }`, because `inner` is never requested under that
   * name while every call still opens a fresh server. Rule 3 now asks whether
   * the binding was INSTALLED, which renaming cannot dodge.
   */
  it("catches an express() app returned from a helper under another name", () => {
    const aliased = [
      "function setup() {",
      "  const inner = express()",
      "  inner.use(router)",
      "  return { app: inner }",
      "}",
      "const { app } = setup()",
      'await request(app).get("/")',
    ].join("\n")
    expect(offendersIn("/x/fake.test.ts", aliased)).toHaveLength(1)
  })

  /**
   * Fourth and fifth shapes found by review. A line-scoped `name = express()`
   * rule saw neither: an arrow-body construction has no binding on its own
   * line, and an array literal has no binding at all. Both open a fresh server
   * per call.
   */
  it("catches an express() app built in an arrow body or a literal", () => {
    const arrowBody = [
      "const makeApp = () => express().use(router)",
      'await request(makeApp()).get("/")',
    ].join("\n")
    const inArray = ["const apps = [express()]", 'await request(apps[0]).get("/")'].join("\n")
    expect(offendersIn("/x/fake.test.ts", arrowBody)).toHaveLength(1)
    expect(offendersIn("/x/fake.test.ts", inArray)).toHaveLength(1)
  })

  /**
   * These files discuss `express()` and `createApp()` at length in their own
   * doc comments. Prose is not a construction — and, in the other direction, a
   * comment mentioning `stable.use(inner)` must not be able to satisfy an
   * installation check for real code.
   */
  it("ignores constructions and installations that appear only in comments", () => {
    const prose = [
      "/**",
      " * A setup() returning a fresh express() per call opened one server per test,",
      " * which is why createApp({ ... }) now goes through stable.use(...).",
      " */",
      "stable.use(createApp({ storage }))",
    ].join("\n")
    const fakeInstall = ["const inner = express()", "// stable.use(inner)"].join("\n")
    expect(offendersIn("/x/fake.test.ts", prose)).toEqual([])
    expect(offendersIn("/x/fake.test.ts", fakeInstall)).toHaveLength(1)
  })

  /**
   * The last shape review found, and the most realistic of all of them: the
   * construction is correctly installed, but the INNER app is handed to
   * `request()` instead of `stable.app`. Rules 2 and 3 both pass — supertest
   * still binds a server to the inner object, so the churn is back.
   */
  it("catches an installed inner app that is nevertheless requested directly", () => {
    const typo = [
      "const inner = express()",
      "inner.use(router)",
      "stable.use(inner)",
      'await request(inner).get("/")',
    ].join("\n")
    expect(offendersIn("/x/fake.test.ts", typo)).toHaveLength(1)
  })

  it("allows an express() app that is installed into a swappable app", () => {
    const installed = [
      "const inner = express()",
      "inner.use(createRootAssetFallback({ storage }))",
      "stable.use(inner)",
    ].join("\n")
    expect(offendersIn("/x/fake.test.ts", installed)).toEqual([])
  })

  it("allows a construction that is installed rather than requested", () => {
    const src = [
      "const inner = express()",
      "inner.use(createRootAssetFallback({ storage }))",
      "stable.use(inner)",
      'await request(stable.app).get("/")',
    ].join("\n")
    expect(offendersIn("/x/fake.test.ts", src)).toEqual([])
  })

  it("honours the documented opt-out on the line, one above, or anywhere in the comment block", () => {
    const sameLine = [
      `const a = createApp({}) // ${OPT_OUT}: raw http.get`,
      "await request(a).get('/')",
    ].join("\n")
    const lineAbove = [
      `// ${OPT_OUT}: SSE never ends`,
      "const b = createApp({})",
      "await request(b).get('/')",
    ].join("\n")
    // The case that caught this guard out the first time: a real reason ran to
    // three lines, pushing the marker off the immediately-preceding line.
    const multiLineReason = [
      `// ${OPT_OUT}: this test calls listen(0) and drives a raw http.get,`,
      "// because an SSE response never ends and supertest would wait for a",
      "// body forever. It closes the server itself.",
      "const c = createApp({})",
      "await request(c).get('/')",
    ].join("\n")
    expect(offendersIn("/x/fake.test.ts", sameLine)).toEqual([])
    expect(offendersIn("/x/fake.test.ts", lineAbove)).toEqual([])
    expect(offendersIn("/x/fake.test.ts", multiLineReason)).toEqual([])
  })

  it("does not let an opt-out leak past the comment block to unrelated code", () => {
    const leaky = [
      `// ${OPT_OUT}: applies to the construction directly below only`,
      "const ok = createApp({})",
      "await request(ok).get('/')",
      "const notOk = createApp({})",
      "await request(notOk).get('/')",
    ].join("\n")
    expect(offendersIn("/x/fake.test.ts", leaky)).toHaveLength(1)
  })

  it("does not fire on a file that constructs nothing", () => {
    expect(offendersIn("/x/fake.test.ts", 'await request(stable.app).get("/")')).toEqual([])
    expect(offendersIn("/x/fake.test.ts", "const x = 1")).toEqual([])
  })

  /**
   * Found by review: the inline rule used to scan line by line, so the same
   * defect formatted across lines escaped it. `express()` is the dangerous
   * case — rule 2 covers only createApp/createServeRouter, and rule 3 only
   * sees `express()` bound to a name, so nothing else would have caught it.
   */
  it("catches the inline form even when it is wrapped across lines", () => {
    const wrapped = ["const res = await request(", "  express()", ").get('/')"].join("\n")
    expect(offendersIn("/x/fake.test.ts", wrapped)).toHaveLength(1)
  })

  it("reports one offence per line, not one per rule tripped", () => {
    // `request(createApp(...))` trips both the inline rule and the
    // not-installed rule. It is one defect.
    expect(offendersIn("/x/fake.test.ts", 'await request(createApp({})).get("/")')).toHaveLength(1)
  })
})
