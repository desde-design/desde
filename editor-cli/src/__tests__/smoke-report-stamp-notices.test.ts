/**
 * The boot report distinguishes "everything stamped" from "N files refused".
 *
 * ── The defect, MEASURED (`tasks/dev-server-hosts.md` § 12f) ────────────────
 *
 * Same CLI, same flags, two fixtures:
 *
 *   styled-jsx        1 of 3 files refused → `▸ Smoke check passed`
 *   emotion-classic   3 of 3 files refused → `▸ Smoke check warning: …`
 *
 * The check was never blind; it was EXISTENTIAL over modules. It asks whether
 * ANY module carries a stamp, so a partial refusal is satisfied by a stamp from
 * a different file. The partial shape is the likelier one and the one where a
 * user's main component file is silently inspect-only.
 *
 * These hold the composition: a refusal must survive onto the report on every
 * branch, and `problem` must keep meaning what it meant.
 */
import { describe, expect, it } from "vitest"
import { runSmokeCheck } from "../core.js"
import { stampingCoverage } from "../hosts/coverage.js"
import type { ModuleStampNotice, StampEvidence } from "../hosts/types.js"
import type { RouteProbe, StampVerification } from "../hosts/verify.js"

const refused: ModuleStampNotice = {
  file: "src/App.tsx",
  outcome: "inspect-only",
  detail: "another Vite plugin rewrote it before Editor could stamp it",
}

function probe(over: Partial<RouteProbe> = {}): RouteProbe {
  return {
    route: "/",
    url: "http://127.0.0.1:5173/",
    status: 200,
    contentType: "text/html",
    html: true,
    bridgeTag: true,
    stamps: 1,
    sample: "src/main.tsx:1:0",
    error: null,
    ...over,
  }
}

function verification(
  evidence: StampEvidence,
  over: Partial<RouteProbe> = {},
): StampVerification {
  const p = probe(over)
  return { evidence, bridgeTagPresent: p.bridgeTag, probes: [p], moduleGraphSaidYes: null }
}

const STAMPED: StampEvidence = {
  verdict: "stamped",
  how: "served HTML",
  sample: "src/main.tsx:1:0",
  count: 1,
}

const VITE_COVERAGE = stampingCoverage(["vue-sfc", "jsx"], "vite-plugin")

describe("runSmokeCheck — the per-module half", () => {
  it("passes AND names the refused file, which is the case that used to be silent", () => {
    // This is the styled-jsx row above: `evidence.verdict === "stamped"` is TRUE
    // and correct — `src/main.tsx` really did stamp — while `src/App.tsx` serves
    // nothing and every edit to it is refused.
    const report = runSmokeCheck(verification(STAMPED), false, "module-graph", [refused], VITE_COVERAGE)

    expect(report.problem).toBeNull()
    expect(report.dataPtSrcPresent).toBe(true)
    expect(report.stampNotices).toEqual([refused])
  })

  it("says nothing extra when every compiled file stamped", () => {
    const report = runSmokeCheck(verification(STAMPED), false, "module-graph", [], VITE_COVERAGE)
    expect(report.problem).toBeNull()
    expect(report.stampNotices).toEqual([])
  })

  it("carries the notices onto a FAILING report too", () => {
    // A host can be unreachable AND have refused a file. Dropping the second
    // fact because the first is louder is how two-facts-one-screen got here.
    const unreachable = verification(
      { verdict: "indeterminate", reason: "unreachable" },
      { error: "ECONNREFUSED", status: null, bridgeTag: false, stamps: 0, sample: null },
    )
    const report = runSmokeCheck(unreachable, false, "module-graph", [refused], VITE_COVERAGE)

    expect(report.problem).toContain("unreachable")
    expect(report.stampNotices).toEqual([refused])
  })

  it("does not turn a refusal into a whole-check failure", () => {
    // `problem` makes the CLI print "The editor UI is up but edits may fail
    // until this is resolved." Setting it for a partial refusal would say most
    // of a working app is broken; leaving the refusal out would say a broken
    // file is fine. They are two fields because they are two facts.
    const report = runSmokeCheck(verification(STAMPED), false, "module-graph", [refused], VITE_COVERAGE)
    expect(report.problem).toBeNull()
    expect(report.stampNotices).toHaveLength(1)
  })

  it("defers to a declared coverage gap instead of restating it", () => {
    // Astro: `.astro` markup has no stamper, `hosts/run.ts` already printed the
    // reason once, and § 9 holds the host dormant. The per-module report must
    // not say it again in a louder register.
    const astroCoverage = stampingCoverage(["astro", "jsx"], "vite-plugin")
    const astroNotice: ModuleStampNotice = {
      file: "src/pages/index.astro",
      outcome: "inspect-only",
      detail: "no stamper",
    }
    const report = runSmokeCheck(
      verification(STAMPED),
      false,
      "partial",
      [astroNotice, refused],
      astroCoverage,
    )
    expect(report.stampNotices).toEqual([refused])
  })
})
