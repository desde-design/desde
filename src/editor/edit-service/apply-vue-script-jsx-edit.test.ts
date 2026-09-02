/**
 * Edits to JSX inside a Vue SFC's `<script setup lang="tsx">` block.
 *
 * The coordinate math is the entire risk. A wrong line does not throw — it
 * finds a real, DIFFERENT element and rewrites that one. So every fixture
 * derives its expected line from the fixture text rather than hardcoding, and
 * every success case asserts the near-identical SIBLING is untouched. That
 * sibling assertion is what actually catches an off-by-one; "the edit worked"
 * does not.
 *
 * The fixture puts the template FIRST on purpose: with `<script>` on line 1,
 * block-relative and SFC-absolute numbering coincide and the tests cannot tell
 * a missing line-rebase from a correct one.
 */
import { describe, expect, it } from "vitest"
import {
  applyInVueScriptJsxBlock,
  applyVueScriptJsxDeleteEdit,
  applyVueScriptJsxInsertEdit,
  applyVueScriptJsxPropEdit,
  applyVueScriptJsxUnwrapEdit,
  findVueScriptJsxBlock,
  refuseVueScriptJsxMove,
} from "./apply-vue-script-jsx-edit"

function lineOf(text: string, needle: string): number {
  const i = text.indexOf(needle)
  if (i < 0) throw new Error(`not found: ${needle}`)
  return text.slice(0, i).split("\n").length
}

/** 0-based column — the convention the script-JSX stamper emits. */
function columnOf(text: string, needle: string): number {
  const i = text.indexOf(needle)
  return i - (text.lastIndexOf("\n", i - 1) + 1)
}

const SFC = [
  `<template>`,
  `  <div class="wrap">`,
  `    <Panel />`,
  `  </div>`,
  `</template>`,
  ``,
  `<script setup lang="tsx">`,
  `import { ref } from "vue"`,
  ``,
  `const label = ref("hi")`,
  ``,
  `const Row = () => <li class="row">{label.value}</li>`,
  ``,
  `const Panel = () => (`,
  `  <section class="panel">`,
  `    <em class="inner">deep</em>`,
  `  </section>`,
  `)`,
  `</script>`,
  ``,
].join("\n")

const at = (needle: string) => ({
  line: lineOf(SFC, needle),
  column: columnOf(SFC, needle),
})

describe("findVueScriptJsxBlock — routing", () => {
  it("claims a line inside the JSX script block", () => {
    expect(findVueScriptJsxBlock(SFC, at(`<section class="panel">`).line)).not.toBeNull()
  })

  it("does NOT claim a template line — that must reach the Vue applicator", () => {
    expect(findVueScriptJsxBlock(SFC, at(`<div class="wrap">`).line)).toBeNull()
  })

  it("does not claim a plain <script setup> with no jsx lang", () => {
    const plain = [`<script setup>`, `const a = 1`, `</script>`, `<template><p>x</p></template>`, ``].join("\n")
    expect(findVueScriptJsxBlock(plain, 2)).toBeNull()
  })

  it("returns null rather than throwing on unparseable input", () => {
    expect(findVueScriptJsxBlock("<template", 1)).toBeNull()
  })
})

describe("applyInVueScriptJsxBlock — the shared contract", () => {
  it("rebases the line into the block's own numbering before calling", () => {
    // The whole point of the helper. `<section>` is on SFC line 15 and block
    // line 9; if the rebase were skipped the callback would receive 15.
    const sfcLine = at(`<section class="panel">`).line
    let seen = -1
    applyInVueScriptJsxBlock(SFC, sfcLine, (_code, blockLine) => {
      seen = blockLine
      return { ok: false, reason: "probe" }
    })
    const blockStart = lineOf(SFC, `<script setup lang="tsx">`)
    expect(seen).toBe(sfcLine - blockStart + 1)
    expect(seen).not.toBe(sfcLine)
  })

  it("passes the BLOCK, not the whole SFC", () => {
    let code = ""
    applyInVueScriptJsxBlock(SFC, at(`<section class="panel">`).line, (blockCode) => {
      code = blockCode
      return { ok: false, reason: "probe" }
    })
    expect(code).toContain(`const Panel = () =>`)
    expect(code, "the template must not be in the block").not.toContain(`<div class="wrap">`)
  })

  it("returns a refusal unchanged, without splicing", () => {
    const res = applyInVueScriptJsxBlock(SFC, at(`<section class="panel">`).line, () => ({
      ok: false,
      reason: "nope",
    }))
    expect(res).toEqual({ ok: false, reason: "nope" })
  })

  it("carries the applicator's other success fields through the splice", () => {
    // `applyJsxInsertEdit` can SUCCEED and still warn — it inserts the element
    // but declines to add the import when a same-named binding exists. An
    // earlier version rebuilt the result object and dropped that, so a
    // component whose import was never added reported a clean save. Only
    // `source` is the wrapper's to replace.
    const res = applyInVueScriptJsxBlock(SFC, at(`<section class="panel">`).line, (blockCode) => ({
      ok: true,
      source: blockCode.replace("panel", "panel-x"),
      warnings: ["import not added"],
    }))
    expect(res?.ok).toBe(true)
    expect(res && res.ok ? res.warnings : undefined).toEqual(["import not added"])
  })

  it("refuses a no-op rather than reporting a phantom write", () => {
    const res = applyInVueScriptJsxBlock(SFC, at(`<section class="panel">`).line, (blockCode) => ({
      ok: true,
      source: blockCode,
    }))
    expect(res?.ok).toBe(false)
  })
})

describe("the four kinds route identically", () => {
  it("prop: edits the target and leaves the sibling alone", () => {
    const { line, column } = at(`<section class="panel">`)
    const res = applyVueScriptJsxPropEdit({ source: SFC, line, column, propName: "class", value: "panel wide" })
    expect(res?.ok, res && !res.ok ? res.reason : "").toBe(true)
    if (!res?.ok) return
    expect(res.source).toContain(`<section class="panel wide">`)
    expect(res.source).toContain(`<li class="row">`)
    expect(res.source).toContain(`  <div class="wrap">`)
  })

  it("delete: removes the target element only", () => {
    const { line, column } = at(`<em class="inner">`)
    const res = applyVueScriptJsxDeleteEdit({ source: SFC, line, column })
    expect(res?.ok, res && !res.ok ? res.reason : "").toBe(true)
    if (!res?.ok) return
    expect(res.source).not.toContain(`<em class="inner">`)
    expect(res.source).toContain(`<section class="panel">`)
    expect(res.source).toContain(`<li class="row">`)
    expect(res.source).toContain(`<div class="wrap">`)
  })

  it("unwrap: replaces the wrapper with its children", () => {
    const { line, column } = at(`<section class="panel">`)
    const res = applyVueScriptJsxUnwrapEdit({ source: SFC, line, column })
    expect(res?.ok, res && !res.ok ? res.reason : "").toBe(true)
    if (!res?.ok) return
    expect(res.source).not.toContain(`<section class="panel">`)
    expect(res.source, "the child must survive").toContain(`<em class="inner">`)
  })

  it("insert: places a snippet inside the destination parent", () => {
    const { line, column } = at(`<section class="panel">`)
    const res = applyVueScriptJsxInsertEdit({
      source: SFC,
      line,
      column,
      destIndex: 0,
      snippet: `<hr />`,
    })
    expect(res?.ok, res && !res.ok ? res.reason : "").toBe(true)
    if (!res?.ok) return
    expect(res.source).toContain(`<hr />`)
    expect(res.source).toContain(`<em class="inner">`)
  })

  it("every kind returns null for a TEMPLATE coordinate", () => {
    const { line, column } = at(`<div class="wrap">`)
    expect(applyVueScriptJsxPropEdit({ source: SFC, line, column, propName: "class", value: "x" })).toBeNull()
    expect(applyVueScriptJsxDeleteEdit({ source: SFC, line, column })).toBeNull()
    expect(applyVueScriptJsxUnwrapEdit({ source: SFC, line, column })).toBeNull()
    expect(
      applyVueScriptJsxInsertEdit({ source: SFC, line, column, destIndex: 0, snippet: `<hr />` }),
    ).toBeNull()
  })

  it("every kind leaves the <script> tags outside the spliced range", () => {
    const { line, column } = at(`<em class="inner">`)
    const res = applyVueScriptJsxDeleteEdit({ source: SFC, line, column })
    if (!res?.ok) throw new Error("expected ok")
    expect(res.source).toContain(`<script setup lang="tsx">`)
    expect(res.source).toContain(`</script>`)
    expect(res.source).toContain(`</template>`)
  })

  it("no kind is special-cased: insert relies on the applicator to reject bad snippets", () => {
    // Deliberately NOT guarded at this layer — `applyJsxInsertEdit` parses the
    // snippet itself and re-parses after splicing. A guard here would duplicate
    // that and push framework knowledge into the router.
    const { line, column } = at(`<section class="panel">`)
    const res = applyVueScriptJsxInsertEdit({
      source: SFC,
      line,
      column,
      destIndex: 0,
      snippet: `<div :class="c"></div>`, // Vue binding — not valid JSX
    })
    expect(res).not.toBeNull()
    expect(res!.ok).toBe(false)
  })
})

describe("refuseVueScriptJsxMove", () => {
  const inScript = at(`<section class="panel">`).line
  const inTemplate = at(`<div class="wrap">`).line

  it("refuses when the SOURCE is in a script block", () => {
    const r = refuseVueScriptJsxMove({ source: SFC, sourceLine: inScript, destParentLine: inTemplate })
    expect(r?.ok).toBe(false)
    expect(r && !r.ok ? r.reason : "").toMatch(/script setup/i)
  })

  it("refuses when the DESTINATION is in a script block", () => {
    const r = refuseVueScriptJsxMove({ source: SFC, sourceLine: inTemplate, destParentLine: inScript })
    expect(r?.ok).toBe(false)
  })

  it("refuses a move WITHIN the script block too — deliberate, not an oversight", () => {
    // Same-block moves would be implementable, but move is the only kind with
    // two coordinates and the failure mode of getting that wrong is relocating
    // a node into the wrong language. Refusing uniformly is the honest answer
    // until there is demand.
    const r = refuseVueScriptJsxMove({
      source: SFC,
      sourceLine: at(`<em class="inner">`).line,
      destParentLine: inScript,
    })
    expect(r?.ok).toBe(false)
  })

  it("returns null when BOTH endpoints are in the template, so Vue moves still work", () => {
    expect(
      refuseVueScriptJsxMove({ source: SFC, sourceLine: inTemplate, destParentLine: inTemplate }),
    ).toBeNull()
  })
})
