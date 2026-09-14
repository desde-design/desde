import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { dismissViewerMatch, isViewerMatchDismissed } from "../viewer-match-dismissal"
import { upsertProjectRegistryEntry } from "../projects-registry"

const dirs: string[] = []
function tmpHome(): string {
  const d = mkdtempSync(join(tmpdir(), "vmd-home-"))
  dirs.push(d)
  vi.stubEnv("HOME", d)
  return d
}
afterEach(() => {
  vi.unstubAllEnvs()
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }))
})

describe("viewer match dismissal", () => {
  it("is false before anything is dismissed", async () => {
    tmpHome()
    expect(await isViewerMatchDismissed("/repo/a", "https://viewer.test")).toBe(false)
  })

  it("remembers a dismissal for that repo and that viewer", async () => {
    tmpHome()
    await dismissViewerMatch("/repo/a", "https://viewer.test")
    expect(await isViewerMatchDismissed("/repo/a", "https://viewer.test")).toBe(true)
  })

  it("does not leak across repos", async () => {
    tmpHome()
    await dismissViewerMatch("/repo/a", "https://viewer.test")
    expect(await isViewerMatchDismissed("/repo/b", "https://viewer.test")).toBe(false)
  })

  it("asks again for a different viewer", async () => {
    // Pointing the Editor at another viewer is a different question, so a
    // dismissal on one must not silence the other.
    tmpHome()
    await dismissViewerMatch("/repo/a", "https://viewer.test")
    expect(await isViewerMatchDismissed("/repo/a", "https://other.test")).toBe(false)
  })

  it("treats an origin as one key however it was typed", async () => {
    tmpHome()
    await dismissViewerMatch("/repo/a", "https://Viewer.test/review/x")
    expect(await isViewerMatchDismissed("/repo/a", "https://viewer.test/")).toBe(true)
  })

  it("keeps a dismissal across an ordinary registry update", async () => {
    // The registry is rewritten on every boot. A dismissal that a reopen
    // erased would make the chooser return every single time.
    tmpHome()
    await dismissViewerMatch("/repo/a", "https://viewer.test")
    await upsertProjectRegistryEntry({ path: "/repo/a", slug: "a" })
    expect(await isViewerMatchDismissed("/repo/a", "https://viewer.test")).toBe(true)
  })
})
