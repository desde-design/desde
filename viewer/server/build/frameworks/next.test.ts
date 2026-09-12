import { mkdtemp, mkdir, writeFile, rm, stat, utimes } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
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
  /** Where `out` (the `output: "export"` folder) is written; `out` at the root by default (codex round 30). */
  exportDir?: string
  outBare?: boolean
  outIndexOnly?: boolean
  buildId?: boolean
  distDir?: string
  standalone?: boolean
  staticDir?: boolean
  publicDir?: boolean
  /** Whether `node_modules/.bin/next` exists in this checkout. */
  nextBinary?: boolean
  /** Whether `<app dir>/node_modules/.bin/next` exists (codex round 29, item 2). */
  appNextBinary?: boolean
  /**
   * The app directory `appNextBinary` and `appPackageJson` write under; the
   * parent of `distDir` by default. Set it for a custom nested dist dir
   * inside a workspace app (`apps/web/build/next` owned by `apps/web`,
   * codex round 31).
   */
  appDir?: string
  /**
   * Dependencies to write into a package.json at the PARENT of `distDir` —
   * the app directory a workspace scan derives (codex round 29, item 1).
   * Lets a fixture model a workspace where only the app package, not the
   * workspace root, declares `next`. Skipped when `distDir` has no parent
   * (sits directly under the checkout root).
   */
  appPackageJson?: Record<string, string>
}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "fw-next-"))
  roots.push(root)
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "x", dependencies: opts.next === false ? {} : { next: "^16.0.0" } }),
  )
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
  // Written LAST, because that is the order a real `output: "export"` build
  // writes them in: the dist dir first, then the export it produces out of it.
  // Which is newer now decides between them (codex round 20, item 4), so a
  // fixture that wrote the export first would stand for a case that cannot
  // happen.
  if (opts.out) {
    // What `output: "export"` writes: the asset folder and a root page.
    const exportDir = opts.exportDir ?? "out"
    await mkdir(join(root, exportDir, "_next"), { recursive: true })
    await writeFile(join(root, exportDir, "index.html"), "<html></html>")
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
  if (opts.appNextBinary) {
    const appDir = opts.appDir ?? dirname(distDir)
    await mkdir(join(root, appDir, "node_modules", ".bin"), { recursive: true })
    await writeFile(join(root, appDir, "node_modules", ".bin", "next"), "#!/usr/bin/env node\n")
  }
  if (opts.appPackageJson) {
    const appDir = opts.appDir ?? dirname(distDir)
    if (appDir !== ".") {
      await mkdir(join(root, appDir), { recursive: true })
      await writeFile(
        join(root, appDir, "package.json"),
        JSON.stringify({ name: "app", dependencies: opts.appPackageJson }),
      )
    }
  }
  return root
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })))
})
/** Sets a file's access and modification times, so a test can say which build happened first. */
async function touch(p: string, whenMs: number): Promise<void> {
  await utimes(p, whenMs / 1000, whenMs / 1000)
}
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

  /**
   * Codex round 20, item 4. A complete `out/` used to win over a server build
   * outright, so a project that exported once and then switched to
   * server-rendered routes was published as the old export for ever: every
   * rebuild wrote a fresh `.next` that the stale `out/` kept outranking. The
   * two are compared by write time instead, `out/index.html` against
   * `<distDir>/BUILD_ID`, and the newer one is the build that just happened.
   */
  it("reads a server build newer than a complete out/ as the current build", async () => {
    const root = await checkout({ out: true, buildId: true, nextBinary: true })
    await touch(join(root, "out", "index.html"), Date.now() - 60_000)
    await touch(join(root, ".next", "BUILD_ID"), Date.now())
    expect((await NEXT_ADAPTER.inspectBuild(root))?.kind).toBe("server")
  })

  it("keeps reading an export newer than the server build as static", async () => {
    const root = await checkout({ out: true, buildId: true, nextBinary: true })
    await touch(join(root, ".next", "BUILD_ID"), Date.now() - 60_000)
    await touch(join(root, "out", "index.html"), Date.now())
    expect(await NEXT_ADAPTER.inspectBuild(root)).toEqual({
      kind: "static",
      outputDir: "out",
      reason: "Next.js static export",
    })
  })

  /**
   * Same timestamp, the same answer as before this comparison existed: an
   * export that left its dist dir behind as scratch is the case the tie
   * stands for, and reading it as static is what that case wants.
   */
  it("reads an export and a server build written at the same moment as static", async () => {
    const root = await checkout({ out: true, buildId: true, nextBinary: true })
    const when = Date.now()
    await touch(join(root, "out", "index.html"), when)
    await touch(join(root, ".next", "BUILD_ID"), when)
    expect((await NEXT_ADAPTER.inspectBuild(root))?.kind).toBe("static")
  })

  it("compares against a custom distDir's BUILD_ID too", async () => {
    const root = await checkout({ out: true, buildId: true, distDir: "build", nextBinary: true })
    await touch(join(root, "out", "index.html"), Date.now() - 60_000)
    await touch(join(root, "build", "BUILD_ID"), Date.now())
    expect((await NEXT_ADAPTER.inspectBuild(root))?.kind).toBe("server")
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

  /**
   * Codex round 29, item 1. `dependsOn` used to read only the workspace
   * root's `package.json`. In an npm or pnpm workspace `next` is declared in
   * the app package's own `package.json` (`apps/web/package.json`), so a
   * checkout where the root lists nothing fell through to the static
   * default and then failed on a missing `index.html`.
   */
  it("recognises next declared only in the app package's package.json in a workspace", async () => {
    const shape = await NEXT_ADAPTER.inspectBuild(
      await checkout({
        next: false,
        distDir: "apps/web",
        buildId: true,
        nextBinary: true,
        appPackageJson: { next: "^16.0.0" },
      }),
    )
    expect(shape?.kind).toBe("server")
  })

  it("still answers null when neither the root nor the app package lists next", async () => {
    const shape = await NEXT_ADAPTER.inspectBuild(
      await checkout({ next: false, distDir: "apps/web", buildId: true, nextBinary: true }),
    )
    expect(shape).toBeNull()
  })
})

/**
 * Codex round 30. The export check read only the root `out/`, so a
 * workspace app that exported (`apps/web/out`) beside its scratch
 * `apps/web/.next` was recorded as a server and `next start` refused the
 * export. The export is found wherever it landed, and the static answer
 * names that folder.
 */
describe("Next.js adapter — export in a workspace app", () => {
  it("reads apps/web/out beside apps/web/.next as a static export of that folder", async () => {
    const shape = await NEXT_ADAPTER.inspectBuild(
      await checkout({
        next: false,
        distDir: "apps/web/.next",
        buildId: true,
        out: true,
        exportDir: "apps/web/out",
        nextBinary: true,
        appPackageJson: { next: "^16.0.0" },
      }),
    )
    expect(shape).toEqual({ kind: "static", outputDir: join("apps", "web", "out"), reason: "Next.js static export" })
  })

  it("reads apps/web/out with no dist dir at all as a static export when the app package lists next", async () => {
    const root = await checkout({ next: false, out: true, exportDir: "apps/web/out" })
    await writeFile(join(root, "apps", "web", "package.json"), JSON.stringify({ name: "web", dependencies: { next: "^16.0.0" } }))
    expect(await NEXT_ADAPTER.inspectBuild(root)).toEqual({
      kind: "static",
      outputDir: join("apps", "web", "out"),
      reason: "Next.js static export",
    })
  })

  it("still answers null for apps/web/out when nothing lists next", async () => {
    expect(await NEXT_ADAPTER.inspectBuild(await checkout({ next: false, out: true, exportDir: "apps/web/out" }))).toBeNull()
  })

  it("compares the nested export against the nested BUILD_ID, so a newer server build wins", async () => {
    const root = await checkout({
      next: false,
      distDir: "apps/web/.next",
      buildId: true,
      out: true,
      exportDir: "apps/web/out",
      nextBinary: true,
      appPackageJson: { next: "^16.0.0" },
    })
    await touch(join(root, "apps", "web", "out", "index.html"), 1_000_000)
    await touch(join(root, "apps", "web", ".next", "BUILD_ID"), 2_000_000)
    expect((await NEXT_ADAPTER.inspectBuild(root))?.kind).toBe("server")
  })
})

/**
 * Codex round 29, item 2. `next start` with no directory argument reads the
 * ROOT `next.config` and `.next`. When the found dist dir belongs to a
 * DIFFERENT package in a workspace (its own `package.json` declares
 * `next` — the same marker item 1 reads, and what tells a real workspace
 * app apart from a checkout that merely configured a custom, nested
 * `distDir` at the root), starting `next start` with no argument boots the
 * wrong app. The app directory must be passed as the command's positional
 * argument, and the binary preferred is the app's own
 * `node_modules/.bin/next` when the workspace installed one there.
 */
describe("Next.js adapter — nested app directory", () => {
  it("starts from the app directory, preferring the app's own next binary", async () => {
    const shape = await NEXT_ADAPTER.inspectBuild(
      await checkout({
        distDir: "apps/web",
        buildId: true,
        nextBinary: true,
        appNextBinary: true,
        appPackageJson: { next: "^16.0.0" },
      }),
    )
    expect(shape).toEqual({
      kind: "server",
      start: [join("apps", "node_modules", ".bin", "next"), "start", "-p", "$PORT", "-H", "127.0.0.1", "apps"],
      reason: "Next.js with server-rendered routes",
    })
  })

  it("falls back to the root next binary when the app directory has none", async () => {
    const shape = await NEXT_ADAPTER.inspectBuild(
      await checkout({ distDir: "apps/web", buildId: true, nextBinary: true, appPackageJson: { next: "^16.0.0" } }),
    )
    expect(shape).toEqual({
      kind: "server",
      start: ["node_modules/.bin/next", "start", "-p", "$PORT", "-H", "127.0.0.1", "apps"],
      reason: "Next.js with server-rendered routes",
    })
  })

  it("reports unsupported when neither the app directory nor the root has a next binary", async () => {
    const shape = await NEXT_ADAPTER.inspectBuild(
      await checkout({ distDir: "apps/web", buildId: true, appPackageJson: { next: "^16.0.0" } }),
    )
    expect(shape).toEqual({
      kind: "unsupported",
      reason: "This Next.js build needs the next package installed to run.",
    })
  })

  it("does not nest the argv when the dist dir is nested only by a custom distDir (no app package.json)", async () => {
    const shape = await NEXT_ADAPTER.inspectBuild(await checkout({ distDir: "build/next", buildId: true, nextBinary: true }))
    expect(shape).toEqual({
      kind: "server",
      start: ["node_modules/.bin/next", "start", "-p", "$PORT", "-H", "127.0.0.1"],
      reason: "Next.js with server-rendered routes",
    })
  })

  /**
   * Codex round 31. A workspace app with `distDir: "build/next"` in its own
   * `next.config`: the dist dir is four segments down and its OWNER is the
   * app package two levels up, not the `build` directory in between.
   */
  it("starts a workspace app with a custom nested distDir from the app directory", async () => {
    const shape = await NEXT_ADAPTER.inspectBuild(
      await checkout({
        next: false,
        distDir: "apps/web/build/next",
        buildId: true,
        appDir: "apps/web",
        appNextBinary: true,
        appPackageJson: { next: "^16.0.0" },
      }),
    )
    expect(shape).toMatchObject({
      kind: "server",
      start: [join("apps", "web", "node_modules", ".bin", "next"), "start", "-p", "$PORT", "-H", "127.0.0.1", join("apps", "web")],
    })
  })

  it("leaves a root-level build's argv unchanged (no app directory appended)", async () => {
    const shape = await NEXT_ADAPTER.inspectBuild(await checkout({ buildId: true, nextBinary: true }))
    expect(shape).toEqual({
      kind: "server",
      start: ["node_modules/.bin/next", "start", "-p", "$PORT", "-H", "127.0.0.1"],
      reason: "Next.js with server-rendered routes",
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

  /**
   * Codex round 30. The standalone server resolves `/_next/static` under
   * the FULL configured dist dir (`build/next`), so the copy has to land at
   * `standalone/build/next/static`; the dist dir's last segment alone put
   * it at `standalone/next/static` and every asset request answered 404.
   */
  it("prepare() keeps a nested custom distDir's full path under the standalone dir", async () => {
    const root = await checkout({ buildId: true, standalone: true, distDir: "build/next", staticDir: true })
    const shape = await NEXT_ADAPTER.inspectBuild(root)
    if (shape?.kind !== "server" || !shape.prepare) throw new Error("expected a standalone server shape with prepare")
    await shape.prepare(root)

    expect(await exists(join(root, "build", "next", "standalone", "build", "next", "static", "chunk.js"))).toBe(true)
    expect(await exists(join(root, "build", "next", "standalone", "next", "static"))).toBe(false)
  })

  it("prepare() keeps a workspace app's custom nested distDir path under its standalone dir (codex round 31)", async () => {
    const root = await checkout({
      next: false,
      distDir: "apps/web/build/next",
      buildId: true,
      standalone: true,
      staticDir: true,
      appDir: "apps/web",
      appPackageJson: { next: "^16.0.0" },
    })
    const shape = await NEXT_ADAPTER.inspectBuild(root)
    if (shape?.kind !== "server" || !shape.prepare) throw new Error("expected a standalone server shape with prepare")
    await shape.prepare(root)

    expect(
      await exists(join(root, "apps", "web", "build", "next", "standalone", "build", "next", "static", "chunk.js")),
    ).toBe(true)
  })

  it("prepare() copies a workspace app's static under its app-relative dist dir name", async () => {
    const root = await checkout({
      next: false,
      distDir: "apps/web/.next",
      buildId: true,
      standalone: true,
      staticDir: true,
      appPackageJson: { next: "^16.0.0" },
    })
    const shape = await NEXT_ADAPTER.inspectBuild(root)
    if (shape?.kind !== "server" || !shape.prepare) throw new Error("expected a standalone server shape with prepare")
    await shape.prepare(root)

    expect(await exists(join(root, "apps", "web", ".next", "standalone", ".next", "static", "chunk.js"))).toBe(true)
  })
})

/**
 * Codex round 29, item 3. With `output: "standalone"` and
 * `outputFileTracingRoot` set to the monorepo root, Next writes the
 * launcher one level deeper, at `<distDir>/standalone/<relativeAppDir>/server.js`
 * — `relativeAppDir` is read out of `required-server-files.json`, and an
 * absent or empty value means the app IS the tracing root (the plain case
 * above). Verified against a live report of the real directory layout
 * (github.com/vercel/next.js discussion #35437): `server.js`,
 * `<distDir>/static`, and `public/` all end up nested under the app's own
 * directory inside `standalone/`. The exact `relativeAppDir` field name in
 * `required-server-files.json` is taken from this brief; it was not
 * independently found in a primary source during this pass.
 */
describe("Next.js adapter — output: \"standalone\" with a tracing-root relativeAppDir", () => {
  it("detects the launcher nested under relativeAppDir and records it as the start command", async () => {
    const root = await checkout({ buildId: true })
    await writeFile(
      join(root, ".next", "required-server-files.json"),
      JSON.stringify({ relativeAppDir: "apps/web" }),
    )
    await mkdir(join(root, ".next", "standalone", "apps", "web"), { recursive: true })
    await writeFile(join(root, ".next", "standalone", "apps", "web", "server.js"), "// standalone server")

    const shape = await NEXT_ADAPTER.inspectBuild(root)
    expect(shape).toMatchObject({
      kind: "server",
      start: ["node", join(".next", "standalone", "apps", "web", "server.js")],
      reason: "Next.js standalone output",
    })
  })

  it("prepare() copies static and public under the relativeAppDir's own standalone subtree", async () => {
    const root = await checkout({ buildId: true, staticDir: true, publicDir: true })
    await writeFile(
      join(root, ".next", "required-server-files.json"),
      JSON.stringify({ relativeAppDir: "apps/web" }),
    )
    await mkdir(join(root, ".next", "standalone", "apps", "web"), { recursive: true })
    await writeFile(join(root, ".next", "standalone", "apps", "web", "server.js"), "// standalone server")

    const shape = await NEXT_ADAPTER.inspectBuild(root)
    if (shape?.kind !== "server" || !shape.prepare) throw new Error("expected a standalone server shape with prepare")
    await shape.prepare(root)

    expect(await exists(join(root, ".next", "standalone", "apps", "web", ".next", "static", "chunk.js"))).toBe(true)
    expect(await exists(join(root, ".next", "standalone", "apps", "web", "public", "favicon.ico"))).toBe(true)
  })

  it("keeps the plain (no tracing root) case unchanged when relativeAppDir is present but empty", async () => {
    const root = await checkout({ buildId: true, standalone: true })
    await writeFile(join(root, ".next", "required-server-files.json"), JSON.stringify({ relativeAppDir: "" }))

    const shape = await NEXT_ADAPTER.inspectBuild(root)
    expect(shape).toMatchObject({
      kind: "server",
      start: ["node", join(".next", "standalone", "server.js")],
      reason: "Next.js standalone output",
    })
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
