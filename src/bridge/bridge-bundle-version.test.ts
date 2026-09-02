// @vitest-environment node
import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import * as esbuild from "esbuild"
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
})
