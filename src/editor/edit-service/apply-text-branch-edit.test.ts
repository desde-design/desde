import { describe, it, expect } from "vitest"
import { applyTextBranchEdit } from "./apply-text-branch-edit"
import { detectTextBranches } from "./detect-text-branches"

describe("applyTextBranchEdit", () => {
  it("rewrites the consequent literal branch in the user's actual case", () => {
    const source = `<template>
  <span class="enabled-label">{{ enabled ? 'This policy is enabled' : 'This policy is disabled' }}</span>
</template>
`
    const detection = detectTextBranches({ source, line: 2, column: 3 })
    expect(detection).not.toBeNull()
    if (!detection) return
    const [consequent] = detection.branches

    const result = applyTextBranchEdit({
      source,
      byteStart: consequent.byteStart,
      byteEnd: consequent.byteEnd,
      valueKind: consequent.valueKind,
      newValue: "Enabled",
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.source).toContain("{{ enabled ? 'Enabled' : 'This policy is disabled' }}")
    expect(result.source).not.toContain("This policy is enabled")
  })

  it("rewrites the alternate literal branch independently", () => {
    const source = `<template>
  <span>{{ flag ? 'A' : 'B' }}</span>
</template>
`
    const detection = detectTextBranches({ source, line: 2, column: 3 })
    if (!detection) throw new Error("detection failed")
    const [, alternate] = detection.branches

    const result = applyTextBranchEdit({
      source,
      byteStart: alternate.byteStart,
      byteEnd: alternate.byteEnd,
      valueKind: alternate.valueKind,
      newValue: "Bee",
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.source).toContain("{{ flag ? 'A' : 'Bee' }}")
  })

  it("re-wraps literal values in single quotes and escapes inner quotes / backslashes", () => {
    const source = `<template>
  <span>{{ x ? 'a' : 'b' }}</span>
</template>
`
    const detection = detectTextBranches({ source, line: 2, column: 3 })
    if (!detection) throw new Error("detection failed")
    const [consequent] = detection.branches

    const result = applyTextBranchEdit({
      source,
      byteStart: consequent.byteStart,
      byteEnd: consequent.byteEnd,
      valueKind: "literal",
      newValue: "She said 'hi' \\ done",
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // Inner quotes escaped, backslash escaped, then re-parsed by Vue
    // compile (no error → ok=true above).
    expect(result.source).toContain(`'She said \\'hi\\' \\\\ done'`)
  })

  it("splices bound expressions verbatim (no quote wrapping)", () => {
    const source = `<template>
  <span>{{ flag ? title : 'Default' }}</span>
</template>
`
    const detection = detectTextBranches({ source, line: 2, column: 3 })
    if (!detection) throw new Error("detection failed")
    const [consequent] = detection.branches
    expect(consequent.valueKind).toBe("bound")

    const result = applyTextBranchEdit({
      source,
      byteStart: consequent.byteStart,
      byteEnd: consequent.byteEnd,
      valueKind: "bound",
      // The user can rename the variable reference, or even swap to a
      // literal by including their own quotes — splice is verbatim.
      newValue: "user.displayName",
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.source).toContain("{{ flag ? user.displayName : 'Default' }}")
  })

  it("refuses when the post-splice template fails Vue compile (bound branch with broken JS)", () => {
    const source = `<template>
  <span>{{ flag ? title : 'Default' }}</span>
</template>
`
    const detection = detectTextBranches({ source, line: 2, column: 3 })
    if (!detection) throw new Error("detection failed")
    const [consequent] = detection.branches

    const result = applyTextBranchEdit({
      source,
      byteStart: consequent.byteStart,
      byteEnd: consequent.byteEnd,
      valueKind: "bound",
      // Unbalanced parens — would silently break the dev server if we
      // didn't validate post-splice.
      newValue: "foo(",
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/not valid JavaScript|compile failed/i)
  })

  it("refuses bound edits that parse standalone but break the ternary when spliced (`a, b` case)", () => {
    // Codex review finding: `parseExpression("a, b")` succeeds standalone
    // (it's a SequenceExpression — valid JS), so the pre-splice check
    // accepts. But spliced into `flag ? <here> : 'Default'` it produces
    // `flag ? a, b : 'Default'` — which is `(flag ? a), b`, not the
    // intended ternary. Vue's template compile happily emits this, so
    // the post-splice template re-parse must catch it by re-validating
    // every interpolation expression's structural integrity.
    const source = `<template>
  <span>{{ flag ? title : 'Default' }}</span>
</template>
`
    const detection = detectTextBranches({ source, line: 2, column: 3 })
    if (!detection) throw new Error("detection failed")
    const [consequent] = detection.branches

    const result = applyTextBranchEdit({
      source,
      byteStart: consequent.byteStart,
      byteEnd: consequent.byteEnd,
      valueKind: "bound",
      newValue: "a, b",
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/interpolation invalid|not valid JavaScript/i)
  })

  it("refuses when byte range is out of bounds", () => {
    const result = applyTextBranchEdit({
      source: "short",
      byteStart: 100,
      byteEnd: 200,
      valueKind: "literal",
      newValue: "x",
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/out of bounds/i)
  })
})
