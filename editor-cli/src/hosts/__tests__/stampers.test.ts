/**
 * Turning a stamp policy into the Turbopack channel's payload.
 *
 * The property worth protecting is that this NEVER produces a half-built
 * injection. A host booted with no loader registered serves a perfectly healthy
 * dev server that stamps nothing, and the user finds out mid-click; refusing
 * here refuses before anything is bound.
 */
import { describe, expect, it } from "vitest"
import { sep, join } from "node:path"
import { turbopackInjection, TURBOPACK_LOADER_ASSET } from "../stampers.js"
import { buildStampPolicy } from "../stamp-policy.js"

const POLICY = buildStampPolicy({ repoRoot: join(sep, "repo"), buildDirs: [".next"] })
const LOADER = join(sep, "cache", "desde", "0.1.0", "stamp", "next-loader.cjs")

describe("turbopackInjection", () => {
  it("carries the loader path, both extensions, and JSON-only options", () => {
    const injection = turbopackInjection(POLICY, {
      files: { [LOADER]: TURBOPACK_LOADER_ASSET },
    })

    expect(injection.channel).toBe("turbopack-loader")
    expect(injection.loaderPath).toBe(LOADER)
    expect(injection.globs).toEqual(["*.tsx", "*.jsx"])
    // The whole payload has to survive Turbopack's forked loader worker as
    // structured-cloneable data. A round-trip through JSON is the cheapest
    // honest check that nothing in it stopped being plain data.
    expect(JSON.parse(JSON.stringify(injection.options))).toEqual(injection.options)
    expect(injection.options.policy).toBe(POLICY)
    // The shorthand root the same loader accepts from attach mode's bare-string
    // registration. Anchored on `stampRoot` so the two channels cannot end up
    // relativising against different trees.
    expect(injection.options.repoRoot).toBe(POLICY.stampRoot)
  })

  it("ignores assets that are not the stamper loader", () => {
    const injection = turbopackInjection(POLICY, {
      files: { [LOADER]: TURBOPACK_LOADER_ASSET, [join(sep, "cache", "notes.txt")]: "something-else" },
    })
    expect(injection.loaderPath).toBe(LOADER)
  })

  it("refuses when nothing was materialized", () => {
    expect(() => turbopackInjection(POLICY, { files: {} })).toThrow(/nothing to register/)
    expect(() => turbopackInjection(POLICY, null)).toThrow(/nothing to register/)
  })

  it("refuses two candidate loaders rather than picking one by key order", () => {
    // One rule, one loader. Taking the first would make which file stamps depend
    // on object key ordering, which is not a thing anyone should have to reason
    // about when an edit lands in the wrong place.
    const second = join(sep, "cache", "other-loader.cjs")
    expect(() =>
      turbopackInjection(POLICY, {
        files: { [LOADER]: TURBOPACK_LOADER_ASSET, [second]: TURBOPACK_LOADER_ASSET },
      }),
    ).toThrow(/exactly one is expected/)
  })
})
