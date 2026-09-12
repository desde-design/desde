import { mkdtemp, mkdir, writeFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { NEXT_ADAPTER } from "./next"
import { inspectBuild, ADAPTERS } from "./index"

/**
 * Detection reads what the build WROTE, never the config: `out/` means a
 * static export happened, `BUILD_ID` (+ `required-server-files.json`)
 * together mean a server build happened.
 *
 * Codex round 4, Fix 4: `buildId` no longer always means `.next` — pass
 * `distDir` to write it (and, for standalone cases, the standalone server)
 * somewhere else, the way a checkout with `distDir: "build"` in
 * `next.config` would.
 */
const roots: string[] = []
async function checkout(opts: {
  next?: boolean
  out?: boolean
  outBare?: boolean
  outIndexOnly?: boolean
  buildId?: boolean
  distDir?: string
  standalone?: boolean
  staticDir?: boolean
  publicDir?: boolean
  /** Whether `node_modules/.bin/next` exists in this checkout. */
  nextBinary?: boolean
}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "fw-next-"))
  roots.push(root)
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "x", dependencies: opts.next === false ? {} : { next: "^16.0.0" } }),
  )
  if (opts.out) {
    // What `output: "export"` writes: the asset folder and a root page.
    await mkdir(join(root, "out", "_next"), { recursive: true })
    await writeFile(join(root, "out", "index.html"), "<html></html>")
  }
  // A folder named `out` that some other tool left, with nothing Next wrote.
  if (opts.outBare) await mkdir(join(root, "out"), { recursive: true })
  // A stale `out/index.html` from an old export, with no asset folder.
  if (opts.outIndexOnly) {
    await mkdir(join(root, "out"), { recursive: true })
    await writeFile(join(root, "out", "index.html"), "<html></html>")
  }
  const distDir = opts.distDir ?? ".next"
  if (opts.buildId) {
    await mkdir(join(root, distDir), { recursive: true })
    await writeFile(join(root, distDir, "BUILD_ID"), "abc123")
    await writeFile(join(root, distDir, "required-server-files.json"), "{}")
  }
  if (opts.standalone) {
    await mkdir(join(root, distDir, "standalone"), { recursive: true })
    await writeFile(join(root, distDir, "standalone", "server.js"), "// standalone server")
  }
  if (opts.staticDir) {
    await mkdir(join(root, distDir, "static"), { recursive: true })
    await writeFile(join(root, distDir, "static", "chunk.js"), "// static chunk")
  }
  if (opts.publicDir) {
    await mkdir(join(root, "public"), { recursive: true })
    await writeFile(join(root, "public", "favicon.ico"), "// favicon")
  }
  if (opts.nextBinary) {
    await mkdir(join(root, "node_modules", ".bin"), { recursive: true })
    await writeFile(join(root, "node_modules", ".bin", "next"), "#!/usr/bin/env node\n")
  }
  return root
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })))
})
async function exists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

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
    expect(await NEXT_ADAPTER.inspectBuild(await checkout({ buildId: true, nextBinary: true }))).toEqual({
      kind: "server",
      start: ["node_modules/.bin/next", "start", "-p", "$PORT", "-H", "127.0.0.1"],
      reason: "Next.js with server-rendered routes",
    })
  })
  it("prefers out/ when both exist: a static export that also left .next behind", async () => {
    const shape = await NEXT_ADAPTER.inspectBuild(await checkout({ out: true, buildId: true }))
    expect(shape?.kind).toBe("static")
  })
  it("does not let a stale out/index.html with no asset folder win over a server build (codex round 19)", async () => {
    const shape = await NEXT_ADAPTER.inspectBuild(await checkout({ outIndexOnly: true, buildId: true, nextBinary: true }))
    expect(shape?.kind).toBe("server")
  })
  it("does not let a bare out/ folder with nothing Next wrote win over a server build (codex round 16)", async () => {
    const shape = await NEXT_ADAPTER.inspectBuild(await checkout({ outBare: true, buildId: true, nextBinary: true }))
    expect(shape?.kind).toBe("server")
  })
  it("answers null when the build wrote neither", async () => {
    expect(await NEXT_ADAPTER.inspectBuild(await checkout({}))).toBeNull()
  })

  /**
   * Codex round 4, Fix 4. `BUILD_ID` used to be hard-coded under `.next`, so
   * a checkout with a custom `distDir` in `next.config` (`distDir: "build"`)
   * fell through to static publishing and failed to detect a server build
   * at all — see `findNextDistDir` (`fs-probe.ts`) for the scan this now
   * runs instead.
   */
  it("detects a server build under a custom depth-1 distDir (distDir: \"build\")", async () => {
    expect(
      await NEXT_ADAPTER.inspectBuild(await checkout({ buildId: true, distDir: "build", nextBinary: true })),
    ).toEqual({
      kind: "server",
      start: ["node_modules/.bin/next", "start", "-p", "$PORT", "-H", "127.0.0.1"],
      reason: "Next.js with server-rendered routes",
    })
  })

  it("detects a server build under a custom nested distDir (distDir: \"build/next\")", async () => {
    expect(
      await NEXT_ADAPTER.inspectBuild(await checkout({ buildId: true, distDir: "build/next", nextBinary: true })),
    ).toEqual({
      kind: "server",
      start: ["node_modules/.bin/next", "start", "-p", "$PORT", "-H", "127.0.0.1"],
      reason: "Next.js with server-rendered routes",
    })
  })

  /**
   * Codex round 15, Fix 3. `node_modules/.bin/next` used to be recorded as
   * the start command without checking it exists. The non-standalone
   * `next start` path needs the `next` package installed to run it; a
   * checkout missing that binary used to be marked `deployed` and then
   * ENOENT on every cold start.
   */
  it("reports unsupported when a server build exists but node_modules/.bin/next does not", async () => {
    expect(await NEXT_ADAPTER.inspectBuild(await checkout({ buildId: true }))).toEqual({
      kind: "unsupported",
      reason: "This Next.js build needs the next package installed to run.",
    })
  })
})

/**
 * Codex round 4, Fix 3. `output: "standalone"` writes `BUILD_ID` (and
 * `required-server-files.json`) same as any server build, plus a
 * self-contained `<distDir>/standalone/server.js` that `next start` refuses
 * to run — so a standalone build used to be recorded as `next start` and
 * failed to boot. Detected FIRST, ahead of the generic `next start` case.
 */
describe("Next.js adapter — output: \"standalone\"", () => {
  it("detects the default .next/standalone/server.js and records it as the start command", async () => {
    const shape = await NEXT_ADAPTER.inspectBuild(await checkout({ buildId: true, standalone: true }))
    expect(shape).toMatchObject({
      kind: "server",
      start: ["node", join(".next", "standalone", "server.js")],
      reason: "Next.js standalone output",
    })
  })

  it("detects a standalone server under a custom distDir (Fix 4 + Fix 3 together)", async () => {
    const shape = await NEXT_ADAPTER.inspectBuild(
      await checkout({ buildId: true, standalone: true, distDir: "build" }),
    )
    expect(shape).toMatchObject({
      kind: "server",
      start: ["node", join("build", "standalone", "server.js")],
      reason: "Next.js standalone output",
    })
  })

  it("falls back to the generic next start recorded command when there is no standalone/server.js", async () => {
    const shape = await NEXT_ADAPTER.inspectBuild(await checkout({ buildId: true, nextBinary: true }))
    expect(shape).toEqual({
      kind: "server",
      start: ["node_modules/.bin/next", "start", "-p", "$PORT", "-H", "127.0.0.1"],
      reason: "Next.js with server-rendered routes",
    })
  })

  /**
   * Next's standalone output does not include `<distDir>/static` or the
   * root `public/` — the framework's own docs say to copy both into the
   * standalone dir, or the server starts but every asset 404s. `prepare` is
   * the adapter's own copy step, run against a temp directory here (it is
   * awaited by the build runner in production — see `build-runner.test.ts`).
   */
  it("prepare() copies both static and public into the standalone dir, skipping whichever is absent", async () => {
    const root = await checkout({ buildId: true, standalone: true, staticDir: true, publicDir: true })
    const shape = await NEXT_ADAPTER.inspectBuild(root)
    if (shape?.kind !== "server" || !shape.prepare) throw new Error("expected a standalone server shape with prepare")

    await shape.prepare(root)

    expect(await exists(join(root, ".next", "standalone", ".next", "static", "chunk.js"))).toBe(true)
    expect(await exists(join(root, ".next", "standalone", "public", "favicon.ico"))).toBe(true)
  })

  it("prepare() skips a missing static or public source without throwing", async () => {
    const root = await checkout({ buildId: true, standalone: true })
    const shape = await NEXT_ADAPTER.inspectBuild(root)
    if (shape?.kind !== "server" || !shape.prepare) throw new Error("expected a standalone server shape with prepare")

    await expect(shape.prepare(root)).resolves.toBeUndefined()
    expect(await exists(join(root, ".next", "standalone", ".next", "static"))).toBe(false)
    expect(await exists(join(root, ".next", "standalone", "public"))).toBe(false)
  })

  it("prepare() copies into a CUSTOM distDir's standalone dir too", async () => {
    const root = await checkout({ buildId: true, standalone: true, distDir: "build", staticDir: true, publicDir: true })
    const shape = await NEXT_ADAPTER.inspectBuild(root)
    if (shape?.kind !== "server" || !shape.prepare) throw new Error("expected a standalone server shape with prepare")

    await shape.prepare(root)

    expect(await exists(join(root, "build", "standalone", "build", "static", "chunk.js"))).toBe(true)
    expect(await exists(join(root, "build", "standalone", "public", "favicon.ico"))).toBe(true)
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
    expect((await inspectBuild(await checkout({ buildId: true, nextBinary: true }), "dist")).kind).toBe("server")
  })
  // Codex round 15, Fix 3: an `unsupported` answer is a DONE answer from an
  // adapter that recognised the checkout — it must stop the chain rather
  // than fall through to the next adapter or the generic static default the
  // way `null` does (a Next checkout with no `next` binary must not end up
  // silently republished as a static folder of Next's own build output).
  it("stops at an unsupported answer rather than falling through to the static default", async () => {
    const result = await inspectBuild(await checkout({ buildId: true }), "dist")
    expect(result).toEqual({
      kind: "unsupported",
      reason: "This Next.js build needs the next package installed to run.",
    })
  })
  it("recognises a Nuxt server checkout through the default ADAPTERS", async () => {
    const root = await mkdtemp(join(tmpdir(), "fw-nuxt-"))
    try {
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({ name: "x", dependencies: { nuxt: "^3.0.0" } }),
      )
      await mkdir(join(root, ".output", "server"), { recursive: true })
      await writeFile(join(root, ".output", "server", "index.mjs"), "export default null")
      const result = await inspectBuild(root, "dist", ADAPTERS)
      expect(result).toEqual({
        kind: "server",
        start: ["node", ".output/server/index.mjs"],
        reason: "Nuxt with a server build",
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
