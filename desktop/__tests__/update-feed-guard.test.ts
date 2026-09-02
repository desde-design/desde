/**
 * F1 (whole-branch review, merge blocker; P1 fix on second pass) — see
 * `update-feed-guard.ts`'s own doc comment for the full failure mode. Pure
 * decision function, tested by injecting `isPackaged`/`readFileSync` rather
 * than booting a real Electron `app`.
 *
 * Covers BOTH directions the P1 review named explicitly:
 *   - a build that CONFIRMS no publish provider at package time stays idle
 *     (the original bug this guard fixes);
 *   - a build that never confirmed that (stamp missing, malformed, or says
 *     `true`) does NOT skip — a configured-but-broken feed must still reach
 *     the real check and surface as an error, not sit silently idle.
 */
import { describe, expect, it } from "vitest"
import { shouldSkipUpdateChecks, updateFeedStatusPath, UPDATE_FEED_STATUS_FILENAME } from "../update-feed-guard.js"

function readerFor(files: Record<string, string>): (path: string) => string {
  return (path: string) => {
    if (!(path in files)) throw new Error(`ENOENT: no such file or directory, open '${path}'`)
    return files[path]
  }
}

const resourcesPath = "/Applications/Desde Editor.app/Contents/Resources"
const statusPath = updateFeedStatusPath(resourcesPath)

describe("shouldSkipUpdateChecks", () => {
  it("never skips in a dev (unpackaged) run, regardless of the stamp", () => {
    expect(
      shouldSkipUpdateChecks({
        isPackaged: false,
        resourcesPath,
        readFileSync: readerFor({ [statusPath]: JSON.stringify({ publishConfigured: false }) }),
      }),
    ).toBe(false)
  })

  it("direction 1 (the original bug): skips when the stamp explicitly confirms no publish provider at package time", () => {
    const result = shouldSkipUpdateChecks({
      isPackaged: true,
      resourcesPath,
      readFileSync: readerFor({ [statusPath]: JSON.stringify({ publishConfigured: false }) }),
    })
    expect(result).toBe(true)
  })

  it("direction 2 (the P1 gap): does NOT skip when the stamp confirms a publish provider IS configured — a broken feed must still error, not go silently idle", () => {
    const result = shouldSkipUpdateChecks({
      isPackaged: true,
      resourcesPath,
      readFileSync: readerFor({ [statusPath]: JSON.stringify({ publishConfigured: true }) }),
    })
    expect(result).toBe(false)
  })

  it("direction 2: does NOT skip when the stamp is missing entirely (an old build, or a packaging defect) — fails toward attempting the real check", () => {
    const result = shouldSkipUpdateChecks({
      isPackaged: true,
      resourcesPath,
      readFileSync: readerFor({}), // nothing at statusPath
    })
    expect(result).toBe(false)
  })

  it("direction 2: does NOT skip when the stamp is malformed JSON", () => {
    const result = shouldSkipUpdateChecks({
      isPackaged: true,
      resourcesPath,
      readFileSync: readerFor({ [statusPath]: "{ not valid json" }),
    })
    expect(result).toBe(false)
  })

  it("direction 2: does NOT skip when publishConfigured is absent from an otherwise-valid stamp", () => {
    const result = shouldSkipUpdateChecks({
      isPackaged: true,
      resourcesPath,
      readFileSync: readerFor({ [statusPath]: JSON.stringify({ packagedAt: "2026-08-13T00:00:00.000Z" }) }),
    })
    expect(result).toBe(false)
  })

  it("direction 2: does NOT skip on a non-boolean publishConfigured value (an unrecognized future shape)", () => {
    const result = shouldSkipUpdateChecks({
      isPackaged: true,
      resourcesPath,
      readFileSync: readerFor({ [statusPath]: JSON.stringify({ publishConfigured: "no" }) }),
    })
    expect(result).toBe(false)
  })

  it("reads exactly the stamp path this module claims to use", () => {
    let checked: string | null = null
    shouldSkipUpdateChecks({
      isPackaged: true,
      resourcesPath,
      readFileSync: (path) => {
        checked = path
        throw new Error("boom")
      },
    })
    expect(checked).toBe(statusPath)
  })
})

describe("updateFeedStatusPath / UPDATE_FEED_STATUS_FILENAME", () => {
  it("joins resourcesPath with the status filename", () => {
    expect(updateFeedStatusPath("/a/b/Resources")).toBe(`/a/b/Resources/${UPDATE_FEED_STATUS_FILENAME}`)
  })
})
