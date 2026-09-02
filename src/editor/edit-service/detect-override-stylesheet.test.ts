/**
 * Boot-time facts feeding rungs 1 and 2 of the override-destination ladder
 * (`tasks/dev-server-hosts.md` § 9g.1).
 *
 * Neither answer is authoritative on its own — the shell checks both against
 * the page's LOADED stylesheets before using either, because a file on disk is
 * not a file the app imports. What these tests pin is that the facts are
 * correct and bounded, and that a bad config costs a rung rather than a boot.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  detectOverrideStylesheetFacts,
  findStickyOverrideStylesheet,
  normalizeConfiguredOverrideStylesheet,
  readConfiguredOverrideStylesheet,
} from "./detect-override-stylesheet"

const BLOCK = "/* @editor-scoped-overrides start */"
const roots: string[] = []

function makeRoot(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "pt-override-"))
  roots.push(root)
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel)
    mkdirSync(join(abs, ".."), { recursive: true })
    writeFileSync(abs, body, "utf8")
  }
  return root
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
})

describe("findStickyOverrideStylesheet", () => {
  it("finds the file that already holds the managed block", () => {
    const root = makeRoot({
      "src/index.css": ":root { --a: 1 }\n",
      "src/theme.css": `.x{}\n${BLOCK}\n[data-desde-src="src/App.tsx:1:1"] { color: red }\n/* @editor-scoped-overrides end */\n`,
    })
    expect(findStickyOverrideStylesheet({ appRoot: root })).toBe("src/theme.css")
  })

  it("is undefined when nothing holds it", () => {
    const root = makeRoot({ "src/index.css": ":root { --a: 1 }\n" })
    expect(findStickyOverrideStylesheet({ appRoot: root })).toBeUndefined()
  })

  it("reports paths relative to the PROTOTYPE root, not the app it walked", () => {
    // A monorepo subdir prototype: `data-desde-src` and the edit handler are
    // anchored at the repo root, so the sticky answer must be too — otherwise
    // it can never match a candidate and the rung is silently dead.
    const root = makeRoot({
      "apps/web/src/app.css": `${BLOCK}\n/* @editor-scoped-overrides end */\n`,
    })
    expect(
      findStickyOverrideStylesheet({
        appRoot: join(root, "apps/web"),
        prototypeRoot: root,
      }),
    ).toBe("apps/web/src/app.css")
  })

  it("does not walk into node_modules", () => {
    const root = makeRoot({
      "node_modules/@acme/ui/dist/x.css": `${BLOCK}\n/* @editor-scoped-overrides end */\n`,
      "src/app.css": ".x{}\n",
    })
    expect(findStickyOverrideStylesheet({ appRoot: root })).toBeUndefined()
  })
})

describe("normalizeConfiguredOverrideStylesheet", () => {
  it("accepts a root-relative .css path", () => {
    expect(normalizeConfiguredOverrideStylesheet("src/overrides.css")).toBe(
      "src/overrides.css",
    )
    expect(normalizeConfiguredOverrideStylesheet("./src/overrides.css")).toBe(
      "src/overrides.css",
    )
  })

  it("drops anything that could escape the prototype or is not a stylesheet", () => {
    for (const bad of [
      "/etc/passwd.css",
      "../outside.css",
      "node_modules/@acme/ui/x.css",
      "src/App.vue",
      "",
      42,
      null,
    ]) {
      expect(normalizeConfiguredOverrideStylesheet(bad)).toBeUndefined()
    }
  })
})

describe("readConfiguredOverrideStylesheet", () => {
  it("reads styling.overrideStylesheet out of the project config", () => {
    const root = makeRoot({
      "desde.config.json": JSON.stringify({
        styling: { overrideStylesheet: "src/overrides.css" },
      }),
    })
    expect(readConfiguredOverrideStylesheet(root)).toBe("src/overrides.css")
  })

  it("returns undefined for a missing or malformed config rather than throwing", () => {
    const empty = makeRoot({})
    expect(readConfiguredOverrideStylesheet(empty)).toBeUndefined()
    const broken = makeRoot({ "desde.config.json": "{ not json" })
    expect(readConfiguredOverrideStylesheet(broken)).toBeUndefined()
  })
})

describe("detectOverrideStylesheetFacts", () => {
  it("reports both facts independently — either can be absent", () => {
    const root = makeRoot({
      "desde.config.json": JSON.stringify({
        styling: { overrideStylesheet: "src/overrides.css" },
      }),
      "src/theme.css": `${BLOCK}\n/* @editor-scoped-overrides end */\n`,
    })
    expect(detectOverrideStylesheetFacts({ appRoot: root })).toEqual({
      configured: "src/overrides.css",
      sticky: "src/theme.css",
    })
    const bare = makeRoot({ "src/index.css": ".x{}\n" })
    expect(detectOverrideStylesheetFacts({ appRoot: bare })).toEqual({})
  })
})
