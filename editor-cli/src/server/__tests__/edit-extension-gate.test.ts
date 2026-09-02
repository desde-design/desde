/**
 * Truth-table test for the edit dispatcher's extension gate (audit Task 23).
 *
 * `applyEdit` runs this gate twice — once on the lexical candidate path, once
 * on the realpath'd target — and those two checks used to be hand-duplicated
 * inline. A new edit kind could be added to one copy's table and silently
 * missed by the other, leaving a lane open post-symlink that was closed pre-
 * symlink (or vice versa).
 *
 * The table below supersedes that risk two ways:
 *
 *  1. It is typed `Record<EditKind, …>`, so ADDING A KIND to the validator's
 *     union fails typecheck here until its accepted extensions are declared.
 *  2. Every row asserts BOTH phases reach the same accept/reject decision —
 *     the phase may only change the refusal WORDING.
 */

import { describe, expect, it } from "vitest"
import {
  checkExtensionGate,
  editLaneFlags,
  type EditKind,
} from "../edit-extension-gate.js"

/** Every extension the gate is asked about across the handler's lanes. */
const ALL_EXTENSIONS = [".vue", ".ts", ".tsx", ".jsx", ".css", ".js"] as const
type Ext = (typeof ALL_EXTENSIONS)[number]

/**
 * The truth table: which extensions each kind ACCEPTS. Everything else in
 * `ALL_EXTENSIONS` must be refused.
 *
 * Typed as a total `Record<EditKind, …>` on purpose — a new edit kind cannot
 * land without a decision recorded here.
 */
const ACCEPTED: Record<EditKind, readonly Ext[]> = {
  // JSX-capable lanes: Vue SFCs + React JSX.
  prop: [".vue", ".tsx", ".jsx"],
  move: [".vue", ".tsx", ".jsx"],
  delete: [".vue", ".tsx", ".jsx"],
  insert: [".vue", ".tsx", ".jsx"],
  unwrap: [".vue", ".tsx", ".jsx"],
  "text-branch": [".vue", ".tsx", ".jsx"],
  "flatten-conditional": [".vue", ".tsx", ".jsx"],
  // Vue-only lanes (their applicators mutate SFC AST; no JSX sibling).
  detach: [".vue"],
  swap: [".vue"],
  // Cross-substrate, but it writes a STYLESHEET rather than a component: a
  // Vue SFC's own `<style scoped>` block, or a project `.css` on a substrate
  // that has no such block (React). `.tsx` is refused — a rule cannot live in
  // a component file — and `node_modules` is refused separately, after
  // symlink resolution, so widening to `.css` opens no library stylesheet.
  "scoped-css-override": [".vue", ".css"],
  // llm-patch never reaches the gate (handled before path resolution), but it
  // is part of the kind union, so the table stays total. Vue-only by default.
  "llm-patch": [".vue"],
  // The overwrite lane also admits plain .ts (composables, utilities).
  overwrite: [".vue", ".ts", ".tsx", ".jsx"],
  // React-only styling lane — no Vue analog (that's scoped-css-override).
  "jsx-style": [".tsx", ".jsx"],
  // First-party CSS token files only.
  "token-value": [".css"],
}

const ALL_KINDS = Object.keys(ACCEPTED) as EditKind[]

describe("checkExtensionGate — truth table", () => {
  for (const kind of ALL_KINDS) {
    for (const ext of ALL_EXTENSIONS) {
      const shouldAccept = ACCEPTED[kind].includes(ext)
      const filePath = `src/Widget${ext}`

      it(`${kind}: ${shouldAccept ? "accepts" : "refuses"} ${ext}`, () => {
        const candidate = checkExtensionGate(kind, filePath, "candidate")
        const resolved = checkExtensionGate(kind, filePath, "resolved")

        expect(candidate.ok).toBe(shouldAccept)
        // The decision is phase-INDEPENDENT: re-running the gate after symlink
        // resolution applies the same rule to the resolved bytes. Only the
        // refusal wording differs.
        expect(resolved.ok).toBe(candidate.ok)
      })
    }
  }

  it("refusal wording differs by phase but the decision does not", () => {
    const candidate = checkExtensionGate("token-value", "src/App.vue", "candidate")
    const resolved = checkExtensionGate("token-value", "src/App.vue", "resolved")
    expect(candidate.ok).toBe(false)
    expect(resolved.ok).toBe(false)
    if (!candidate.ok && !resolved.ok) {
      expect(candidate.reason).toBe("Token edits require a .css file")
      expect(resolved.reason).toBe("Resolved target is not a .css file")
    }
  })

  it("reports the exact refusal string for each lane shape (candidate phase)", () => {
    const reasonFor = (kind: EditKind, p: string): string => {
      const r = checkExtensionGate(kind, p, "candidate")
      return r.ok ? "<accepted>" : r.reason
    }
    expect(reasonFor("token-value", "a.vue")).toBe("Token edits require a .css file")
    expect(reasonFor("jsx-style", "a.vue")).toBe(
      "This edit kind requires a .tsx or .jsx file",
    )
    expect(reasonFor("prop", "a.css")).toBe(
      "This edit kind requires a .vue, .tsx, or .jsx file",
    )
    expect(reasonFor("overwrite", "a.css")).toBe(
      "Only .vue, .ts, .tsx, and .jsx files are supported",
    )
    expect(reasonFor("detach", "a.tsx")).toBe(
      "Only .vue files are supported for this edit kind",
    )
  })

  it("reports the exact refusal string for each lane shape (resolved phase)", () => {
    const reasonFor = (kind: EditKind, p: string): string => {
      const r = checkExtensionGate(kind, p, "resolved")
      return r.ok ? "<accepted>" : r.reason
    }
    expect(reasonFor("token-value", "a.vue")).toBe("Resolved target is not a .css file")
    expect(reasonFor("jsx-style", "a.vue")).toBe(
      "Resolved target is not a .tsx or .jsx file",
    )
    expect(reasonFor("prop", "a.css")).toBe(
      "Resolved target is not a .vue, .tsx, or .jsx file",
    )
    expect(reasonFor("overwrite", "a.css")).toBe(
      "Resolved target is not a .vue, .ts, .tsx, or .jsx file",
    )
    expect(reasonFor("detach", "a.tsx")).toBe("Resolved target is not a .vue file")
  })
})

describe("checkExtensionGate — derived classification", () => {
  it("classifies .ts/.tsx/.jsx as an OverwriteExtension only on the overwrite lane", () => {
    const overwriteTs = checkExtensionGate("overwrite", "a.ts", "candidate")
    expect(overwriteTs.ok && overwriteTs.ext).toBe("ts")
    const overwriteTsx = checkExtensionGate("overwrite", "a.tsx", "candidate")
    expect(overwriteTsx.ok && overwriteTsx.ext).toBe("tsx")
    // The prop lane admits .tsx via the JSX branch, but it is NOT an
    // overwrite-extension there — the overwrite-source validator must not run
    // against it.
    const propTsx = checkExtensionGate("prop", "a.tsx", "candidate")
    expect(propTsx.ok && propTsx.ext).toBe(null)
  })

  it("classifies .vue as an OverwriteExtension on every lane that admits it", () => {
    for (const kind of ALL_KINDS) {
      if (!ACCEPTED[kind].includes(".vue")) continue
      const r = checkExtensionGate(kind, "a.vue", "candidate")
      expect(r.ok && r.ext).toBe("vue")
    }
  })

  it("reports isJsx purely from the path, independent of lane", () => {
    for (const kind of ALL_KINDS) {
      const tsx = checkExtensionGate(kind, "a.tsx", "candidate")
      if (tsx.ok) expect(tsx.isJsx).toBe(true)
      const vue = checkExtensionGate(kind, "a.vue", "candidate")
      if (vue.ok) expect(vue.isJsx).toBe(false)
    }
  })
})

describe("editLaneFlags", () => {
  it("assigns each kind to at most one exclusive lane", () => {
    for (const kind of ALL_KINDS) {
      const f = editLaneFlags(kind)
      const exclusive = [
        f.isOverwriteLane,
        f.isTokenLane,
        f.isJsxOnlyLane,
        f.isScopedCssLane,
      ].filter(Boolean).length
      expect(exclusive).toBeLessThanOrEqual(1)
      // A JSX-capable lane is never also one of the exclusive lanes.
      if (f.isJsxCapableLane) expect(exclusive).toBe(0)
    }
  })

  it("pins the lane membership the gate derives everything from", () => {
    expect(editLaneFlags("overwrite").isOverwriteLane).toBe(true)
    expect(editLaneFlags("token-value").isTokenLane).toBe(true)
    expect(editLaneFlags("jsx-style").isJsxOnlyLane).toBe(true)
    expect(editLaneFlags("prop").isJsxCapableLane).toBe(true)
    expect(editLaneFlags("detach").isJsxCapableLane).toBe(false)
    expect(editLaneFlags("swap").isJsxCapableLane).toBe(false)
    expect(editLaneFlags("scoped-css-override").isScopedCssLane).toBe(true)
    // …and it is NOT the token lane, whose `.css` acceptance it resembles.
    // Two lanes may write a stylesheet; only one of them may write a token.
    expect(editLaneFlags("scoped-css-override").isTokenLane).toBe(false)
    expect(editLaneFlags("token-value").isScopedCssLane).toBe(false)
  })
})
