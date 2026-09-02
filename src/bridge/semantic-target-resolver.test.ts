import { afterEach, describe, expect, it } from "vitest"
import { accessibleName, performInteract, resolveSemanticTarget } from "./semantic-target-resolver"

afterEach(() => {
  document.body.innerHTML = ""
})

describe("accessibleName", () => {
  it("prefers aria-label over everything", () => {
    document.body.innerHTML = `<button aria-label="Close dialog" title="x">×</button>`
    expect(accessibleName(document.querySelector("button")!)).toBe("Close dialog")
  })

  it("resolves aria-labelledby to the referenced element's text", () => {
    document.body.innerHTML = `<span id="lbl">Email address</span><input aria-labelledby="lbl" />`
    expect(accessibleName(document.querySelector("input")!)).toBe("Email address")
  })

  it("uses an explicit <label for=id> association", () => {
    document.body.innerHTML = `<label for="n">Full name</label><input id="n" />`
    expect(accessibleName(document.querySelector("input")!)).toBe("Full name")
  })

  // The codex P2: `<label>Name <input/></label>` (no id/for) was missed.
  it("uses a WRAPPING <label> when there is no id/for pair", () => {
    document.body.innerHTML = `<label>Name <input type="text" /></label>`
    expect(accessibleName(document.querySelector("input")!)).toBe("Name")
  })

  it("uses a wrapping <label> for <select> and <textarea> too", () => {
    document.body.innerHTML = `
      <label>Region <select><option value="x">X</option></select></label>
      <label>Bio <textarea></textarea></label>`
    expect(accessibleName(document.querySelector("select")!)).toBe("Region")
    expect(accessibleName(document.querySelector("textarea")!)).toBe("Bio")
  })

  it("does NOT climb to a wrapping <label> for non-labelable elements", () => {
    // A <span> inside a label must not steal the label's caption as its name.
    document.body.innerHTML = `<label>Caption <span id="s">inner</span></label>`
    expect(accessibleName(document.querySelector("#s")!)).toBe("inner")
  })

  it("uses the value attr as the name for native input buttons", () => {
    document.body.innerHTML = `
      <input id="s" type="submit" value="Save" />
      <input id="b" type="button" value="Create model" />`
    expect(accessibleName(document.querySelector("#s")!)).toBe("Save")
    expect(accessibleName(document.querySelector("#b")!)).toBe("Create model")
  })

  it("falls back to placeholder, then text content", () => {
    document.body.innerHTML = `<input placeholder="Search…" />`
    expect(accessibleName(document.querySelector("input")!)).toBe("Search…")
    document.body.innerHTML = `<button>Save changes</button>`
    expect(accessibleName(document.querySelector("button")!)).toBe("Save changes")
  })
})

describe("performInteract — <select>", () => {
  function setupSelect(): HTMLSelectElement {
    document.body.innerHTML = `
      <select id="region">
        <option value="us-east-1">US East</option>
        <option value="eu-west-1">EU West</option>
      </select>`
    return document.querySelector("#region")!
  }

  it("matches an option by its value", () => {
    const sel = setupSelect()
    let changed = false
    sel.addEventListener("change", () => (changed = true))
    const r = performInteract({ selector: "#region", action: "select", value: "eu-west-1" })
    expect(r.ok).toBe(true)
    expect(sel.value).toBe("eu-west-1")
    expect(changed).toBe(true)
  })

  // The codex P2: selecting by VISIBLE LABEL must work and must set the value.
  it("matches an option by its visible label and sets the underlying value", () => {
    const sel = setupSelect()
    const r = performInteract({ selector: "#region", action: "select", value: "US East" })
    expect(r.ok).toBe(true)
    expect(sel.value).toBe("us-east-1")
  })

  it("matches the visible label case-insensitively", () => {
    const sel = setupSelect()
    const r = performInteract({ selector: "#region", action: "select", value: "eu west" })
    expect(r.ok).toBe(true)
    expect(sel.value).toBe("eu-west-1")
  })

  // The core of the P2: never report success when nothing matched.
  it("FAILS (does not silently succeed) when no option matches", () => {
    const sel = setupSelect()
    const before = sel.value
    const r = performInteract({ selector: "#region", action: "select", value: "Mars" })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/no <option> matches/)
    // The select is left untouched — replay must not capture a wrong state.
    expect(sel.value).toBe(before)
  })
})

describe("performInteract — fill / click", () => {
  it("fills a text input and dispatches input+change", () => {
    document.body.innerHTML = `<input id="name" type="text" />`
    const el = document.querySelector<HTMLInputElement>("#name")!
    const events: string[] = []
    el.addEventListener("input", () => events.push("input"))
    el.addEventListener("change", () => events.push("change"))
    const r = performInteract({ selector: "#name", action: "fill", value: "Ada" })
    expect(r.ok).toBe(true)
    expect(el.value).toBe("Ada")
    expect(events).toEqual(["input", "change"])
  })

  it("toggles a checkbox via value='true'", () => {
    document.body.innerHTML = `<input id="agree" type="checkbox" />`
    const el = document.querySelector<HTMLInputElement>("#agree")!
    const r = performInteract({ selector: "#agree", action: "fill", value: "true" })
    expect(r.ok).toBe(true)
    expect(el.checked).toBe(true)
  })

  it("fills via the native value setter (React-controlled compat)", () => {
    document.body.innerHTML = `<input id="n" type="text" />`
    const el = document.querySelector<HTMLInputElement>("#n")!
    const proto = Object.getPrototypeOf(el)
    const desc = Object.getOwnPropertyDescriptor(proto, "value")!
    let nativeSetterCalls = 0
    Object.defineProperty(proto, "value", {
      ...desc,
      set(v: string) {
        nativeSetterCalls++
        desc.set!.call(this, v)
      },
    })
    try {
      const r = performInteract({ selector: "#n", action: "fill", value: "Ada" })
      expect(r.ok).toBe(true)
      expect(el.value).toBe("Ada")
      // Proves we went through the native prototype setter, not a direct
      // instance assignment React's value-tracker would swallow.
      expect(nativeSetterCalls).toBeGreaterThan(0)
    } finally {
      Object.defineProperty(proto, "value", desc)
    }
  })

  it("rejects 'select' on a custom (non-native) combobox instead of faking success", () => {
    document.body.innerHTML = `<div id="cb" role="combobox">US East</div>`
    const r = performInteract({ selector: "#cb", action: "select", value: "EU West" })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/native <select>/)
  })

  it("rejects 'fill' on a non-input element instead of a silent no-op", () => {
    document.body.innerHTML = `<div id="d">x</div>`
    const r = performInteract({ selector: "#d", action: "fill", value: "hi" })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/<input>\/<textarea>/)
  })

  it("returns a miss for an unresolvable selector", () => {
    const r = performInteract({ selector: "#ghost", action: "click" })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/not found/)
  })

  it("refuses to act on tool-owned elements", () => {
    document.body.innerHTML = `<div data-prototype-flow><button id="t">x</button></div>`
    const r = performInteract({ selector: "#t", action: "click" })
    expect(r.ok).toBe(false)
  })
})

/**
 * Ambiguity must lose.
 *
 * The resolver used to take the FIRST exact accessible-name match and break,
 * so a page with two "Save" buttons resolved to whichever came first in DOM
 * order and reported `found: true`. Replay then clicked an element the plan
 * never named — confidently, with no signal that a choice had been made.
 *
 * This is the standing rule elsewhere in the codebase: ambiguous selectors
 * refuse the edit rather than risk the wrong target, and a semantic-target
 * miss stops a replay run with `needsHeal`. An arbitrary pick is the one
 * outcome that is silently wrong rather than loudly unresolved.
 * Found by codex bridge audit 2026-08-09.
 */
describe("resolveSemanticTarget — ambiguity", () => {
  /**
   * jsdom fails the resolver's `isVisible` gate twice over, for reasons that
   * have nothing to do with what is under test:
   *   1. No layout, so every `getBoundingClientRect()` is 0x0.
   *   2. Computed `opacity` is the empty string, and `Number("") === 0`, so
   *      the opacity check reads every element as fully transparent. (Real
   *      browsers always resolve it to "1" — a jsdom artifact, not a bug.)
   * Neutralise both so visibility stops being the variable.
   */
  function mount(markup: string): void {
    document.body.innerHTML = markup
    for (const el of Array.from(document.body.querySelectorAll("*"))) {
      const h = el as HTMLElement
      h.style.opacity = "1"
      h.getBoundingClientRect = () =>
        ({ width: 80, height: 20, top: 0, left: 0, right: 80, bottom: 20, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
    }
  }

  afterEach(() => {
    document.body.innerHTML = ""
  })

  it("refuses when two elements share the same role and accessible name", () => {
    mount(`<button>Save</button><button>Save</button>`)
    const res = resolveSemanticTarget({ role: "button", name: "Save" })
    expect(res.found).toBe(false)
    expect(res.reason).toBe("ambiguous")
  })

  it("resolves happily when the name is unique", () => {
    // Control: proves the refusal above is about ambiguity, not about the
    // resolver being broken.
    mount(`<button>Save</button><button>Cancel</button>`)
    const res = resolveSemanticTarget({ role: "button", name: "Save" })
    expect(res.found).toBe(true)
  })

  it("lets one EXACT match win over several partials", () => {
    // "Save" is unique exactly; "Save draft"/"Save and close" only contain it.
    // That is not ambiguous and must still resolve.
    mount(`<button>Save draft</button><button>Save</button><button>Save and close</button>`)
    const res = resolveSemanticTarget({ role: "button", name: "Save" })
    expect(res.found).toBe(true)
    expect(res.name?.toLowerCase()).toBe("save")
  })

  it("refuses when only PARTIAL matches exist and there are several", () => {
    mount(`<button>Save draft</button><button>Save and close</button>`)
    const res = resolveSemanticTarget({ role: "button", name: "Save" })
    expect(res.found).toBe(false)
    expect(res.reason).toBe("ambiguous")
  })

  it("refuses a role-only target when several elements share that role", () => {
    mount(`<button>One</button><button>Two</button>`)
    const res = resolveSemanticTarget({ role: "button" })
    expect(res.found).toBe(false)
    expect(res.reason).toBe("ambiguous")
  })

  it("reports not-found (not ambiguous) when nothing matches at all", () => {
    mount(`<button>Cancel</button>`)
    const res = resolveSemanticTarget({ role: "button", name: "Save" })
    expect(res.found).toBe(false)
    expect(res.reason).toBe("not-found")
  })
})
