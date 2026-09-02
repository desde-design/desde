import { describe, it, expect } from "vitest"
import { detectTextBranches } from "./detect-text-branches"

describe("detectTextBranches", () => {
  it("returns both branches for a ternary with two string literals (the user's case)", () => {
    const source = `<template>
  <div>
    <span class="enabled-label">{{ enabled ? 'This policy is enabled' : 'This policy is disabled' }}</span>
  </div>
</template>
`
    // The <span> is at line 3, column 5 (1-based, after the indent).
    const result = detectTextBranches({ source, line: 3, column: 5 })
    expect(result).not.toBeNull()
    if (!result) return
    expect(result.testExpression).toBe("enabled")
    expect(result.branches).toHaveLength(2)

    const [consequent, alternate] = result.branches
    expect(consequent.kind).toBe("consequent")
    expect(consequent.valueKind).toBe("literal")
    expect(consequent.value).toBe("This policy is enabled")
    // Branch byte range includes the quotes — caller re-wraps the value.
    expect(source.slice(consequent.byteStart, consequent.byteEnd)).toBe("'This policy is enabled'")

    expect(alternate.kind).toBe("alternate")
    expect(alternate.valueKind).toBe("literal")
    expect(alternate.value).toBe("This policy is disabled")
    expect(source.slice(alternate.byteStart, alternate.byteEnd)).toBe("'This policy is disabled'")
  })

  it("treats a non-literal branch as 'bound' and emits its raw JS text as the value", () => {
    const source = `<template>
  <span>{{ enabled ? title : 'Default' }}</span>
</template>
`
    const result = detectTextBranches({ source, line: 2, column: 3 })
    expect(result).not.toBeNull()
    if (!result) return
    const [consequent, alternate] = result.branches
    expect(consequent.valueKind).toBe("bound")
    expect(consequent.value).toBe("title")
    expect(source.slice(consequent.byteStart, consequent.byteEnd)).toBe("title")
    expect(alternate.valueKind).toBe("literal")
    expect(alternate.value).toBe("Default")
  })

  it("treats both branches as 'bound' when neither is a string literal", () => {
    const source = `<template>
  <span>{{ enabled ? title : user.name }}</span>
</template>
`
    const result = detectTextBranches({ source, line: 2, column: 3 })
    expect(result).not.toBeNull()
    if (!result) return
    const [c, a] = result.branches
    expect(c.valueKind).toBe("bound")
    expect(c.value).toBe("title")
    expect(a.valueKind).toBe("bound")
    expect(a.value).toBe("user.name")
  })

  it("returns null when the interpolation is not a ternary", () => {
    const source = `<template>
  <span>{{ title }}</span>
</template>
`
    expect(detectTextBranches({ source, line: 2, column: 3 })).toBeNull()
  })

  it("returns null when the element has a static text child (not an interpolation)", () => {
    const source = `<template>
  <span>Hello</span>
</template>
`
    expect(detectTextBranches({ source, line: 2, column: 3 })).toBeNull()
  })

  it("returns null when the element has mixed children (text + interpolation)", () => {
    const source = `<template>
  <span>Prefix {{ x ? 'a' : 'b' }}</span>
</template>
`
    // Mixed text+interpolation is too ambiguous for v1.
    expect(detectTextBranches({ source, line: 2, column: 3 })).toBeNull()
  })

  it("returns null when no element exists at the given location", () => {
    const source = `<template>
  <span>{{ x ? 'a' : 'b' }}</span>
</template>
`
    expect(detectTextBranches({ source, line: 99, column: 99 })).toBeNull()
  })

  it("handles ternary expressions with quoted strings containing escapes", () => {
    const source = `<template>
  <span>{{ flag ? 'He said: \\'hi\\'' : 'Default' }}</span>
</template>
`
    const result = detectTextBranches({ source, line: 2, column: 3 })
    expect(result).not.toBeNull()
    if (!result) return
    const [c] = result.branches
    expect(c.valueKind).toBe("literal")
    expect(c.value).toBe("He said: 'hi'")
  })
})
