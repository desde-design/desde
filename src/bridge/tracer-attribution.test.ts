/**
 * Pins the tracer path-prefix math on the BRIDGE side.
 *
 * `tasks/scripts/.../tracer-path-prefix.test.ts` covers the CLI half — how the
 * offset is COMPUTED. This covers how it is APPLIED, which is where a separate
 * bug lived: the prepend was guarded by `!file.startsWith(prefix)`, so a path
 * that merely began with the same text as the offset was assumed to be
 * repo-relative already and left unprefixed.
 *
 * Both halves matter for the same reason and it is worth being blunt about it:
 * every wrong answer here still names a real, existing file, so nothing
 * throws — the edit simply lands somewhere else. Found by codex review
 * 2026-08-09.
 */
import { afterEach, describe, expect, it } from "vitest"
import { detectIterationViaStamp, groupByLoopContainer, tracer } from "./tracer-attribution"
import type { FrameworkRuntimeAdapter } from "./leaf-prop-attribution"

const w = window as unknown as Record<string, unknown>

function withPrefix(prefix: string | undefined) {
  if (prefix === undefined) delete w.__DESDE_TRACER_PATH_PREFIX__
  else w.__DESDE_TRACER_PATH_PREFIX__ = prefix
}

/** Shape of what `vite-plugin-vue-tracer` hands back. */
const info = (file: string, line = 3, col = 5) => ({ pos: [file, line, col] as [string, number, number] })

afterEach(() => withPrefix(undefined))

describe("tracer.locFromInfo — repo-relative path reconstruction", () => {
  it("returns the tracer path unchanged when there is no offset", () => {
    // The normal single-package prototype: Vite root IS the repo root.
    withPrefix("")
    expect(tracer.locFromInfo(info("src/App.vue"))?.file).toBe("src/App.vue")
  })

  it("prepends the offset for a prototype nested in a larger repo", () => {
    withPrefix("app/")
    expect(tracer.locFromInfo(info("src/App.vue"))?.file).toBe("app/src/App.vue")
  })

  it("prepends even when the path already BEGINS with the offset text", () => {
    // The regression. `viteRoot = <repo>/app`, and the prototype happens to
    // contain its own `app/` directory, so the tracer emits `app/Foo.vue`.
    // The old `!startsWith(prefix)` guard skipped the prepend and resolved to
    // `<repo>/app/Foo.vue` — a DIFFERENT file that may well exist, so the
    // edit lands silently in the wrong place.
    withPrefix("app/")
    expect(tracer.locFromInfo(info("app/Foo.vue"))?.file).toBe("app/app/Foo.vue")
  })

  it("prepends for a deeper offset whose first segment repeats", () => {
    withPrefix("packages/app/")
    expect(tracer.locFromInfo(info("packages/thing.vue"))?.file).toBe("packages/app/packages/thing.vue")
  })

  it("converts the tracer's 0-based column to the 1-based data-desde-src convention", () => {
    withPrefix("")
    const loc = tracer.locFromInfo(info("src/App.vue", 12, 4))
    expect(loc).toEqual({ file: "src/App.vue", line: 12, column: 5 })
  })

  it("returns null rather than a half-built location for unusable input", () => {
    withPrefix("app/")
    expect(tracer.locFromInfo(undefined)).toBeNull()
    expect(tracer.locFromInfo({ pos: undefined } as never)).toBeNull()
    expect(tracer.locFromInfo({ pos: ["", 1, 1] } as never)).toBeNull()
  })
})

/**
 * A runtime with no instances: the same-instance guard passes, no mount root
 * narrows the scope, no key is read. What is left is the DOM, which is the
 * part under test.
 */
const domOnlyAdapter = {
  getOwningInstance: () => null,
  getInstanceMountRoot: () => null,
  getParentInstance: () => null,
  getCallSiteStamp: () => null,
  getInstanceIterationKey: () => null,
} as unknown as FrameworkRuntimeAdapter

const STAMP = "src/components/ui/badge.tsx:39:4"

/**
 * A runtime that knows callsites: each element stands for its own component
 * instance, and its callsite is the `data-callsite` attribute the fixture
 * gives it. This is the React shape, where the plugin's stamp on a component
 * ELEMENT lands on the fiber's props while the DOM carries the component's
 * own root stamp.
 */
const callsiteAdapter = {
  getOwningInstance: (el: Element) => el,
  getInstanceMountRoot: () => null,
  getParentInstance: () => null,
  getCallSiteStamp: (inst: unknown) => (inst as Element).getAttribute("data-callsite"),
  getInstanceIterationKey: () => null,
} as unknown as FrameworkRuntimeAdapter

describe("detectIterationViaStamp — rows come from the loop, not the stamp", () => {
  afterEach(() => {
    document.body.innerHTML = ""
  })

  it("does not count a same-component match rendered by a different loop", () => {
    // The shadcn dashboard, 2026-09-15: four metric badges in a grid, each in
    // its own card, and one status badge in a list elsewhere on the page. All
    // five carry the Badge component's ROOT stamp. The dialog said "item 3 of
    // 5"; the loop has four rows.
    document.body.innerHTML = `
      <main>
        <div class="grid">
          <div class="card"><div class="content"><span data-desde-src="${STAMP}">+12.4%</span></div></div>
          <div class="card"><div class="content"><span data-desde-src="${STAMP}">+3.1%</span></div></div>
          <div class="card"><div class="content"><span id="owner" data-desde-src="${STAMP}">+0.18%</span></div></div>
          <div class="card"><div class="content"><span data-desde-src="${STAMP}">-22ms</span></div></div>
        </div>
        <div class="card"><ul><li><span data-desde-src="${STAMP}">Degraded</span></li></ul></div>
      </main>`
    const owner = document.getElementById("owner")!
    const result = detectIterationViaStamp(owner, null, domOnlyAdapter)
    expect(result).toMatchObject({ source: "v-for", index: 2, siblingCount: 4 })
  })

  it("counts a plain sibling loop by its items", () => {
    document.body.innerHTML = `
      <ul>
        <li data-desde-src="${STAMP}">a</li>
        <li id="owner" data-desde-src="${STAMP}">b</li>
        <li data-desde-src="${STAMP}">c</li>
      </ul>`
    const owner = document.getElementById("owner")!
    expect(detectIterationViaStamp(owner, null, domOnlyAdapter)).toMatchObject({
      index: 1,
      siblingCount: 3,
    })
  })

  it("separates the two loops by callsite when the runtime knows it", () => {
    // Same page as above, with the callsites the React adapter reads off the
    // fibers: the four metric badges share overview.tsx:27, the status badge
    // was written at overview.tsx:47.
    document.body.innerHTML = `
      <main>
        <div class="grid">
          <div class="card"><span data-desde-src="${STAMP}" data-callsite="overview.tsx:27:15">+12.4%</span></div>
          <div class="card"><span data-desde-src="${STAMP}" data-callsite="overview.tsx:27:15">+3.1%</span></div>
          <div class="card"><span id="owner" data-desde-src="${STAMP}" data-callsite="overview.tsx:27:15">+0.18%</span></div>
          <div class="card"><span data-desde-src="${STAMP}" data-callsite="overview.tsx:27:15">-22ms</span></div>
        </div>
        <div class="card"><ul><li><span data-desde-src="${STAMP}" data-callsite="overview.tsx:47:19">Degraded</span></li></ul></div>
      </main>`
    const owner = document.getElementById("owner")!
    expect(detectIterationViaStamp(owner, null, callsiteAdapter)).toMatchObject({
      index: 2,
      siblingCount: 4,
    })
  })

  it("treats two badges written at two callsites inside one row as one row", () => {
    // A card that renders two badges from the same item: two matches, one
    // iteration. From the DOM alone this is indistinguishable from a
    // two-item loop; the callsites are what say otherwise.
    document.body.innerHTML = `
      <div class="grid">
        <div class="card"><span data-desde-src="${STAMP}" data-callsite="c.tsx:27:9">a</span><span data-desde-src="${STAMP}" data-callsite="c.tsx:28:9">a2</span></div>
        <div class="card"><span id="owner" data-desde-src="${STAMP}" data-callsite="c.tsx:27:9">b</span><span data-desde-src="${STAMP}" data-callsite="c.tsx:28:9">b2</span></div>
      </div>`
    const owner = document.getElementById("owner")!
    expect(detectIterationViaStamp(owner, null, callsiteAdapter)).toMatchObject({
      index: 1,
      siblingCount: 2,
    })
  })

  it("keeps a match whose callsite the runtime cannot name", () => {
    // Unknown is not different: the container grouping still judges it.
    document.body.innerHTML = `
      <ul>
        <li><span data-desde-src="${STAMP}" data-callsite="c.tsx:5:7">a</span></li>
        <li><span id="owner" data-desde-src="${STAMP}" data-callsite="c.tsx:5:7">b</span></li>
        <li><span data-desde-src="${STAMP}">c</span></li>
      </ul>`
    const owner = document.getElementById("owner")!
    expect(detectIterationViaStamp(owner, null, callsiteAdapter)).toMatchObject({
      index: 1,
      siblingCount: 3,
    })
  })

  it("reports no iteration when every other match is nested inside the owner's own subtree chain", () => {
    document.body.innerHTML = `
      <div id="owner" data-desde-src="${STAMP}">
        <div><span data-desde-src="${STAMP}">nested</span></div>
      </div>`
    const owner = document.getElementById("owner")!
    expect(detectIterationViaStamp(owner, null, domOnlyAdapter)).toBeUndefined()
  })

  it("groupByLoopContainer returns the rows in document order with the owner's row among them", () => {
    document.body.innerHTML = `
      <section>
        <article><p><b id="x" data-desde-src="${STAMP}">1</b></p></article>
        <article><p><b id="owner" data-desde-src="${STAMP}">2</b></p></article>
        <aside><b data-desde-src="${STAMP}">not a row of this loop</b></aside>
      </section>`
    const owner = document.getElementById("owner")!
    const matches = document.querySelectorAll(`[data-desde-src="${STAMP}"]`)
    const grouped = groupByLoopContainer(owner, matches)!
    // The lowest container that splits owner from another match is <section>:
    // its rows are the two <article>s and the <aside>, in document order.
    expect(grouped.rows.map((r) => r.tagName)).toEqual(["ARTICLE", "ARTICLE", "ASIDE"])
    expect(grouped.ownerRow.tagName).toBe("ARTICLE")
    expect(grouped.rows.indexOf(grouped.ownerRow)).toBe(1)
  })
})
