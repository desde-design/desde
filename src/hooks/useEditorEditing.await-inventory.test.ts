import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

/**
 * The bare-await inventory for `useEditorEditing.ts`.
 *
 * A lane in this hook does not check the session by hand. It calls
 * `session.run`, and every await inside the body goes through `ctx.step`, so
 * an answer that arrived after its page went away cannot be read. See
 * `src/editor/session/README.md`.
 *
 * An await that is NOT inside a run body and is NOT a `ctx.step` is outside
 * that machinery. Some of those are fine and some of them were the defect:
 * nineteen fix waves on the hand-off branch each found one more await without
 * a guard. A count is not a defence, so this file lists every one of them by
 * the expression it awaits, with the reason it is allowed to be bare. A new
 * bare await fails this test until someone writes down why it is safe.
 *
 * ## How "inside a session.run body" is decided
 *
 * By parenthesis depth, over a copy of the source with comments, string
 * literals, template chunks and regex literals blanked out. From the `(` of
 * each `session.run(` to its matching `)` is one body.
 *
 * The alternative was a marker comment on each line, or indentation. Both were
 * rejected for the same reason: they are a second thing to keep in sync with
 * the code, and a reformat, a rename or a moved block silently changes the
 * answer. Parenthesis depth reads the same structure the compiler reads, so
 * wrapping a call across three lines, renaming a variable inside a body, or
 * running the file through a formatter does not move a single entry. Blanking
 * the literals first is what keeps a `)` inside a string or a `//` inside a
 * regex from closing a body early.
 *
 * Offsets and line numbers survive the blanking: every removed character is
 * replaced by a space and every newline is kept, so the masked copy is the
 * same length as the source and a failure can name the real line.
 */

/** One allowed bare await. `sites` is how many times it appears. */
interface AllowedBareAwait {
  /** The awaited expression's head, up to and including its `(`. */
  snippet: string
  sites: number
  reason: string
}

const HOOK_PATH = "src/hooks/useEditorEditing.ts"

/**
 * Classified from the awaits actually present, one read at a time. Each reason
 * says what happens AFTER the await, because that is the only thing a session
 * check would protect.
 */
const ALLOWED_BARE_AWAITS: readonly AllowedBareAwait[] = [
  {
    snippet: "await session.run(",
    sites: 9,
    reason:
      "This IS a lane's run. The guard is inside it, and the answer it hands back is a SessionRunResult, so `stale` has to be narrowed before any value is reachable. The five in statement position await nothing afterwards except a spinner reset that carries its own layers-generation check.",
  },
  {
    snippet: "await adapter.clearSelection(",
    sites: 1,
    reason:
      "Fire and forget. The store write that empties the multi-selection happens BEFORE this await, and nothing follows it. The resulting deselect comes back through the adapter's selection listener, which drops a reply from a departed document on its own.",
  },
  {
    snippet: "await adapter.selectBySelector(",
    sites: 2,
    reason:
      "Fire and forget, both sites. Each is the last statement in its branch of the Layers click handler, so no continuation installs anything. The selection this asks for arrives through the adapter's selection listener, filtered there by document id.",
  },
  {
    snippet: "await dispatchIteration(",
    sites: 1,
    reason:
      "The iteration lane. It opens its own run and takes the session as a parameter, so every await in it is already a step. What is left at this call site is the wiring, and nothing follows the await.",
  },
  {
    snippet: "await dispatchPropEdit(",
    sites: 1,
    reason:
      "The prop lane, and the same shape: it opens its own run. Nothing follows the await.",
  },
  {
    snippet: "await dispatchTextMutation(",
    sites: 1,
    reason:
      "The text lane, which opens its own run. Nothing follows the await.",
  },
  {
    snippet: "await dispatchClassMutation(",
    sites: 1,
    reason:
      "The class lane, the text lane's sibling on the same lane id. It opens its own run. Nothing follows the await.",
  },
  {
    snippet: "await fetchStylesheetTargets(",
    sites: 1,
    reason:
      "Inside `resolveStyleDestination`, which every caller awaits through `ctx.step`, so the destination it returns is gated by the caller's run. The one thing it writes past this await is the sticky override-stylesheet ref, and a stale value there cannot be used: the next resolution only honours `sticky` when the CURRENT page's sheets contain it.",
  },
  {
    snippet: "await handleSaveAllRef.current?.(",
    sites: 1,
    reason:
      "Re-running the save after the designer chose to overwrite. It is the last statement of that handler, and the save it calls reports a page change itself.",
  },
  {
    snippet: "await adapter.applyEdit(",
    sites: 1,
    reason:
      "The documented exemption, written out at the call site: the agent's file rewrite answering a chat turn. The caller is the chat runtime waiting for an answer, not the iframe, so cancelling on the session's signal would half-answer the agent. The generation is captured before the await and the two status lines past it are guarded with `session.isCurrent`.",
  },
  {
    snippet: "await runSaveAll(",
    sites: 1,
    reason:
      "The save wrapper. `runSaveAll` is one run and it already turned a page change into its own typed reason, so the failure this records is the answer that run gave.",
  },
  {
    snippet: "await adapterRef.current?.setActive(",
    sites: 1,
    reason:
      "Fire and forget: it turns the bridge's tools on or off and nothing follows the await.",
  },
]

/**
 * Blank comments, string literals, template chunks and regex literals, keeping
 * every offset and every newline.
 */
function maskLiterals(source: string): string {
  const out = source.split("")
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k += 1) if (out[k] !== "\n") out[k] = " "
  }
  const n = source.length
  let i = 0
  // The last non-whitespace character seen, or "str" for a completed literal.
  // A `/` after one of those is division; after anything else it opens a regex.
  let previous = ""
  while (i < n) {
    const c = source[i]
    const next = source[i + 1]
    if (c === "/" && next === "/") {
      let j = i
      while (j < n && source[j] !== "\n") j += 1
      blank(i, j)
      i = j
      continue
    }
    if (c === "/" && next === "*") {
      let j = i + 2
      while (j < n && !(source[j] === "*" && source[j + 1] === "/")) j += 1
      j = Math.min(j + 2, n)
      blank(i, j)
      i = j
      continue
    }
    if (c === '"' || c === "'") {
      let j = i + 1
      while (j < n && source[j] !== c) {
        if (source[j] === "\\") j += 1
        j += 1
      }
      blank(i + 1, j)
      i = j + 1
      previous = "str"
      continue
    }
    if (c === "`") {
      // The text of a template is blanked; each `${…}` span is left alone,
      // because it is ordinary code and may hold an await.
      let j = i + 1
      while (j < n && source[j] !== "`") {
        if (source[j] === "\\") {
          blank(j, j + 2)
          j += 2
          continue
        }
        if (source[j] === "$" && source[j + 1] === "{") {
          let depth = 1
          let k = j + 2
          while (k < n && depth > 0) {
            if (source[k] === "{") depth += 1
            else if (source[k] === "}") depth -= 1
            k += 1
          }
          j = k
          continue
        }
        if (source[j] !== "\n") out[j] = " "
        j += 1
      }
      i = j + 1
      previous = "str"
      continue
    }
    if (c === "/" && previous !== "str" && !/[A-Za-z0-9_$)\]]/.test(previous)) {
      let j = i + 1
      let inCharacterClass = false
      while (j < n) {
        const d = source[j]
        if (d === "\\") {
          j += 2
          continue
        }
        if (d === "[") inCharacterClass = true
        else if (d === "]") inCharacterClass = false
        else if (d === "/" && !inCharacterClass) break
        else if (d === "\n") break
        j += 1
      }
      blank(i + 1, j)
      i = j + 1
      previous = "str"
      continue
    }
    if (!/\s/.test(c)) previous = c
    i += 1
  }
  return out.join("")
}

/** `[open, close]` offsets of each `session.run(` argument list. */
function runBodies(masked: string): [number, number][] {
  const bodies: [number, number][] = []
  // Whitespace either side of the dot. `void session\n  .run(async (ctx) =>`
  // is how the drift prefetch is written, and a pattern that only matched
  // `session.run(` read that body as ordinary code: every await inside it
  // would have been judged as if it were outside a run.
  const opener = /\bsession\s*\.\s*run\s*\(/g
  let match: RegExpExecArray | null
  while ((match = opener.exec(masked))) {
    const open = match.index + match[0].length - 1
    let depth = 0
    let j = open
    for (; j < masked.length; j += 1) {
      if (masked[j] === "(") depth += 1
      else if (masked[j] === ")") {
        depth -= 1
        if (depth === 0) break
      }
    }
    bodies.push([open, j])
  }
  return bodies
}

interface AwaitSite {
  line: number
  /** The awaited expression's head, up to and including its `(`. */
  snippet: string
  insideRunBody: boolean
  isStep: boolean
}

function awaitSites(source: string, masked: string): AwaitSite[] {
  const bodies = runBodies(masked)
  const sites: AwaitSite[] = []
  const keyword = /\bawait\b/g
  let match: RegExpExecArray | null
  while ((match = keyword.exec(masked))) {
    const at = match.index
    let start = at + "await".length
    while (start < masked.length && /\s/.test(masked[start])) start += 1
    let end = start
    while (end < masked.length && masked[end] !== "(" && masked[end] !== "\n") {
      end += 1
    }
    const head = source.slice(start, Math.min(end + 1, masked.length))
    sites.push({
      line: source.slice(0, at).split("\n").length,
      snippet: `await ${head}`.replace(/\s+/g, " "),
      insideRunBody: bodies.some(([a, b]) => at > a && at < b),
      isStep: masked.startsWith("ctx.step", start),
    })
  }
  return sites
}

describe("the bare awaits in useEditorEditing.ts", () => {
  it("are all in the inventory, with a reason", async () => {
    const source = await readFile(join(process.cwd(), HOOK_PATH), "utf8")
    const masked = maskLiterals(source)
    expect(masked).toHaveLength(source.length)

    const bare = awaitSites(source, masked).filter(
      (site) => !site.insideRunBody && !site.isStep,
    )
    // Not zero, and not one: a masking bug that swallowed the file would make
    // this test pass by finding nothing at all.
    expect(bare.length).toBeGreaterThan(10)

    const allowed = new Map(
      ALLOWED_BARE_AWAITS.map((entry) => [entry.snippet, entry]),
    )
    const seen = new Map<string, number[]>()
    for (const site of bare) {
      seen.set(site.snippet, [...(seen.get(site.snippet) ?? []), site.line])
    }

    const problems: string[] = []
    for (const [snippet, lines] of seen) {
      const entry = allowed.get(snippet)
      if (!entry) {
        for (const line of lines) {
          problems.push(
            `${HOOK_PATH}:${line}  ${snippet}  is a bare await with no inventory entry. Move it inside a session.run body, or add { snippet, sites, reason } to ALLOWED_BARE_AWAITS saying what runs after it and why a page change may not stop it.`,
          )
        }
        continue
      }
      if (entry.sites !== lines.length) {
        problems.push(
          `${HOOK_PATH}  ${snippet}  is listed with sites: ${entry.sites} and appears ${lines.length} times, at ${lines.join(", ")}. Check the new one against the reason on file, then update the count.`,
        )
      }
    }
    for (const entry of ALLOWED_BARE_AWAITS) {
      if (!seen.has(entry.snippet)) {
        problems.push(
          `${entry.snippet}  is in ALLOWED_BARE_AWAITS and no longer appears in ${HOOK_PATH}. Delete the entry.`,
        )
      }
    }
    expect(problems).toEqual([])
  })

  it("do not include an await inside a run body that skipped ctx.step", async () => {
    // The other half of the rule in `src/editor/session/README.md`. The test
    // above is about awaits OUTSIDE a run; this one is about the inside, where
    // an await that is not a step reaches its value with no `stale` narrowing
    // at all. Without this the run-body exclusion above could hide one.
    const source = await readFile(join(process.cwd(), HOOK_PATH), "utf8")
    const masked = maskLiterals(source)
    const unstepped = awaitSites(source, masked)
      .filter((site) => site.insideRunBody && !site.isStep)
      .map(
        (site) =>
          `${HOOK_PATH}:${site.line}  ${site.snippet}  is awaited inside a session.run body without ctx.step, so its value is readable after the page went away.`,
      )
    expect(unstepped).toEqual([])
  })
})
