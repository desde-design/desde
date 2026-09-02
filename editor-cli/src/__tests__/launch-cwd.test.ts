/**
 * `launchCwd()` must survive a chdir, because the whole point is that
 * `core.ts` performs one.
 *
 * The bug this guards (codex review 2026-08-09): `core.ts` chdirs into the
 * prototype's Vite root so a user `vite.config.ts` calling `process.cwd()`
 * resolves correctly. That is permanent, process-global state — and the
 * breadcrumb "home" launcher starts lazily IN THAT SAME PROCESS afterwards,
 * with launch-directory-relative operations. `cloneRepo()` resolving an
 * omitted destination against the live cwd would create the clone INSIDE the
 * repo being edited.
 */
import { afterEach, describe, expect, it } from "vitest"
import { resolve } from "node:path"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { launchCwd } from "../launch-cwd.js"

/**
 * macOS puts the temp dir behind a symlink (`/var` → `/private/var`), and
 * `process.cwd()` reports the RESOLVED path while `mkdtempSync` returns the
 * symlinked one. Comparing them raw fails for a reason that has nothing to do
 * with what is under test.
 */
function tempDir(prefix: string): string {
  return realpathSync(mkdtempSync(resolve(realpathSync(tmpdir()), prefix)))
}

const original = process.cwd()
afterEach(() => process.chdir(original))

describe("launchCwd", () => {
  it("is unchanged by a later process.chdir", () => {
    const before = launchCwd()
    process.chdir(tempDir("launch-cwd-"))
    expect(process.cwd()).not.toBe(before)
    expect(launchCwd()).toBe(before)
  })

  it("is the base that keeps a relative clone out of the edited prototype", () => {
    // The concrete failure, spelled out: a bare `resolve()` after the chdir
    // points into the prototype, which is where the clone would land.
    const launched = launchCwd()
    const prototype = tempDir("prototype-")
    process.chdir(prototype)

    expect(resolve("some-repo")).toBe(resolve(prototype, "some-repo"))
    expect(resolve(launchCwd(), "some-repo")).toBe(resolve(launched, "some-repo"))
    expect(resolve(launchCwd(), "some-repo").startsWith(prototype)).toBe(false)
  })

  it("leaves an absolute destination alone either way", () => {
    process.chdir(tempDir("prototype-"))
    expect(resolve(launchCwd(), "/abs/dest")).toBe("/abs/dest")
  })
})
