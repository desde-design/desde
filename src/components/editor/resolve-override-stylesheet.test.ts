/**
 * The destination ladder for a `scoped-css-override` on a substrate with no
 * `<style scoped>` block. See `tasks/dev-server-hosts.md` § 9g.1.
 *
 * The property every case here is really testing is REACHABILITY: the only
 * files offered are ones the document has loaded, because a rule written into
 * an unimported `.css` is inert while the write, the parse and the HTTP
 * response all report success. That is the same silent shape the Vue lane
 * shipped (§ 9g.8), arriving by a different route.
 */
import { describe, expect, it } from "vitest"
import {
  isOverrideStylesheetRefusal,
  OVERRIDE_STYLESHEET_SUGGESTION,
  resolveOverrideStylesheet,
} from "./resolve-override-stylesheet"

const ROOT = "/repo"

/** A Vite dev `<style>` for a first-party file — the common case. */
function injected(file: string) {
  return { href: "<style>", sourceHint: `${ROOT}/${file}` }
}

/** A `<link>`ed stylesheet served at its root-relative path. */
function linked(file: string) {
  return { href: `http://localhost:5173/${file}` }
}

const OPTS = { repoRoot: ROOT }

describe("resolveOverrideStylesheet", () => {
  it("refuses, with a bootstrap suggestion, when no first-party stylesheet is loaded", () => {
    // The normal state of a CSS-Modules-only or styled-components-only app.
    const r = resolveOverrideStylesheet(
      [{ href: "http://x/node_modules/@mui/material/style.css", package: "@mui/material" }],
      OPTS,
    )
    expect(isOverrideStylesheetRefusal(r)).toBe(true)
    if (!isOverrideStylesheetRefusal(r)) return
    expect(r.suggestion).toBe(OVERRIDE_STYLESHEET_SUGGESTION)
    expect(r.candidates).toEqual([])
  })

  it("takes the LAST first-party sheet in document order when nothing else decides", () => {
    // Cascade-derived, not filename-derived: later source order breaks ties at
    // equal importance and specificity.
    const r = resolveOverrideStylesheet(
      [injected("src/index.css"), injected("src/theme.css"), injected("src/app.css")],
      OPTS,
    )
    expect(isOverrideStylesheetRefusal(r)).toBe(false)
    if (isOverrideStylesheetRefusal(r)) return
    expect(r.file).toBe("src/app.css")
    expect(r.rung).toBe("runtime-last")
    expect(r.candidates).toEqual(["src/index.css", "src/theme.css", "src/app.css"])
  })

  it("prefers the configured destination when the page loads it", () => {
    const r = resolveOverrideStylesheet(
      [injected("src/index.css"), injected("src/app.css")],
      { ...OPTS, configured: "src/index.css" },
    )
    expect(isOverrideStylesheetRefusal(r)).toBe(false)
    if (isOverrideStylesheetRefusal(r)) return
    expect(r.file).toBe("src/index.css")
    expect(r.rung).toBe("configured")
  })

  it("ignores a configured destination the page does NOT load", () => {
    // Silently obeying it would turn a typo into a lane that writes rules
    // nothing can ever render — the exact failure the ladder exists to avoid.
    const r = resolveOverrideStylesheet([injected("src/app.css")], {
      ...OPTS,
      configured: "src/nowhere.css",
    })
    expect(isOverrideStylesheetRefusal(r)).toBe(false)
    if (isOverrideStylesheetRefusal(r)) return
    expect(r.file).toBe("src/app.css")
    expect(r.rung).toBe("runtime-last")
  })

  it("sticks to the file that already holds the managed block, over document order", () => {
    // The rung that makes the choice made-once-and-read-back, so a change in
    // import order cannot scatter a project's overrides across three files.
    const r = resolveOverrideStylesheet(
      [injected("src/index.css"), injected("src/app.css")],
      { ...OPTS, sticky: "src/index.css" },
    )
    expect(isOverrideStylesheetRefusal(r)).toBe(false)
    if (isOverrideStylesheetRefusal(r)) return
    expect(r.file).toBe("src/index.css")
    expect(r.rung).toBe("sticky")
  })

  it("configured outranks sticky", () => {
    const r = resolveOverrideStylesheet(
      [injected("src/index.css"), injected("src/app.css")],
      { ...OPTS, configured: "src/app.css", sticky: "src/index.css" },
    )
    expect(isOverrideStylesheetRefusal(r)).toBe(false)
    if (isOverrideStylesheetRefusal(r)) return
    expect(r.rung).toBe("configured")
  })

  it("never offers a library stylesheet, however it is served", () => {
    const r = resolveOverrideStylesheet(
      [
        linked("node_modules/@mui/material/dist/style.css"),
        { href: "<style>", sourceHint: `${ROOT}/node_modules/react-bootstrap/dist/x.css` },
        injected("src/app.css"),
      ],
      OPTS,
    )
    expect(isOverrideStylesheetRefusal(r)).toBe(false)
    if (isOverrideStylesheetRefusal(r)) return
    expect(r.candidates).toEqual(["src/app.css"])
  })

  it("de-duplicates one file served as several sheets", () => {
    const r = resolveOverrideStylesheet(
      [injected("src/app.css"), linked("src/app.css"), injected("src/late.css")],
      OPTS,
    )
    expect(isOverrideStylesheetRefusal(r)).toBe(false)
    if (isOverrideStylesheetRefusal(r)) return
    expect(r.candidates).toEqual(["src/app.css", "src/late.css"])
  })

  it("refuses an SFC style block, which is not a writable .css", () => {
    const r = resolveOverrideStylesheet(
      [{ href: "<style>", sourceHint: `${ROOT}/src/App.vue?vue&type=style&index=0&lang.css` }],
      OPTS,
    )
    expect(isOverrideStylesheetRefusal(r)).toBe(true)
  })
})
