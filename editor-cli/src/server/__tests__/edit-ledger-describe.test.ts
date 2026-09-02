/**
 * Every `brokeredWrite` call in the edit handler and the SDK structural
 * tools must pass a `describe`.
 *
 * A source-level assertion rather than a behavioural one, deliberately:
 * the failure this guards against is a NEW write lane landing without a
 * ledger description, and no runtime test over today's lanes can see
 * tomorrow's omission. This is the same shape of guard the protected-path
 * work needed after audit finding B7.
 */

import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const REPO_ROOT = join(__dirname, "..", "..", "..", "..")

const SOURCES = [
  "editor-cli/src/server/edit-handler.ts",
  "src/editor/agent-chat-sdk/fs-structural-tools.ts",
  "src/editor/edit-service/edit-history.ts",
]

describe("ledger description coverage", () => {
  for (const rel of SOURCES) {
    it(`every brokeredWrite in ${rel} passes a describe`, () => {
      const source = readFileSync(join(REPO_ROOT, rel), "utf8")
      const lines = source.split("\n")
      const opens = lines
        .map((line, lineIndex) => ({ line, lineIndex }))
        .filter(({ line }) => line.includes("brokeredWrite({"))
      expect(opens.length).toBeGreaterThan(0)
      for (const [i, { line, lineIndex }] of opens.entries()) {
        // The call's own options object closes with `})` at the SAME
        // indentation as the line that opens the call. A fixed line-count
        // window (the original version of this test) is unsafe: if two
        // `brokeredWrite` calls ever land closer together than the
        // window, scanning past the true close reads into the NEXT
        // call's `describe:` and a genuinely missing one passes silently.
        // A bare `/^\s*\}\)/` marker has the opposite problem — several
        // call sites here pass a callback (`emit: () => emitEdit({...})`)
        // whose own closing line is ALSO `})`, just indented one level
        // deeper, so an indentation-blind marker stops there instead of
        // at the call's real end. Matching on indentation is what avoids
        // both failure modes without a full brace matcher.
        const indent = /^\s*/.exec(line)?.[0] ?? ""
        const closeRe = new RegExp(`^${indent}\\}\\)`)
        const closeOffset = lines.slice(lineIndex + 1).findIndex((l) => closeRe.test(l))
        // A call whose options object never closes at its own indentation
        // in this file means the marker stopped matching the code (e.g. a
        // reformat) — fail loudly rather than scanning an unbounded
        // region and finding the wrong call's `describe:`.
        expect(
          closeOffset,
          `could not find the end of brokeredWrite #${i + 1} in ${rel}`,
        ).toBeGreaterThan(-1)
        const optionsObject = lines.slice(lineIndex + 1, lineIndex + 1 + closeOffset).join("\n")
        expect(
          optionsObject,
          `brokeredWrite #${i + 1} in ${rel} has no describe`,
        ).toContain("describe:")
      }
    })
  }
})
