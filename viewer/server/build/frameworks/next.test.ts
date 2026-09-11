import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { NEXT_ADAPTER } from "./next"
import { inspectBuild } from "./index"

/**
 * Detection reads what the build WROTE, never the config: `out/` means a
 * static export happened, `.next/BUILD_ID` means a server build happened.
 */
const roots: string[] = []
async function checkout(opts: { next?: boolean; out?: boolean; buildId?: boolean }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "fw-next-"))
  roots.push(root)
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "x", dependencies: opts.next === false ? {} : { next: "^16.0.0" } }),
  )
  if (opts.out) await mkdir(join(root, "out"), { recursive: true })
  if (opts.buildId) {
    await mkdir(join(root, ".next"), { recursive: true })
    await writeFile(join(root, ".next", "BUILD_ID"), "abc123")
  }
  return root
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })))
})

describe("Next.js adapter", () => {
  it("ignores a checkout without next in its dependencies", async () => {
    expect(await NEXT_ADAPTER.inspectBuild(await checkout({ next: false, buildId: true }))).toBeNull()
  })
  it("reads out/ as a static export and names that folder", async () => {
    expect(await NEXT_ADAPTER.inspectBuild(await checkout({ out: true }))).toEqual({
      kind: "static",
      outputDir: "out",
      reason: "Next.js static export",
    })
  })
  it("reads .next/BUILD_ID with no out/ as a server", async () => {
    expect(await NEXT_ADAPTER.inspectBuild(await checkout({ buildId: true }))).toEqual({
      kind: "server",
      start: ["node_modules/.bin/next", "start", "-p", "$PORT", "-H", "127.0.0.1"],
      reason: "Next.js with server-rendered routes",
    })
  })
  it("prefers out/ when both exist: a static export that also left .next behind", async () => {
    const shape = await NEXT_ADAPTER.inspectBuild(await checkout({ out: true, buildId: true }))
    expect(shape?.kind).toBe("static")
  })
  it("answers null when the build wrote neither", async () => {
    expect(await NEXT_ADAPTER.inspectBuild(await checkout({}))).toBeNull()
  })
})

describe("inspectBuild", () => {
  it("falls back to the static default with the user's output dir when no adapter answers", async () => {
    expect(await inspectBuild(await checkout({ next: false }), "dist")).toEqual({
      kind: "static",
      outputDir: "dist",
      reason: "No framework recognised; using the configured output dir",
    })
  })
  it("returns the first adapter's answer", async () => {
    expect((await inspectBuild(await checkout({ buildId: true }), "dist")).kind).toBe("server")
  })
})
