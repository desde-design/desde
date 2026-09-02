import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { bridgePlugin } from "../plugins/bridge-plugin"
import {
  bridgeScriptPath,
  buildBridgeTags,
  isBridgeScriptPath,
} from "./bridge-tags"

const FAKE_BUNDLE = 'const BRIDGE_VERSION = "test-1";\nconsole.log(BRIDGE_VERSION)\n'
const SHELL = "http://127.0.0.1:4321"

describe("buildBridgeTags", () => {
  let dir: string
  let bundlePath: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "attach-tags-"))
    bundlePath = join(dir, "bridge-bundle.js")
    await writeFile(bundlePath, FAKE_BUNDLE)
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  /**
   * The whole point of this file: attach mode must inject the SAME markup the
   * Vite plugin injects, or the bridge behaves differently depending on which
   * boot path served the page. Compared byte-for-byte against the real plugin,
   * with only the bundle URL normalised (attach mode stamps the version into
   * the path; Vite stamps it into a `?v=` query).
   */
  it("matches bridgePlugin's injection byte-for-byte apart from the bundle URL", () => {
    const plugin = bridgePlugin({ bridgeBundlePath: bundlePath, shellOrigin: SHELL })
    const transform = plugin.transformIndexHtml as unknown as (h: string) => string
    const out = transform("<html><body></body></html>")

    const fromPlugin = out.slice(
      out.indexOf("<script data-prototype-flow=\"config\">"),
      out.indexOf("</body>"),
    )
    const normalised = fromPlugin.replace(
      "/@desde-bridge.js?v=test-1",
      bridgeScriptPath("test-1"),
    )
    expect(buildBridgeTags(SHELL, "test-1")).toBe(normalised)
  })

  it("carries data-shell-origin on the external tag", () => {
    // The authoritative channel. A strict-CSP prototype drops the inline tag,
    // and the bridge fails CLOSED without an origin, so losing this attribute
    // means a silent bridge -- not a degraded one.
    const tags = buildBridgeTags(SHELL, "v1")
    const bridgeTag = tags.match(/<script data-prototype-flow="bridge"[^>]*>/)?.[0] ?? ""
    expect(bridgeTag).toContain(`data-shell-origin="${SHELL}"`)
    expect(bridgeTag).toContain(`src="${bridgeScriptPath("v1")}"`)
    expect(bridgeTag).toContain("defer")
  })

  it("puts the inline config tag first, where the bundle can read it", () => {
    const tags = buildBridgeTags(SHELL, "v1")
    expect(tags.indexOf("__DESDE_SHELL_ORIGIN__")).toBeLessThan(
      tags.indexOf('data-prototype-flow="bridge"'),
    )
  })

  it("escapes an origin so it can neither close the script nor add an attribute", () => {
    const hostile = 'http://evil"</script><script>alert(1)</script> onload="x'
    const tags = buildBridgeTags(hostile, "v1")
    expect(tags).not.toContain("</script><script>alert(1)")
    expect(tags).toContain("\\u003c/script>")
    const bridgeTag = tags.match(/<script data-prototype-flow="bridge"[^>]*>/)?.[0] ?? ""
    const names = [...bridgeTag.matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => m[1])
    expect(names).toEqual(["data-prototype-flow", "data-shell-origin", "src"])
  })

  it("recognises its own versioned paths and nothing else", () => {
    expect(isBridgeScriptPath(bridgeScriptPath("2026-08-09e"))).toBe(true)
    expect(isBridgeScriptPath(bridgeScriptPath("anything"))).toBe(true)
    expect(isBridgeScriptPath("/__desde/bridge-v1.js.map")).toBe(false)
    expect(isBridgeScriptPath("/src/main.tsx")).toBe(false)
    expect(isBridgeScriptPath("/.desde/config.json")).toBe(false)
  })
})
