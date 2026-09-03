// @vitest-environment jsdom
/**
 * Proves (or disproves) the React "mount root" helpers added in d42714d —
 * `getReactFiberOf`, `reactComponentName`, `getReactComponentMountRoot`,
 * `detectReactOutlineComponent`, and `buildReactComponentTree`'s new
 * `elementSelector` fill — against REAL React 19 fibers, not the fabricated
 * fiber objects `framework-component-detection.test.ts` uses. Every case
 * renders real components with `react-dom/client` and reads the actual
 * `__reactFiber$…` the runtime attaches.
 */
import { describe, it, expect, afterEach } from "vitest"
import * as React from "react"
import { createRoot, type Root } from "react-dom/client"
import { act } from "react"
import { createPortal } from "react-dom"
import {
  getReactFiberOf,
  getReactComponentMountRoot,
  detectOutlineComponent,
  detectReactOutlineComponent,
  buildReactComponentTree,
} from "./framework-component-detection"
import { generateSelector } from "./selector-engine"

// ── Mount helper ──────────────────────────────────────────────────────
//
// Each test gets its own container appended to `document.body`, and every
// container is torn down in `afterEach` — `generateSelector` walks
// `document.querySelectorAll`, so a leftover container from an earlier test
// would make class-based selectors ambiguous across tests.
const roots: { root: Root; container: HTMLElement }[] = []

function mount(el: React.ReactElement): HTMLElement {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(el)
  })
  roots.push({ root, container })
  return container
}

afterEach(() => {
  while (roots.length > 0) {
    const { root, container } = roots.pop()!
    act(() => {
      root.unmount()
    })
    container.remove()
  }
})

describe("React mount-root helpers, against real React 19 fibers", () => {
  it("case 1: function component with a single host root, three levels deep (App > Overview > Button), mirrors viewer/fixtures/demo-react", () => {
    function Button({ variant, children }: { variant: string; children: React.ReactNode }) {
      return <a className={`button button--${variant}`}>{children}</a>
    }
    function Overview() {
      return (
        <>
          <section className="intro">Overview intro</section>
          <div className="actions">
            <Button variant="secondary">
              <span className="label">View all</span>
            </Button>
          </div>
        </>
      )
    }
    function App() {
      return (
        <div className="app-shell">
          <Overview />
        </div>
      )
    }

    const container = mount(<App />)
    const appShellDiv = container.querySelector(".app-shell")!
    const introSection = container.querySelector(".intro")!
    const actionsDiv = container.querySelector(".actions")!
    const a = container.querySelector("a")!
    const span = container.querySelector(".label")!

    // buildReactComponentTree: root-first, one node per named component,
    // each carrying the elementSelector of ITS OWN mount root (App's is the
    // shell div, Overview's is the intro section — not the div that wraps
    // Button, since that div is not Overview's own first-rendered host).
    const tree = buildReactComponentTree(a)
    expect(tree.map((n) => n.name)).toEqual(["App", "Overview", "Button"])
    expect(tree[0].elementSelector).toBe(generateSelector(appShellDiv))
    expect(tree[1].elementSelector).toBe(generateSelector(introSection))
    expect(tree[2].elementSelector).toBe(generateSelector(a))

    // detectOutlineComponent labels each component's own mount root, and
    // nothing else.
    expect(detectOutlineComponent(a)?.name).toBe("Button")
    expect(detectOutlineComponent(introSection)?.name).toBe("Overview")
    expect(detectOutlineComponent(appShellDiv)?.name).toBe("App")
    // An inner <span> inside the <a> (Button's own child content) is not a
    // mount root of anything.
    expect(detectOutlineComponent(span)).toBeNull()
    // The <div class="actions"> Overview renders around Button is plain
    // markup in Overview's template, not Overview's own mount root (that's
    // the earlier <section class="intro">) — so it is unlabeled too.
    expect(detectOutlineComponent(actionsDiv)).toBeNull()
  })

  it("case 2: class component root", () => {
    class LegacyPanel extends React.Component<{ label: string }, Record<string, never>> {
      render() {
        return <div className="legacy-root">{this.props.label}</div>
      }
    }

    const container = mount(<LegacyPanel label="hello" />)
    const div = container.querySelector(".legacy-root")!

    const tree = buildReactComponentTree(div)
    expect(tree.map((n) => n.name)).toEqual(["LegacyPanel"])
    expect(tree[0].elementSelector).toBe(generateSelector(div))
    expect(detectReactOutlineComponent(div)?.name).toBe("LegacyPanel")
  })

  it("case 3: React.memo and React.forwardRef roots resolve a real name, and a memo of an arrow with displayName resolves the displayName", () => {
    const MemoCard = React.memo(function MemoCardImpl({ label }: { label: string }) {
      return <div className="memo-card-root">{label}</div>
    })
    const container1 = mount(<MemoCard label="hi" />)
    const memoDiv = container1.querySelector(".memo-card-root")!
    expect(detectReactOutlineComponent(memoDiv)?.name).toBe("MemoCardImpl")
    expect(detectReactOutlineComponent(memoDiv)?.name).not.toBe("Anonymous")
    // MEASURED: `React.memo(fn)` with no comparator compiles to a
    // SimpleMemoComponent (tag 15) whose `fiber.type` is already the inner
    // function, so this shape never needed unwrapping. A MemoComponent
    // (tag 14, memo with a comparator) keeps the wrapper object and is
    // covered by the fabricated-fiber suite.
    expect(buildReactComponentTree(memoDiv).map((n) => n.name)).toEqual(["MemoCardImpl"])

    const ForwardField = React.forwardRef<HTMLInputElement, Record<string, never>>(function ForwardFieldImpl(_props, ref) {
      return <input ref={ref} className="forward-field-root" />
    })
    const container2 = mount(<ForwardField />)
    const inputEl = container2.querySelector(".forward-field-root")!
    // A ForwardRef fiber (tag 11) keeps `fiber.type` as the
    // `{$$typeof, render}` wrapper object; `reactComponentName` reads the
    // name through `.render`.
    expect(detectReactOutlineComponent(inputEl)?.name).toBe("ForwardFieldImpl")
    expect(getReactComponentMountRoot(getReactFiberOf(inputEl)!.return as Record<string, unknown>)).toBe(inputEl)

    // A component the outline names must also be in the tree with the same
    // name and its mount root's selector. This FAILED when first written
    // (2026-09-02): buildReactComponentTree admitted a fiber only when
    // `typeof fiber.type === "function"`, and a ForwardRef's type is the
    // wrapper object, so the whole node was dropped: `[]`. Fibers are now
    // admitted by tag, and the name comes from the shared helper.
    const forwardRefTree = buildReactComponentTree(inputEl)
    expect(forwardRefTree.map((n) => n.name)).toEqual(["ForwardFieldImpl"])
    expect(forwardRefTree[0]?.elementSelector).toBe(generateSelector(inputEl))

    const NamedArrow = (() => <div className="named-arrow-root" />) as React.FC & { displayName?: string }
    NamedArrow.displayName = "NamedArrow"
    const MemoNamedArrow = React.memo(NamedArrow)
    const container3 = mount(<MemoNamedArrow />)
    const arrowDiv = container3.querySelector(".named-arrow-root")!
    expect(detectReactOutlineComponent(arrowDiv)?.name).toBe("NamedArrow")
  })

  it("case 4: Fragment root with two host children — mount root is the FIRST host in render order, the second is not labeled", () => {
    function TwoHosts() {
      return (
        <>
          <span className="first-host">a</span>
          <em className="second-host">b</em>
        </>
      )
    }
    function Owner() {
      return (
        <div className="owner-of-two-hosts">
          <TwoHosts />
        </div>
      )
    }

    const container = mount(<Owner />)
    const first = container.querySelector(".first-host")!
    const second = container.querySelector(".second-host")!

    const twoHostsFiber = getReactFiberOf(first)!.return as Record<string, unknown>
    expect(getReactComponentMountRoot(twoHostsFiber)).toBe(first)
    expect(getReactComponentMountRoot(twoHostsFiber)).not.toBe(second)

    expect(detectReactOutlineComponent(first)?.name).toBe("TwoHosts")
    expect(detectReactOutlineComponent(second)).toBeNull()
  })

  it("case 5: transparent wrapper chain — Card renders Panel renders div; the div is labeled the OUTERMOST (Card), and the tree carries both with the same elementSelector", () => {
    function Panel({ children }: { children: React.ReactNode }) {
      return <div className="panel-root">{children}</div>
    }
    function Card({ children }: { children: React.ReactNode }) {
      return <Panel>{children}</Panel>
    }
    function Owner() {
      return (
        <div className="owner-of-card">
          <Card>content</Card>
        </div>
      )
    }

    const container = mount(<Owner />)
    const div = container.querySelector(".panel-root")!

    expect(detectReactOutlineComponent(div)?.name).toBe("Card")

    const tree = buildReactComponentTree(div)
    expect(tree.map((n) => n.name)).toEqual(["Owner", "Card", "Panel"])
    expect(tree[1].elementSelector).toBe(generateSelector(div))
    expect(tree[2].elementSelector).toBe(generateSelector(div))
    expect(tree[1].elementSelector).toBe(tree[2].elementSelector)
  })

  it("case 6: parent whose first host is a sibling — Page renders <span/><Child/>, Child renders <a>: the <a> is labeled Child, the span is labeled Page", () => {
    function Child() {
      return <a className="child-a">link</a>
    }
    function Page() {
      return (
        <>
          <span className="page-span">s</span>
          <Child />
        </>
      )
    }
    function Owner() {
      return (
        <div className="owner-of-page">
          <Page />
        </div>
      )
    }

    const container = mount(<Owner />)
    const span = container.querySelector(".page-span")!
    const a = container.querySelector(".child-a")!

    expect(detectReactOutlineComponent(span)?.name).toBe("Page")
    expect(detectReactOutlineComponent(a)?.name).toBe("Child")
  })

  it("case 7: a portal — getReactComponentMountRoot follows the FIBER tree through the HostPortal, returning a host element that is NOT in the component's DOM position", () => {
    function Modal() {
      return createPortal(<div className="portal-root">portal content</div>, document.body)
    }
    function Owner() {
      return (
        <div className="portal-owner">
          <Modal />
        </div>
      )
    }

    const container = mount(<Owner />)
    const ownerDiv = container.querySelector(".portal-owner")!
    const portalDiv = document.body.querySelector(".portal-root")!

    // Find Modal's own component fiber by walking up from the portal div's
    // host fiber (real code has no direct "get me Modal's fiber" API — the
    // task instructs constructing it this way for a component fiber).
    let cur: Record<string, unknown> | null = getReactFiberOf(portalDiv)!
    let modalFiber: Record<string, unknown> | null = null
    while (cur) {
      const type = cur.type as { name?: string } | undefined
      if (typeof cur.tag === "number" && cur.tag === 0 && type?.name === "Modal") {
        modalFiber = cur
        break
      }
      cur = (cur.return as Record<string, unknown> | null) ?? null
    }
    expect(modalFiber).not.toBeNull()

    // ACTUAL BEHAVIOR (measured): the returned "mount root" is the portal's
    // div — a real Element, attached to the live DOM — but it is a child of
    // `document.body`, NOT a descendant of `ownerDiv` (Modal's structural
    // position in the render tree). `getReactComponentMountRoot` walks
    // `fiber.child`/`fiber.sibling`, and a HostPortal fiber (tag 4) stays a
    // child in the FIBER tree even though React re-parents its content
    // elsewhere in the DOM tree at commit time — so the walk finds it same
    // as any other host descendant.
    const root = getReactComponentMountRoot(modalFiber!)
    expect(root).toBe(portalDiv)
    expect(ownerDiv.contains(root)).toBe(false)
    expect(document.body.contains(root!)).toBe(true)

    // Whether this is a "defect" depends on what a caller wants: as a
    // literal reading of the doc comment ("First HostComponent in fiber's
    // subtree — the DOM element the component mounts as"), this is
    // CORRECT — Modal's real rendered output genuinely is the portal div.
    // It is a defect only for a caller that assumes a mount root is always
    // positioned inside the component's DOM ancestry (e.g. an outline/
    // highlight overlay computing a bounding box relative to nearby
    // content) — see the report.
  })

  it("case 8: a Context.Provider and Suspense boundary between the component and its host — mount root still resolves through them, labeled as the component", () => {
    const Ctx = React.createContext<null>(null)
    function Wrapper() {
      return (
        <Ctx.Provider value={null}>
          <React.Suspense fallback={null}>
            <div className="wrapped-div">hi</div>
          </React.Suspense>
        </Ctx.Provider>
      )
    }
    function Owner() {
      return (
        <div className="owner-of-wrapper">
          <Wrapper />
        </div>
      )
    }

    const container = mount(<Owner />)
    const div = container.querySelector(".wrapped-div")!

    expect(detectReactOutlineComponent(div)?.name).toBe("Wrapper")
  })

  it("case 9: a text-only component (returns a bare string, no host element) has a null mount root, and does not affect its host parent's own outline resolution", () => {
    function TextLabel() {
      return "hi" as unknown as React.ReactElement
    }
    function TextParent() {
      return (
        <div className="text-parent-root">
          <TextLabel />
        </div>
      )
    }

    const container = mount(<TextParent />)
    const div = container.querySelector(".text-parent-root")!

    // TextParent's own mount root is the div itself — unaffected by the
    // fact that ITS child (TextLabel) renders nothing but text.
    expect(detectReactOutlineComponent(div)?.name).toBe("TextParent")

    // Find TextLabel's own fiber (a descendant of the div's fiber) and
    // confirm its mount root is null: its subtree contains only a
    // HostText fiber (tag 6), never a HostComponent (tag 5).
    let cur: Record<string, unknown> | null = getReactFiberOf(div)
    let labelFiber: Record<string, unknown> | null = null
    while (cur) {
      const type = cur.type as { name?: string } | undefined
      if (typeof cur.tag === "number" && cur.tag === 0 && type?.name === "TextLabel") {
        labelFiber = cur
        break
      }
      cur = (cur.child as Record<string, unknown> | null) ?? null
    }
    expect(labelFiber).not.toBeNull()
    expect(getReactComponentMountRoot(labelFiber!)).toBeNull()
  })
})
