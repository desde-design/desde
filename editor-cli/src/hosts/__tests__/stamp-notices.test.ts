/**
 * The per-MODULE half of the boot report.
 *
 * ── What is under test, and why it is not "the strings are right" ───────────
 *
 * MEASURED, 2026-08-11 (`tasks/dev-server-hosts.md` § 12f). The boot smoke check
 * is EXISTENTIAL over modules: it asks whether ANY module carries a stamp. Two
 * fixtures, same CLI, same flags:
 *
 *   styled-jsx        1 of 3 files refused → `▸ Smoke check passed`
 *   emotion-classic   3 of 3 files refused → `▸ Smoke check warning: …`
 *
 * It catches the total case and cannot see the partial one — which is the
 * likelier shape, and the one where the user's main component file is silently
 * inspect-only. The properties held here are the three that close that:
 *
 *   1. a refusal produces a line that NAMES the file;
 *   2. a clean boot produces NOTHING, so the signal stays worth reading;
 *   3. a file whose language the host ALREADY declared uncovered produces
 *      nothing either — the coverage declaration is reused, not duplicated.
 */
import { describe, expect, it } from "vitest"
import { stampingCoverage } from "../coverage.js"
import { formatStampNoticeLines, visibleStampNotices } from "../stamp-notices.js"
import type { ModuleStampNotice } from "../types.js"

const refused: ModuleStampNotice = {
  file: "src/App.tsx",
  outcome: "inspect-only",
  detail: "another Vite plugin rewrote it before Editor could stamp it",
}

const suspect: ModuleStampNotice = {
  file: "src/Widget.vue",
  outcome: "coordinates-suspect",
  detail: "another Vite plugin rewrote it before Editor could stamp it",
}

describe("visibleStampNotices — the join against declared coverage", () => {
  it("keeps a refusal for a language the host claims to cover", () => {
    const coverage = stampingCoverage(["jsx"], "vite-plugin")
    expect(visibleStampNotices([refused], coverage)).toEqual([refused])
  })

  it("drops a notice for a language coverage already declared uncovered", () => {
    // `.astro` markup has no stamper, the Astro host declares that before boot,
    // and `hosts/run.ts` prints the reason once. A per-module notice for the
    // same file would be a SECOND notion of "expected to be missing", louder and
    // phrased differently, for a state working as designed.
    const coverage = stampingCoverage(["astro", "jsx"], "vite-plugin")
    expect(coverage.uncovered.map((u) => u.language)).toEqual(["astro"])

    const astroNotice: ModuleStampNotice = {
      file: "src/pages/index.astro",
      outcome: "inspect-only",
      detail: "no stamper",
    }
    expect(visibleStampNotices([astroNotice, refused], coverage)).toEqual([refused])
  })

  it("keeps a notice whose extension maps to no declared language", () => {
    // No declaration covers it, so there is nothing to defer to. Losing it would
    // mean a stamper added tomorrow silently drops its notices into a table
    // nobody remembered to extend.
    const coverage = stampingCoverage(["astro"], "vite-plugin")
    const svelte: ModuleStampNotice = {
      file: "src/Thing.svelte",
      outcome: "inspect-only",
      detail: "no stamper",
    }
    expect(visibleStampNotices([svelte], coverage)).toEqual([svelte])
  })

  it("keeps everything when the host declared no coverage at all", () => {
    // Attach mode and the `null` coverage case: no declaration exists, so
    // nothing may be suppressed on the strength of one.
    expect(visibleStampNotices([refused, suspect], null)).toHaveLength(2)
  })

  it("sorts by file so two boots of one project print the same list", () => {
    const out = visibleStampNotices([suspect, refused], null)
    expect(out.map((n) => n.file)).toEqual(["src/App.tsx", "src/Widget.vue"])
  })

  it("never prints one file twice for the same outcome", () => {
    expect(visibleStampNotices([refused, { ...refused }], null)).toHaveLength(1)
  })

  it("does print one file twice when the two outcomes differ", () => {
    // Two different consequences with two different remedies. Collapsing them
    // would hide whichever arrived second.
    const both = visibleStampNotices(
      [refused, { ...refused, outcome: "coordinates-suspect" }],
      null,
    )
    expect(both.map((n) => n.outcome)).toEqual(["inspect-only", "coordinates-suspect"])
  })
})

describe("formatStampNoticeLines — the boot block", () => {
  it("prints nothing on a healthy boot", () => {
    // The requirement that keeps this readable. The line it sits under already
    // prints on every successful boot; a second one saying "and nothing is
    // wrong" is read a dozen times and then never again.
    expect(formatStampNoticeLines([])).toEqual([])
  })

  it("names the file and leads with what the user loses", () => {
    const lines = formatStampNoticeLines([refused])
    expect(lines[0]).toContain("1 file")
    // Consequence before cause: "selectable but not editable" is the thing they
    // would otherwise discover by clicking; the cause matters only once they
    // believe the consequence.
    expect(lines[1]).toContain("src/App.tsx")
    expect(lines[1]).toContain("selectable")
    expect(lines[1]).not.toContain("another Vite plugin")
    expect(lines[2]).toContain("another Vite plugin")
  })

  it("distinguishes stamped-but-suspect from inspect-only", () => {
    // Not the same failure and not the same remedy. `coordinates-suspect` files
    // DO stamp, so nothing else in the boot report mentions them at all.
    const [, line] = formatStampNoticeLines([suspect])
    expect(line).toContain("wrong element")
    expect(line).not.toContain("refused")
  })

  it("counts and lists every file", () => {
    const lines = formatStampNoticeLines([refused, suspect])
    expect(lines[0]).toContain("2 files")
    expect(lines).toHaveLength(6) // header + 2 files × (name + cause) + closing note
  })

  it("says the report is a snapshot, because it is", () => {
    // A stamper only sees a module when something compiles it. Anything compiled
    // after this point still prints its own `[stamp]` line, and the report must
    // not read as a complete audit of the repo.
    const lines = formatStampNoticeLines([refused])
    expect(lines[lines.length - 1]).toContain("[stamp]")
  })

  it("claims no denominator, because the input contains none", () => {
    // The first draft opened "Stamping is PARTIAL" and closed "Every other
    // compiled file stamped normally". Correct against the styled-jsx fixture
    // (1 of 3 refused) and flatly FALSE against `@emotion/babel-preset-css-prop`,
    // where all three refused and the block still called it partial. How many
    // files stamped is not in this input: a file with no notice may have
    // stamped, or may contain no elements at all. The smoke line above decides
    // partial-versus-total on evidence; this block must not second-guess it.
    const everything = formatStampNoticeLines([refused, suspect]).join("\n")
    expect(everything).not.toContain("PARTIAL")
    expect(everything).not.toContain("Every other")
    expect(everything).toContain("Files not listed here reported no problem")
  })
})

/**
 * The cap exists because of a measurement, not a hunch: on a 302-module fixture
 * where every file refused, the uncapped block was 604 lines inside a 916-line
 * boot log, and it pushed the line that decides what to do — the smoke-check
 * warning — off the top of the terminal.
 */
describe("formatStampNoticeLines — the cap", () => {
  const many = (n: number): ModuleStampNotice[] =>
    Array.from({ length: n }, (_, i) => ({
      file: `src/File${i}.tsx`,
      outcome: "inspect-only" as const,
      detail: "the transform changed the element count (5 authored, 7 after)",
    }))

  it("lists every file when there are few", () => {
    const lines = formatStampNoticeLines(many(3))
    expect(lines.filter((l) => l.includes("src/File")).length).toBe(3)
    expect(lines.join("\n")).not.toContain("…and")
  })

  it("caps the list and says how many were withheld", () => {
    const lines = formatStampNoticeLines(many(302))
    const listed = lines.filter((l) => l.trimStart().startsWith("src/File")).length
    expect(listed).toBe(12)
    expect(lines.join("\n")).toContain("…and 290 more files")
  })

  it("stays short enough that the smoke line above it survives a terminal", () => {
    // The regression in one number: 302 files used to produce 606 lines.
    expect(formatStampNoticeLines(many(302)).length).toBeLessThan(30)
  })

  it("says 'file' not 'files' when exactly one is withheld", () => {
    expect(formatStampNoticeLines(many(13)).join("\n")).toContain("…and 1 more file.")
  })
})
