/**
 * React live click→edit→HMR loop smoke test.
 *
 * Ported 2026-09-01 (F-19, pre-release stress test) from
 * `tasks/scripts/react-live-loop.mts`, which crashed on every run:
 *
 *   editor-cli/src/server/enabled-lanes.ts:3
 *   import { CONFIG_FILENAME } from "../../../src/editor/core/read-roots.js"
 *   SyntaxError: The requested module '../../../src/editor/core/read-roots.js'
 *   does not provide an export named 'CONFIG_FILENAME'
 *
 * `enabled-lanes.ts` grew a static named import of a root `src/` module
 * sometime after the harness last ran clean, and that import sits on the
 * `edit-handler.ts` import chain the old harness dynamic-imports. CLAUDE.md's
 * rule applies exactly: "A harness cannot import editor-cli server modules
 * under plain `tsx`. The repo root's `package.json` has no `"type"`, so root
 * `src/**` loads as CommonJS, while `editor-cli` is `"type": "module"` — a
 * root `.mts` importing `editor-cli/src/server/**` pulls `src/core/**` in
 * through CJS interop and gets `['default', 'module.exports']`." Vitest
 * transforms both sides to ESM, so the same import works from inside
 * editor-cli's own suite — see `viewer-resolve.live.test.ts` for the same
 * fix applied to a different harness.
 *
 * This file validates the FULL React edit pipeline end-to-end against a
 * throwaway Vite + React 19 app, without booting the CLI process:
 *
 *   1. Boot Vite with the REAL plugin chain editor-cli uses for React —
 *      jsxSourceTagPlugin (pre) → @vitejs/plugin-react → bridgePlugin (post).
 *   2. Frame the app and drive the injected bridge (Playwright) to resolve a
 *      clicked element to its `.tsx` source (`editTarget`) — click-to-source.
 *   3. Apply edits through the REAL edit-handler `applyEdit` (the production
 *      CLI dispatcher: gate → framework dispatch → JSX applicator → fs write)
 *      — prop, insert, delete, and jsx-style (classname merge).
 *   4. Confirm each edit lands on disk AND the live DOM reflects it after
 *      Vite HMR — proving the loop closes on React 19.
 *
 * Why not boot the CLI process directly: same class of import problem as
 * above can reach the chat/save/commit handlers (see
 * tasks/editor-react-support.md § item 5). This suite drives the same
 * plugins + the same `applyEdit` through Vite's JS API, so the React
 * capability is validated regardless of that blocker.
 *
 * Lives in `src/__smoke__/` (excluded from `npm test`, run via
 * `npm run test:smoke`) alongside `merge-overlap-smoke.test.ts`, which
 * launches a real Chrome the same way — see that file for the convention.
 *
 * Node-25 + Playwright discipline carried over from the original harness:
 * `page.evaluate`/`frame.evaluate` bodies are STRINGS, not inline arrow
 * functions — function serialization across the CDP boundary is inconsistent
 * under the esbuild transform this repo's tooling uses on Node 25.
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createServer, type Plugin, type ViteDevServer } from "vite"
import react from "@vitejs/plugin-react"
import { chromium, type Browser, type Frame, type Page } from "playwright"

import { jsxSourceTagPlugin } from "../plugins/jsx-source-tag-plugin.js"
import { bridgePlugin } from "../plugins/bridge-plugin.js"
import { applyEdit, defaultApplicatorLoaders } from "../server/edit-handler.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..")
const FIXTURE = path.join(REPO_ROOT, "tasks/scripts/react-fixtures/scratch-react-app")
const BRIDGE = path.join(REPO_ROOT, "dist/bridge-bundle.js")
// System Chrome (Playwright's bundled chromium may not be installed); fall
// back to the bundled browser when the system path is absent, same as
// merge-overlap-smoke.test.ts.
const SYSTEM_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
// Distinct from merge-overlap-smoke.test.ts's ports (4324/5176); harmless
// even though vitest.smoke.config.ts already serializes files with
// fileParallelism: false.
const PORT = 5470

// Scratch app lives under the repo's gitignored `.desde/` so Vite resolves
// react/react-dom from the repo root's node_modules (the fixture ships no
// node_modules of its own), and edits never dirty the committed fixture.
const SCRATCH_PARENT = path.join(REPO_ROOT, ".desde")

// Same-origin parent wrapper so the app can be framed with a real origin (an
// opaque about:blank parent denies the framed iframe's sessionStorage, which
// the bridge touches on init).
const parentPagePlugin: Plugin = {
  name: "react-live-loop-smoke-parent",
  configureServer(server: ViteDevServer) {
    server.middlewares.use((req, res, next) => {
      if ((req.url ?? "").split("?")[0] === "/__parent.html") {
        res.setHeader("Content-Type", "text/html; charset=utf-8")
        res.end(
          `<!doctype html><html><body><iframe id="proto" src="/" style="width:1200px;height:900px;border:0"></iframe></body></html>`,
        )
        return
      }
      next()
    })
  },
}

/** INSPECT_SELECTOR round-trip: parent → iframe → ELEMENT_INSPECTED reply. */
const INSPECT = (selector: string) => `(async () => {
  const iframe = document.getElementById('proto')
  return await new Promise((resolve) => {
    const reqId = 'rlls-' + Math.floor(performance.now()) + '-' + ${JSON.stringify(selector)}
    function onMsg(e) {
      const d = e.data
      if (!d || typeof d !== 'object' || d.requestId !== reqId) return
      if (d.type === 'ELEMENT_INSPECTED' || d.type === 'ELEMENT_INSPECTION_UNRESOLVED') {
        window.removeEventListener('message', onMsg)
        resolve({ type: d.type, payload: d.payload })
      }
    }
    window.addEventListener('message', onMsg)
    iframe.contentWindow.postMessage({ type: 'INSPECT_SELECTOR', payload: { selector: ${JSON.stringify(selector)} }, requestId: reqId }, '*')
    setTimeout(() => { window.removeEventListener('message', onMsg); resolve({ type: 'TIMEOUT' }) }, 5000)
  })
})()`

type SourceLoc = { file: string; line: number; column: number }
type Inspected = {
  type: string
  payload?: {
    editTarget?: SourceLoc
    authoredAt?: SourceLoc
  }
}

async function inspect(page: Page, selector: string): Promise<Inspected> {
  return (await page.evaluate(INSPECT(selector))) as Inspected
}

function resolvedLoc(inspected: Inspected): SourceLoc | undefined {
  return inspected.payload?.editTarget ?? inspected.payload?.authoredAt
}

let server: ViteDevServer | null = null
let browser: Browser | null = null
let page: Page | null = null
let frame: Frame | null = null
let scratchApp = ""
const pageErrors: string[] = []

beforeAll(async () => {
  if (!existsSync(FIXTURE)) {
    throw new Error(`React scratch-app fixture missing at ${FIXTURE}`)
  }
  if (!existsSync(BRIDGE)) {
    throw new Error(`Bridge bundle missing at ${BRIDGE} — run \`npm run build:bridge\` first`)
  }

  mkdirSync(SCRATCH_PARENT, { recursive: true })
  scratchApp = mkdtempSync(path.join(SCRATCH_PARENT, "react-live-loop-smoke-"))
  cpSync(FIXTURE, scratchApp, { recursive: true })

  server = await createServer({
    configFile: false,
    root: scratchApp,
    logLevel: "warn",
    // strictPort: fail loudly if PORT is taken rather than silently binding
    // the next free port and navigating to the wrong (unrelated) server.
    server: { port: PORT, strictPort: true },
    plugins: [
      jsxSourceTagPlugin({ repoRoot: scratchApp }),
      react(),
      bridgePlugin({ bridgeBundlePath: BRIDGE, shellOrigin: "http://localhost:9999" }),
      parentPagePlugin,
    ],
  })
  await server.listen()
  const baseUrl = server.resolvedUrls?.local?.[0]?.replace(/\/$/, "") ?? `http://localhost:${PORT}`

  if (!existsSync(SYSTEM_CHROME)) {
    throw new Error(
      `React live loop smoke requires Chrome at ${SYSTEM_CHROME}. Install Chrome or run \`npx playwright install chromium\` and adapt the launcher.`,
    )
  }
  browser = await chromium.launch({ executablePath: SYSTEM_CHROME })
  page = await browser.newPage()
  page.on("pageerror", (e) => pageErrors.push(String(e)))

  await page.goto(`${baseUrl}/__parent.html`, { waitUntil: "networkidle" })
  const frameEl = await page.waitForSelector("#proto")
  const contentFrame = await frameEl.contentFrame()
  if (!contentFrame) throw new Error("could not get the prototype iframe's content frame")
  frame = contentFrame
  await frame.waitForSelector("button.cta", { timeout: 10_000 })
  await frame.waitForFunction("!!window.__DESDE_BRIDGE_VERSION__", { timeout: 10_000 })
}, 30_000)

afterAll(async () => {
  if (browser) await browser.close().catch(() => {})
  if (server) await server.close().catch(() => {})
  if (scratchApp) rmSync(scratchApp, { recursive: true, force: true })
}, 15_000)

describe("react live click→edit→HMR loop", () => {
  it("bridge initializes in the React iframe", async () => {
    const bridgeVersion = await frame!.evaluate("window.__DESDE_BRIDGE_VERSION__")
    expect(typeof bridgeVersion).toBe("string")
  })

  let h1Loc: SourceLoc | undefined
  let ulLoc: SourceLoc | undefined
  let pLoc: SourceLoc | undefined

  it("click→source resolves h1.title to App.tsx", async () => {
    const h1Inspect = await inspect(page!, "h1.title")
    h1Loc = resolvedLoc(h1Inspect)
    expect(h1Loc, `inspection payload: ${JSON.stringify(h1Inspect)}`).toBeTruthy()
    expect(h1Loc?.file).toMatch(/App\.tsx$/)
  })

  it("applyEdit (prop) writes className to source and HMR reflects it live", async () => {
    if (!h1Loc) throw new Error("no editTarget for h1.title from the prior step")
    const propResult = await applyEdit(
      {
        edit: {
          kind: "prop",
          file: h1Loc.file,
          line: h1Loc.line,
          column: h1Loc.column,
          propName: "className",
          value: "title live-edited",
        },
      },
      scratchApp,
      defaultApplicatorLoaders,
    )
    expect(propResult.ok, JSON.stringify(propResult.ok ? propResult : (propResult.reason ?? propResult.status))).toBe(true)
    const appOnDisk = readFileSync(path.join(scratchApp, "src/App.tsx"), "utf8")
    expect(appOnDisk).toContain('className="title live-edited"')
    await frame!.waitForSelector("h1.live-edited", { timeout: 10_000 })
  })

  it("click→source resolves ul.list to App.tsx", async () => {
    const ulInspect = await inspect(page!, "ul.list")
    ulLoc = resolvedLoc(ulInspect)
    expect(ulLoc, `inspection payload: ${JSON.stringify(ulInspect)}`).toBeTruthy()
    expect(ulLoc?.file).toMatch(/App\.tsx$/)
  })

  it("applyEdit (insert) adds a <li> to source and HMR reflects it live", async () => {
    if (!ulLoc) throw new Error("no editTarget for ul.list from the prior step")
    const insertResult = await applyEdit(
      {
        edit: {
          kind: "insert",
          file: ulLoc.file,
          line: ulLoc.line,
          column: ulLoc.column,
          destIndex: -1,
          snippet: '<li className="item live-inserted">C</li>',
        },
      },
      scratchApp,
      defaultApplicatorLoaders,
    )
    expect(insertResult.ok, JSON.stringify(insertResult.ok ? insertResult : (insertResult.reason ?? insertResult.status))).toBe(true)
    await frame!.waitForSelector("ul.list li.live-inserted", { timeout: 10_000 })
  })

  it("click→source resolves p.caption to App.tsx", async () => {
    const pInspect = await inspect(page!, "p.caption")
    pLoc = resolvedLoc(pInspect)
    expect(pLoc, `inspection payload: ${JSON.stringify(pInspect)}`).toBeTruthy()
    expect(pLoc?.file).toMatch(/App\.tsx$/)
  })

  it("applyEdit (delete) removes the caption from source and HMR reflects it live", async () => {
    if (!pLoc) throw new Error("no editTarget for p.caption from the prior step")
    const deleteResult = await applyEdit(
      { edit: { kind: "delete", file: pLoc.file, line: pLoc.line, column: pLoc.column } },
      scratchApp,
      defaultApplicatorLoaders,
    )
    expect(deleteResult.ok, JSON.stringify(deleteResult.ok ? deleteResult : (deleteResult.reason ?? deleteResult.status))).toBe(true)
    const appAfterDelete = readFileSync(path.join(scratchApp, "src/App.tsx"), "utf8")
    expect(appAfterDelete).not.toContain('className="caption"')
    await frame!.waitForFunction("!document.querySelector('p.caption')", { timeout: 10_000 })
  })

  it("applyEdit (jsx-style, classname mode) merges a utility class and HMR reflects it live", async () => {
    // The original reported bug: restyling a React element refused with
    // "Only .vue files are supported". jsx-style (classname mode) is the
    // fix. h1Loc's opening-tag coordinate is stable across the className
    // prop edit above (a value splice doesn't move the line).
    if (!h1Loc) throw new Error("no editTarget for h1.title from the earlier step")
    const styleResult = await applyEdit(
      {
        edit: {
          kind: "jsx-style",
          file: h1Loc.file,
          line: h1Loc.line,
          column: h1Loc.column,
          mode: "classname",
          addClasses: ["underline"],
        },
      },
      scratchApp,
      defaultApplicatorLoaders,
    )
    expect(styleResult.ok, JSON.stringify(styleResult.ok ? styleResult : (styleResult.reason ?? styleResult.status))).toBe(true)
    const appAfterStyle = readFileSync(path.join(scratchApp, "src/App.tsx"), "utf8")
    expect(appAfterStyle).toMatch(/className="title live-edited underline"/)
    await frame!.waitForSelector("h1.underline", { timeout: 10_000 })
  })

  it("no JS errors occurred during the live loop", () => {
    expect(pageErrors).toEqual([])
  })
})
