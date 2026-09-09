// @vitest-environment node
import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import * as esbuild from "esbuild"
import { JSDOM } from "jsdom"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Guards the bridge rebuild ritual and the version anchor the serve layers
 * depend on.
 *
 * `build:bridge` runs esbuild with `--minify`, which renames identifiers.
 * Both serve layers (editor-cli's `extractBridgeVersion`, the viewer's
 * `getBridgeScript`) recover the version by regex-matching
 * `__DESDE_BRIDGE_VERSION__="…"` in the BUILT bundle. If the source ever
 * stops emitting that literal single-use — e.g. someone reintroduces
 * `const BRIDGE_VERSION = "…"` referenced twice — the minifier hoists it into
 * a renamed binding, extraction silently degrades to "unknown", and the
 * cache-buster / version reporting break with no error anywhere.
 *
 * The equality assertion doubles as the "did you rebuild?" check: bumping the
 * version in source without running `npm run build:bridge` fails here.
 */
const HERE = dirname(fileURLToPath(import.meta.url))
const SOURCE = resolve(HERE, "comment-bridge.ts")
const BUNDLE = resolve(HERE, "../../dist/bridge-bundle.js")

const SHELL_ORIGIN = "https://shell.example"
const PROTO_ORIGIN = "https://proto.example"

/**
 * Evaluate the BUILT bundle twice in ONE jsdom document, as a page that loads
 * it twice really does, and report what each evaluation managed to say.
 *
 * `configured` is one entry per evaluation: `true` gives that copy's script tag
 * the `data-shell-origin` attribute a serve layer injects, `false` is the copy a
 * prototype bundles itself, which has no attribute and therefore fails closed.
 *
 * A copy that never learns the shell origin posts NOTHING (the fail-closed rule
 * from 2026-08-10), so the announcements below come only from configured copies.
 */
function bootTwice(
  bundle: string,
  configured: readonly [boolean, boolean],
): { readyIds: string[]; warnings: string[] } {
  const dom = new JSDOM(`<!doctype html><html><body><div id="app">hi</div></body></html>`, {
    url: `${PROTO_ORIGIN}/`,
    runScripts: "dangerously",
    pretendToBeVisual: true,
  })
  const { window } = dom
  const readyIds: string[] = []
  const fakeParent = {
    postMessage(message: { type?: string; payload?: { documentId?: string } }) {
      if (message?.type === "BRIDGE_READY" && message.payload?.documentId) {
        readyIds.push(message.payload.documentId)
      }
    },
    // A real cross-origin parent throws on `.location`, which is the
    // same-origin test `resolveShellTargetOrigin` performs.
    get location(): never {
      throw new Error("cross-origin")
    },
  }
  Object.defineProperty(window, "parent", { value: fakeParent, configurable: true })
  const warnings: string[] = []
  window.console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "))
  }
  for (const withOrigin of configured) {
    const script = window.document.createElement("script")
    script.setAttribute("data-prototype-flow", "bridge")
    if (withOrigin) script.setAttribute("data-shell-origin", SHELL_ORIGIN)
    script.textContent = bundle
    window.document.body.appendChild(script)
  }
  return { readyIds, warnings }
}

/** The exact recovery both serve layers perform. */
function extractBridgeVersion(script: string): string {
  const global = script.match(/__DESDE_BRIDGE_VERSION__\s*=\s*["']([^"']+)["']/)
  if (global?.[1]) return global[1]
  const declaration = script.match(/BRIDGE_VERSION\s*=\s*["']([^"']+)["']/)
  return declaration?.[1] ?? "unknown"
}

describe("bridge bundle version anchor", () => {
  it("survives minification and matches the source version", () => {
    const sourceVersion = extractBridgeVersion(readFileSync(SOURCE, "utf-8"))
    expect(sourceVersion).not.toBe("unknown")

    const bundle = readFileSync(BUNDLE, "utf-8")
    // Must match on the minify-proof anchor specifically, not the fallback.
    expect(bundle).toMatch(/__DESDE_BRIDGE_VERSION__\s*=\s*"[^"]+"/)
    expect(extractBridgeVersion(bundle)).toBe(sourceVersion)
  })

  it("contains no `</script` substring", () => {
    // NOTHING inlines the bundle any more: the last inline injector,
    // `functions/serve/src/bridge.ts`, was deleted with that whole legacy GCP
    // serve layer on 2026-08-08. Both surviving consumers serve it as an
    // EXTERNAL script — the viewer at
    // `/p/{slug}/__desde/bridge-<version>.js`, the Editor CLI via a Vite
    // `<script src=…>` tag — so neither is exposed to early-tag-close today.
    //
    // The guard stays anyway. It costs one string scan, and the failure it
    // prevents (every served page silently broken) is bad enough that keeping
    // it cheap insurance beats re-deriving the analysis if an inline path ever
    // returns.
    // Minification rewrites string literals, so this is checked against the
    // artifact rather than trusted from source.
    expect(readFileSync(BUNDLE, "utf-8")).not.toContain("</script")
  })

  it("is byte-identical to a fresh build of current source", () => {
    // THE REGRESSION THIS EXISTS FOR (2026-08-08): the committed bundle went
    // two commits stale — the Composer→Editor rename sweep renamed
    // `setComposerMode`/`isComposerMode` in source but nobody re-ran
    // `build:bridge`, so every hosted prototype and every Editor session kept
    // being served the pre-rename bundle. Nothing caught it.
    //
    // The version-equality assertion above CANNOT catch this class of drift:
    // it only compares source's version string to the bundle's, and those
    // still matched because the drifting commits did not bump the version.
    // A stale bundle is invisible to it whenever the author forgets the bump
    // — which is exactly the same moment they forget the rebuild.
    //
    // So compare content, not metadata: rebuild with the SAME esbuild
    // invocation as `npm run build:bridge` (package.json) and require byte
    // equality. Costs ~15ms.
    //
    // If this fails: run `npm run build:bridge` and commit the result. If you
    // also changed behavior, bump BRIDGE_VERSION first — the version is the
    // cache-buster, so shipping new bytes under an old version leaves clients
    // on the cached stale copy.
    const fresh = esbuild.buildSync({
      entryPoints: [SOURCE],
      bundle: true,
      write: false,
      format: "iife",
      target: "es2020",
      minify: true,
    })
    const rebuilt = fresh.outputFiles[0].text
    const committed = readFileSync(BUNDLE, "utf-8")
    expect(rebuilt.length).toBe(committed.length)
    expect(rebuilt).toBe(committed)
  })

  it("returns early only for an earlier copy that is OURS and configured", () => {
    // Round 14 V5, tightened by round 15 W3(a) and round 16 X4. A page can load
    // this bundle twice: two `<script src=…>` tags, a bundler that inlines it as
    // well, or a re-injection after a soft navigation. Each evaluation would
    // mint its own document id and announce itself, and the shell reads a second
    // id as a NEW document, ending the session and discarding the designer's
    // pending edits on a page that never went anywhere.
    //
    // Two things have to hold, and X4 is the second one. The version has to
    // MATCH, so a DIFFERENT bridge the prototype ships cannot suppress the one
    // the shell injected. And the earlier copy has to have been CONFIGURED with
    // a shell origin, because the prototype can bundle the same version we
    // inject: that copy's script tag carries no `data-shell-origin`, so it fails
    // closed, talks to nobody, and the properly injected tag stepping aside for
    // it left the page looking alive with no handshake at all.
    //
    // Driven against the BUILT artifact — minification is what would quietly
    // drop a guard whose result nothing reads — through the real IIFE in a jsdom
    // document, because the shape this now has is a decision, not a pattern.
    const bundle = readFileSync(BUNDLE, "utf-8")

    // Configured first, then a second copy: the second must step aside, so only
    // ONE document id is ever announced.
    const stepsAside = bootTwice(bundle, [true, true])
    expect(stepsAside.readyIds).toHaveLength(1)
    expect(stepsAside.warnings.join(" ")).not.toMatch(/already running/i)

    // Unconfigured first (the prototype's own bundled copy), injected second:
    // the injected one must take over and announce itself, or the shell never
    // hears from this page.
    const takesOver = bootTwice(bundle, [false, true])
    expect(takesOver.readyIds).toHaveLength(1)
    expect(takesOver.warnings.join(" ")).toMatch(/already running/i)

    // And nothing weaker survives alongside it: no bare truthiness return on
    // the global, which is the exact shape W3(a) replaced.
    expect(bundle).not.toContain("__DESDE_BRIDGE_VERSION__)return")
  })

  it("still recovers the version with the guard in front of the assignment", () => {
    // The guard mentions the same global the serve layers regex for, so a
    // sloppier extractor could match the guard and report "unknown". Both
    // layers anchor on `= "…"`, and this is the assertion that keeps that
    // true for the shape actually shipped.
    expect(extractBridgeVersion(readFileSync(BUNDLE, "utf-8"))).toBe(
      extractBridgeVersion(readFileSync(SOURCE, "utf-8")),
    )
  })
})
