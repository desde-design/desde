/**
 * The opt-in switch that keeps "this host is built" and "this host is what an
 * unconfigured repo boots" as two separate facts.
 *
 * The property under test is the posture, not the parsing: a malformed `hosts`
 * block must WARN and fall back to the shipped defaults, never refuse the boot.
 * A refusal here would trade a working attach session for a typo in an opt-in
 * flag.
 */
import { afterEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadEnabledHosts } from "../enabled-hosts.js"

/**
 * The shipped defaults, in `DEFAULT_ENABLED`'s own order.
 *
 * It read `["vite"]` until 2026-08-11, when milestone 13 flipped `nuxt`,
 * `react-router` and `next` ON for every repo (Mo: *"Turn all new hosts, except
 * for Astro as that has partial functionality"*). Each was flipped only after
 * `verify-host.mts` returned 10 PASS / 0 FAIL and `edit-matrix.mts` 13 PASS /
 * 0 FAIL against a real repo of that framework, plus the two corruption runs
 * that take every coordinate-carrying op red.
 *
 * Every expectation below that used to read `["vite"]` now reads this. The
 * assertions themselves did not change meaning — "a malformed block falls back
 * to the DEFAULTS" is the same property; the defaults are what moved.
 */
const SHIPPED_DEFAULTS = ["vite", "nuxt", "react-router", "next"]

const dirs: string[] = []

function project(config?: string): string {
  const root = mkdtempSync(join(tmpdir(), "pt-enabled-hosts-"))
  dirs.push(root)
  if (config !== undefined) {
    writeFileSync(join(root, "desde.config.json"), config)
  }
  return root
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("loadEnabledHosts", () => {
  it("enables the shipped hosts when nothing is configured", async () => {
    const result = await loadEnabledHosts(project())
    expect([...result.enabled]).toEqual(SHIPPED_DEFAULTS)
    // A missing config file is the ordinary state and must say nothing.
    expect(result.warnings).toEqual([])
  })

  it("enables the shipped hosts when the file exists without a hosts block", async () => {
    const result = await loadEnabledHosts(project('{ "readRoots": {} }'))
    expect([...result.enabled]).toEqual(SHIPPED_DEFAULTS)
    expect(result.warnings).toEqual([])
  })

  /**
   * `astro` is on a DELIBERATE hold (product decision 2026-08-11 — "dormant
   * until we get a signal for user need and desire"), not merely un-flipped:
   * `.astro` pages are inspect-only while their islands edit normally, and
   * closing that needs an `.astro` applicator plus an `.astro` case in
   * `checkExtensionGate` before the flip is even coherent.
   *
   * Its gate is 10/10 green, which is exactly what makes this worth pinning —
   * the next reader sees a passing host and a one-line diff. This turns
   * "someone finishes the job" into a failing test that points at the hold.
   *
   * The 2026-08-11 flip RAISED the value of this test rather than dating it:
   * astro is now the only in-process host missing from `DEFAULT_ENABLED`, so
   * the list itself reads like an oversight. It is not one.
   */
  it("keeps astro OFF by default — a deliberate hold, see DEFAULT_ENABLED", async () => {
    const result = await loadEnabledHosts(project())
    expect(result.enabled.has("astro")).toBe(false)
    // The opt-in still works: a hold is not a removal.
    const optedIn = await loadEnabledHosts(project('{ "hosts": { "astro": true } }'))
    expect(optedIn.enabled.has("astro")).toBe(true)
    expect(optedIn.warnings).toEqual([])
  })

  /**
   * Retargeted from `react-router` to `astro` by the 2026-08-11 flip. Opting
   * in to a host that is ALREADY on proves nothing — the assertion would pass
   * against a loader that ignored the block entirely. `astro` is now the only
   * host for which turning something on is observable, so it is the only host
   * this property can be tested with.
   */
  it("turns a host that is off on", async () => {
    const result = await loadEnabledHosts(project('{ "hosts": { "astro": true } }'))
    expect(result.enabled.has("astro")).toBe(true)
    // …without taking the defaults away.
    expect([...result.enabled]).toEqual([...SHIPPED_DEFAULTS, "astro"])
    expect(result.warnings).toEqual([])
  })

  /**
   * The `false` direction carried little weight while `vite` was the only
   * default. After the 2026-08-11 flip it is the escape hatch for four
   * frameworks at once — the one thing a user does when an in-process boot
   * goes wrong for them and they want their own dev server back — so it is
   * pinned for a flipped host as well as for `vite`.
   */
  it("turns a default-on host off, which is how a user forces attach mode", async () => {
    const result = await loadEnabledHosts(project('{ "hosts": { "vite": false } }'))
    expect(result.enabled.has("vite")).toBe(false)

    const flipped = await loadEnabledHosts(project('{ "hosts": { "next": false } }'))
    expect(flipped.enabled.has("next")).toBe(false)
    // Only the named host. Opting one out must not opt the others out.
    expect(flipped.enabled.has("nuxt")).toBe(true)
    expect(flipped.enabled.has("react-router")).toBe(true)
    expect(flipped.warnings).toEqual([])
  })

  it("warns and keeps the defaults when the block is not an object", async () => {
    const result = await loadEnabledHosts(project('{ "hosts": ["react-router"] }'))
    expect([...result.enabled]).toEqual(SHIPPED_DEFAULTS)
    expect(result.warnings.join(" ")).toMatch(/"hosts" must be an object/)
  })

  it("names what is available when the block names a host this build has not built", async () => {
    const result = await loadEnabledHosts(project('{ "hosts": { "svelte-kit": true } }'))
    expect([...result.enabled]).toEqual(SHIPPED_DEFAULTS)
    // Listing the available ids is what turns a silent no-op into a fixable line.
    expect(result.warnings.join(" ")).toMatch(/svelte-kit/)
    expect(result.warnings.join(" ")).toMatch(/react-router/)
  })

  it("refuses `hosts.attach` — a registry entry is not an opt-in-able lane", async () => {
    // `attach` gained a registry entry at the detection rewrite, and if this
    // block validated against the registry rather than against the IN-PROCESS
    // ids, `hosts.attach: true` would be accepted and silently add a lane with
    // no dev server to boot. Attach is reached by naming a URL, never by opting
    // in, so it gets the same "not an in-process host" line an unbuilt id gets.
    const result = await loadEnabledHosts(project('{ "hosts": { "attach": true } }'))
    expect(result.enabled.has("attach")).toBe(false)
    expect([...result.enabled]).toEqual(SHIPPED_DEFAULTS)
    expect(result.warnings.join(" ")).toMatch(/"hosts\.attach" is not an in-process host/)
    // And the list of what IS available must not offer it either.
    expect(result.warnings.join(" ")).not.toMatch(/Available:.*attach/)
  })

  /**
   * Retargeted from `react-router` to `astro` by the 2026-08-11 flip, for the
   * same reason as "turns a host that is off on": `has("react-router")` is now
   * true whatever the loader does with the value, so the old assertion could
   * no longer fail. The second half is new and is what the flip made possible
   * to get wrong — a junk value on a DEFAULT-ON host must warn and leave it
   * alone, never fall through to the `else` branch and delete it.
   */
  it("warns on a non-boolean value rather than coercing it", async () => {
    const result = await loadEnabledHosts(project('{ "hosts": { "astro": "yes" } }'))
    expect(result.enabled.has("astro")).toBe(false)
    expect(result.warnings.join(" ")).toMatch(/must be true or false/)

    const onDefault = await loadEnabledHosts(project('{ "hosts": { "next": "no" } }'))
    expect(onDefault.enabled.has("next")).toBe(true)
    expect(onDefault.warnings.join(" ")).toMatch(/must be true or false/)
  })

  it("falls back to the defaults on unparseable JSON instead of throwing", async () => {
    // `loadReadRoots` reads the same file moments later in `core.ts` and FAILS
    // the boot on it — that is the loud path, and it owns being loud. This
    // loader's only job is to not make a broken config worse by throwing from
    // an earlier line with a less useful message.
    const result = await loadEnabledHosts(project("{ not json"))
    expect([...result.enabled]).toEqual(SHIPPED_DEFAULTS)
    expect(result.warnings).toHaveLength(1)
  })
})
