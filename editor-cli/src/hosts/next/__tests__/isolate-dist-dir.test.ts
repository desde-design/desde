/**
 * The two seams that let Editor's Next run beside the project's own.
 *
 * The distDir half is small and its failure is loud-ish (a lock collision the
 * user sees). The type-setup half is the one to be careful with: if the
 * redirect does not reach the function the bundler calls, the boot is healthy
 * and two of the user's tracked files are rewritten. So the redirect is tested
 * through a real module on disk, loaded through a SECOND `createRequire` from
 * a different base — which is how the bundler reaches it — and asserted by
 * what that function receives, not by what was installed.
 */
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises"
import type { FSWatcher } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  EDITOR_NEXT_DIST_ROOT,
  isolateDistDir,
  guardBuildRoot,
  guardBuildTree,
  mirrorTypeDeclarations,
  probeTypeSetupRedirect,
  rebaseRelativeSpecifiers,
  redirectTypeSetup,
  restoreDistDir,
  type WatchFn,
} from "../isolate-dist-dir.js"
import type { NextConfigObject } from "../prime-config.js"

describe("isolateDistDir", () => {
  // Only the overlap rule reads it; every other case is pure string work.
  const ROOT = join("/", "p")

  it("mirrors Next's <root>/dev split onto Editor's own directory, writing both fields", () => {
    const conf: NextConfigObject = { distDir: join(".next", "dev"), distDirRoot: ".next" }
    const result = isolateDistDir(conf, ROOT)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.original).toEqual({ distDir: join(".next", "dev"), distDirRoot: ".next" })
    expect(conf.distDirRoot).toBe(EDITOR_NEXT_DIST_ROOT)
    expect(conf.distDir).toBe(join(EDITOR_NEXT_DIST_ROOT, "dev"))
    expect(EDITOR_NEXT_DIST_ROOT).toBe(join(".desde", "next"))
  })

  it("carries a custom distDir's suffix over rather than assuming 'dev'", () => {
    const conf: NextConfigObject = { distDir: join("build", "out"), distDirRoot: "build" }
    const result = isolateDistDir(conf, ROOT)
    expect(result.ok).toBe(true)
    expect(conf.distDir).toBe(join(EDITOR_NEXT_DIST_ROOT, "out"))
  })

  it("restores the original pair, so probe leaves the memo as it found it", () => {
    const conf: NextConfigObject = { distDir: join(".next", "dev"), distDirRoot: ".next" }
    const iso = isolateDistDir(conf, ROOT)
    if (!iso.ok) throw new Error("isolate failed")
    const back = restoreDistDir(conf, iso.original)
    expect(back.ok).toBe(true)
    expect(conf).toEqual({ distDir: join(".next", "dev"), distDirRoot: ".next" })
  })

  it("refuses a config whose distDir fields are not strings", () => {
    const result = isolateDistDir({ distDir: 42, distDirRoot: ".next" }, ROOT)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe("seam-shape-changed")
    expect(result.failure.seam?.id).toContain("distDir")
  })

  it("refuses a distDir that is not inside its root, rather than guessing", () => {
    const result = isolateDistDir({ distDir: "elsewhere", distDirRoot: ".next" }, ROOT)
    expect(result.ok).toBe(false)
  })

  it("refuses when the write does not land (frozen config)", () => {
    const conf = Object.freeze({ distDir: join(".next", "dev"), distDirRoot: ".next" }) as NextConfigObject
    const result = isolateDistDir(conf, ROOT)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe("seam-shape-changed")
  })

  it("rolls the first field back when the second write fails, so a refusal leaves the memo whole", () => {
    const conf: NextConfigObject = { distDir: join(".next", "dev") }
    Object.defineProperty(conf, "distDirRoot", {
      get: () => ".next",
      set: () => {
        throw new TypeError("nope")
      },
      enumerable: true,
    })
    const result = isolateDistDir(conf, ROOT)
    expect(result.ok).toBe(false)
    expect(conf.distDir).toBe(join(".next", "dev"))
    expect(conf.distDirRoot).toBe(".next")
  })

  it("refuses a project that already builds inside Editor's own build directory", () => {
    // `distDir: ".desde/next"` in next.config: Next's dev rewrite makes the
    // pair `.desde/next` + `.desde/next/dev`, which is EXACTLY what isolation
    // would compute. Silently no isolation at all, and a log line claiming it.
    const conf: NextConfigObject = { distDir: join(".desde", "next", "dev"), distDirRoot: join(".desde", "next") }
    const result = isolateDistDir(conf, ROOT)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe("boot-failed")
    expect(result.failure.attachCovers).toBe(true)
    // And the memo is left as Next resolved it.
    expect(conf).toEqual({ distDir: join(".desde", "next", "dev"), distDirRoot: join(".desde", "next") })
  })

  it("refuses a project whose build directory CONTAINS Editor's, too", () => {
    const conf: NextConfigObject = { distDir: join(".desde", "dev"), distDirRoot: ".desde" }
    const result = isolateDistDir(conf, ROOT)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe("boot-failed")
  })

  it("does not mistake a sibling with a shared prefix for an overlap", () => {
    const conf: NextConfigObject = { distDir: join(".desde-build", "dev"), distDirRoot: ".desde-build" }
    expect(isolateDistDir(conf, ROOT).ok).toBe(true)
  })

  it("refuses when an accessor swallows the write while preserving identity", () => {
    const conf: NextConfigObject = { distDirRoot: ".next" }
    Object.defineProperty(conf, "distDir", {
      get: () => join(".next", "dev"),
      set: () => {},
      enumerable: true,
    })
    const result = isolateDistDir(conf, ROOT)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.cause).toContain("read back")
  })
})

describe("isolateDistDir — aliases of Editor's own directory", () => {
  let root: string
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "desde-next-alias-")))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it("refuses a distDir that is a symlink to .desde/next, however it is spelled", async () => {
    await mkdir(join(root, ".desde", "next"), { recursive: true })
    await symlink(join(root, ".desde", "next"), join(root, "build"))
    const result = isolateDistDir({ distDir: join("build", "dev"), distDirRoot: "build" }, root)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.cause).toContain("overlaps Editor's own build directory")
  })

  it("refuses a symlink alias whose final components do not exist yet", async () => {
    // `build -> .desde`, distDirRoot `build/next`, and no `.desde/next` on disk:
    // realpath of the whole path throws, but the ancestor resolves.
    await mkdir(join(root, ".desde"))
    await symlink(join(root, ".desde"), join(root, "build"))
    const result = isolateDistDir({ distDir: join("build", "next", "dev"), distDirRoot: join("build", "next") }, root)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.cause).toContain("overlaps Editor's own build directory")
  })

  it("refuses a differently-cased spelling on a case-insensitive filesystem", async () => {
    if (process.platform !== "darwin" && process.platform !== "win32") return
    await mkdir(join(root, ".desde", "next"), { recursive: true })
    const result = isolateDistDir({ distDir: join(".DESDE", "next", "dev"), distDirRoot: join(".DESDE", "next") }, root)
    expect(result.ok).toBe(false)
  })

  it("still accepts the ordinary .next beside an existing .desde/next", async () => {
    await mkdir(join(root, ".desde", "next"), { recursive: true })
    await mkdir(join(root, ".next", "dev"), { recursive: true })
    expect(isolateDistDir({ distDir: join(".next", "dev"), distDirRoot: ".next" }, root).ok).toBe(true)
  })
})

describe("redirectTypeSetup", () => {
  let root: string
  let install: { root: string }
  let modulePath: string

  beforeEach(async () => {
    // realpath: macOS's tmpdir is a symlink, and Node resolves symlinks when
    // it resolves modules. `resolveNextInstall` derives the root from a
    // resolved path too, so the containment check compares like with like.
    root = await realpath(await mkdtemp(join(tmpdir(), "desde-next-typesetup-")))
    install = { root: join(root, "node_modules", "next") }
    modulePath = join(install.root, "dist", "lib", "verify-typescript-setup.js")
    await mkdir(join(install.root, "dist", "lib"), { recursive: true })
    await writeFile(join(install.root, "package.json"), JSON.stringify({ name: "next", version: "16.3.4" }))
    // The exact export shape SWC emits for Next: non-configurable getters.
    await writeFile(
      modulePath,
      `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
function _export(target, all) {
  for (var name in all) Object.defineProperty(target, name, { enumerable: true, get: all[name] });
}
_export(exports, {
  verifyAndRunTypeScript: function() { return verifyAndRunTypeScript; },
  verifyAndRunTypeScriptInWorker: function() { return verifyAndRunTypeScriptInWorker; },
});
async function verifyAndRunTypeScript(opts) { return { received: opts, via: "main" }; }
async function verifyAndRunTypeScriptInWorker(opts) { return { received: opts, via: "worker" }; }
`,
    )
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "fixture" }))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it("hands the bundler's own require the wrapper, and the wrapper hands the function the ORIGINAL distDir", async () => {
    const hostRequire = createRequire(join(root, "package.json"))
    const result = redirectTypeSetup(hostRequire, install, join(".next", "dev"))
    expect(result.ok).toBe(true)

    // How `setup-dev-bundler.js` reaches it: a relative specifier from deep
    // inside the package, through its own require, landing on the same file.
    const bundlerRequire = createRequire(join(install.root, "dist", "server", "lib", "router-utils", "x.js"))
    const mod = bundlerRequire("../../../lib/verify-typescript-setup") as {
      verifyAndRunTypeScript: (o: unknown) => Promise<{ received: { distDir: string; dir: string }; via: string }>
      verifyAndRunTypeScriptInWorker: (o: unknown) => Promise<{ received: { distDir: string }; via: string }>
      __esModule: boolean
    }
    const main = await mod.verifyAndRunTypeScript({ dir: "/proj", distDir: join(".desde", "next", "dev") })
    expect(main.received.distDir).toBe(join(".next", "dev"))
    expect(main.received.dir).toBe("/proj")
    expect(main.via).toBe("main")
    const worker = await mod.verifyAndRunTypeScriptInWorker({ distDir: join(".desde", "next", "dev") })
    expect(worker.received.distDir).toBe(join(".next", "dev"))
    expect(mod.__esModule).toBe(true)
  })

  it("the probe swaps, proves, and puts the original back", async () => {
    const hostRequire = createRequire(join(root, "package.json"))
    const before = hostRequire(modulePath)
    const result = probeTypeSetupRedirect(hostRequire, install)
    expect(result.ok).toBe(true)
    expect(hostRequire(modulePath)).toBe(before)
    const mod = hostRequire(modulePath) as {
      verifyAndRunTypeScript: (o: unknown) => Promise<{ received: { distDir: string } }>
    }
    const out = await mod.verifyAndRunTypeScript({ distDir: "untouched" })
    expect(out.received.distDir).toBe("untouched")
  })

  it("refuses when the module is gone, naming the seam", async () => {
    await rm(modulePath)
    const hostRequire = createRequire(join(root, "package.json"))
    const result = redirectTypeSetup(hostRequire, install, ".next/dev")
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe("seam-missing")
    expect(result.failure.seam?.id).toBe("next/dist/lib/verify-typescript-setup")
  })

  it("refuses when the export is no longer a function", async () => {
    await writeFile(modulePath, `exports.verifyAndRunTypeScript = 42;`)
    const hostRequire = createRequire(join(root, "package.json"))
    const result = redirectTypeSetup(hostRequire, install, ".next/dev")
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe("seam-shape-changed")
  })

  it("refuses a module that resolves back OUT of the installation", async () => {
    // A package.json at the anchored path whose `main` escapes the root.
    await rm(modulePath)
    await mkdir(join(install.root, "dist", "lib", "verify-typescript-setup"), { recursive: true })
    await writeFile(
      join(install.root, "dist", "lib", "verify-typescript-setup", "package.json"),
      JSON.stringify({ main: "../../../../../elsewhere.js" }),
    )
    await writeFile(join(root, "elsewhere.js"), `exports.verifyAndRunTypeScript = function () {};`)
    const hostRequire = createRequire(join(root, "package.json"))
    const result = redirectTypeSetup(hostRequire, install, ".next/dev")
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.cause).toContain("not under")
  })
})

describe("mirrorTypeDeclarations", () => {
  let root: string
  const FROM = join(".desde", "next", "dev")
  const TO = join(".next", "dev")

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "desde-next-typemirror-")))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  async function until(check: () => Promise<boolean>, what: string): Promise<void> {
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      if (await check()) return
      await new Promise((r) => setTimeout(r, 25))
    }
    throw new Error(`timed out waiting for ${what}`)
  }
  const exists = (p: string) =>
    stat(p).then(
      () => true,
      () => false,
    )

  it("copies what Editor's Next generated into the project's own types dir, and keeps it current", async () => {
    // The two files `next-env.d.ts` imports, one nested to prove recursion.
    await mkdir(join(root, FROM, "types", "app"), { recursive: true })
    await writeFile(join(root, FROM, "types", "routes.d.ts"), "declare const routes: 1\n")
    await writeFile(join(root, FROM, "types", "app", "page.ts"), "export {}\n")

    const mirror = await mirrorTypeDeclarations({ prototypeRoot: root, from: FROM, to: TO })
    try {
      // Initial sync is awaited, not watched.
      expect(await readFile(join(root, TO, "types", "routes.d.ts"), "utf8")).toBe("declare const routes: 1\n")
      expect(await readFile(join(root, TO, "types", "app", "page.ts"), "utf8")).toBe("export {}\n")

      // A regenerated file: the route the agent just added.
      await writeFile(join(root, FROM, "types", "routes.d.ts"), "declare const routes: 2\n")
      await until(
        async () => (await readFile(join(root, TO, "types", "routes.d.ts"), "utf8")) === "declare const routes: 2\n",
        "the regenerated routes.d.ts to be mirrored",
      )

      // A new file.
      await writeFile(join(root, FROM, "types", "validator.ts"), "export const v = 1\n")
      await until(() => exists(join(root, TO, "types", "validator.ts")), "a new file to be mirrored")

      // A deletion — a stale validator is a type error the user did not cause.
      await rm(join(root, FROM, "types", "validator.ts"))
      await until(async () => !(await exists(join(root, TO, "types", "validator.ts"))), "a deletion to be mirrored")
    } finally {
      mirror.stop()
    }
  })

  it("rebases the relative imports in a generated validator so they still reach the project", async () => {
    await mkdir(join(root, FROM, "types"), { recursive: true })
    await writeFile(
      join(root, FROM, "types", "validator.ts"),
      'import type { AppRoutes } from "./routes.js"\nconst h = {} as typeof import("../../../../src/app/page.js")\n',
    )
    const mirror = await mirrorTypeDeclarations({ prototypeRoot: root, from: FROM, to: TO })
    try {
      expect(await readFile(join(root, TO, "types", "validator.ts"), "utf8")).toBe(
        'import type { AppRoutes } from "./routes.js"\nconst h = {} as typeof import("../../../src/app/page.js")\n',
      )
    } finally {
      mirror.stop()
    }
  })

  it("prunes declarations the project's side has and Editor's does not, at full sync", async () => {
    await mkdir(join(root, FROM, "types"), { recursive: true })
    await writeFile(join(root, FROM, "types", "routes.d.ts"), "live\n")
    await mkdir(join(root, TO, "types", "app", "gone"), { recursive: true })
    await writeFile(join(root, TO, "types", "app", "gone", "page.ts"), "stale\n")
    const mirror = await mirrorTypeDeclarations({ prototypeRoot: root, from: FROM, to: TO })
    try {
      expect(await exists(join(root, TO, "types", "routes.d.ts"))).toBe(true)
      expect(await exists(join(root, TO, "types", "app", "gone", "page.ts"))).toBe(false)
    } finally {
      mirror.stop()
    }
  })

  it("does NOTHING when the project's .next is a symbolic link, so a prune can never leave the checkout", async () => {
    const outside = join(root, "outside")
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, "precious.ts"), "keep me\n")
    await mkdir(join(root, ".next"))
    await symlink(outside, join(root, ".next", "dev"))
    await mkdir(join(root, FROM, "types"), { recursive: true })
    await writeFile(join(root, FROM, "types", "routes.d.ts"), "x\n")
    const lines: string[] = []
    const mirror = await mirrorTypeDeclarations({ prototypeRoot: root, from: FROM, to: TO, log: (l) => lines.push(l) })
    try {
      expect(await exists(join(outside, "precious.ts"))).toBe(true)
      expect(await exists(join(outside, "types", "routes.d.ts"))).toBe(false)
      expect(lines.join("\n")).toContain("symbolic link")
    } finally {
      mirror.stop()
    }
  })

  it("does NOTHING when the project's distDir resolves outside the project", async () => {
    // `distDir: "../shared-build"` is a valid Next config; the mirror must not
    // copy into, or prune, a directory this checkout does not own.
    const project = join(root, "project")
    await mkdir(join(project, FROM, "types"), { recursive: true })
    await writeFile(join(project, FROM, "types", "routes.d.ts"), "x\n")
    await mkdir(join(root, "shared-build", "dev", "types"), { recursive: true })
    await writeFile(join(root, "shared-build", "dev", "types", "theirs.ts"), "keep\n")
    const lines: string[] = []
    const mirror = await mirrorTypeDeclarations({
      prototypeRoot: project,
      from: FROM,
      to: join("..", "shared-build", "dev"),
      log: (l) => lines.push(l),
    })
    try {
      expect(await exists(join(root, "shared-build", "dev", "types", "theirs.ts"))).toBe(true)
      expect(await exists(join(root, "shared-build", "dev", "types", "routes.d.ts"))).toBe(false)
      expect(lines.join("\n")).toContain("outside the project")
    } finally {
      mirror.stop()
    }
  })

  it("mirrors into an ABSOLUTE distDir as given, not prefixed with the project root again", async () => {
    await mkdir(join(root, FROM, "types"), { recursive: true })
    await writeFile(join(root, FROM, "types", "routes.d.ts"), "abs\n")
    const mirror = await mirrorTypeDeclarations({ prototypeRoot: root, from: FROM, to: join(root, ".next", "dev") })
    try {
      expect(await readFile(join(root, ".next", "dev", "types", "routes.d.ts"), "utf8")).toBe("abs\n")
      expect(await exists(join(root, root.slice(1), ".next"))).toBe(false)
    } finally {
      mirror.stop()
    }
  })

  it("does not prune when the source tree cannot be listed", async () => {
    await mkdir(join(root, FROM, "types"), { recursive: true })
    await mkdir(join(root, TO, "types"), { recursive: true })
    await writeFile(join(root, TO, "types", "routes.d.ts"), "theirs\n")
    await chmod(join(root, FROM, "types"), 0o000)
    let mirror: Awaited<ReturnType<typeof mirrorTypeDeclarations>> | null = null
    try {
      mirror = await mirrorTypeDeclarations({ prototypeRoot: root, from: FROM, to: TO })
      expect(await readFile(join(root, TO, "types", "routes.d.ts"), "utf8")).toBe("theirs\n")
    } finally {
      mirror?.stop()
      await chmod(join(root, FROM, "types"), 0o755)
    }
  })

  it("removes a whole route's declarations when its directory disappears", async () => {
    await mkdir(join(root, FROM, "types", "app", "gone"), { recursive: true })
    await writeFile(join(root, FROM, "types", "app", "gone", "page.ts"), "x\n")
    const mirror = await mirrorTypeDeclarations({ prototypeRoot: root, from: FROM, to: TO })
    try {
      expect(await exists(join(root, TO, "types", "app", "gone", "page.ts"))).toBe(true)
      await rm(join(root, FROM, "types", "app", "gone"), { recursive: true })
      await until(
        async () => !(await exists(join(root, TO, "types", "app", "gone", "page.ts"))),
        "the removed route's declaration to be pruned",
      )
    } finally {
      mirror.stop()
    }
  })

  it("reconciles on a DIRECTORY event, so a subtree that arrives at once is not missed", async () => {
    // Which events a recursive watcher emits is the platform's business: macOS
    // reports the children of a directory renamed into place, Linux need not.
    // So the shape that has to work is driven directly — one event naming the
    // directory, and nothing for the files already inside it. Per-file, that
    // event can only answer EISDIR; if it does not reconcile, those
    // declarations are never copied.
    await mkdir(join(root, FROM, "types"), { recursive: true })
    let fire: ((event: string, filename: string | Buffer | null) => void) | null = null
    const fakeWatch = ((_dir: string, _o: { recursive: true }, listener: (e: string, f: string | Buffer | null) => void) => {
      fire = listener
      return { close: () => undefined, on: () => undefined } as unknown as FSWatcher
    }) as WatchFn

    const mirror = await mirrorTypeDeclarations({ prototypeRoot: root, from: FROM, to: TO, watch: fakeWatch })
    try {
      await mkdir(join(root, FROM, "types", "app", "deep"), { recursive: true })
      await writeFile(join(root, FROM, "types", "app", "page.ts"), "export {}\n")
      await writeFile(join(root, FROM, "types", "app", "deep", "route.ts"), "export const r = 1\n")

      expect(fire).not.toBeNull()
      // The directory, and only the directory.
      fire!("rename", "app")

      await until(
        () => exists(join(root, TO, "types", "app", "page.ts")),
        "a child of a directory-only event to be mirrored",
      )
      await until(
        () => exists(join(root, TO, "types", "app", "deep", "route.ts")),
        "a nested child of a directory-only event to be mirrored",
      )
    } finally {
      mirror.stop()
    }
  })

  it("coalesces a burst of directory events into one full sync", async () => {
    await mkdir(join(root, FROM, "types"), { recursive: true })
    let fire: ((event: string, filename: string | Buffer | null) => void) | null = null
    const fakeWatch = ((_dir: string, _o: { recursive: true }, listener: (e: string, f: string | Buffer | null) => void) => {
      fire = listener
      return { close: () => undefined, on: () => undefined } as unknown as FSWatcher
    }) as WatchFn

    const mirror = await mirrorTypeDeclarations({ prototypeRoot: root, from: FROM, to: TO, watch: fakeWatch })
    try {
      for (let n = 0; n < 20; n += 1) {
        await mkdir(join(root, FROM, "types", `d${n}`), { recursive: true })
        await writeFile(join(root, FROM, "types", `d${n}`, "page.ts"), `export const n = ${n}\n`)
      }
      // Twenty directory events in one burst, plus a null-filename event.
      for (let n = 0; n < 20; n += 1) fire!("rename", `d${n}`)
      fire!("rename", null)

      // One full sync copies in readdir order, which is not numeric, so wait
      // for EVERY child rather than assuming the last-named one lands last.
      // Waiting for all of them also drains the queue before cleanup removes
      // the temp tree from under an in-flight copy.
      for (let n = 0; n < 20; n += 1) {
        await until(() => exists(join(root, TO, "types", `d${n}`, "page.ts")), `d${n} to be mirrored`)
      }
    } finally {
      mirror.stop()
    }
  })

  it("falls back to polling when the watcher dies after it was created", async () => {
    await mkdir(join(root, FROM, "types"), { recursive: true })
    let onError: ((err: Error) => void) | null = null
    const fakeWatch = ((_dir: string, _o: { recursive: true }) => {
      return {
        close: () => undefined,
        on: (event: string, cb: (err: Error) => void) => {
          if (event === "error") onError = cb
        },
      } as unknown as FSWatcher
    }) as WatchFn
    const lines: string[] = []
    const mirror = await mirrorTypeDeclarations({
      prototypeRoot: root,
      from: FROM,
      to: TO,
      watch: fakeWatch,
      pollIntervalMs: 20,
      log: (l) => lines.push(l),
    })
    try {
      expect(onError).not.toBeNull()
      onError!(new Error("ENOSPC: System limit for number of file watchers reached"))
      // No watcher event will ever fire for this write; only polling can see it.
      await writeFile(join(root, FROM, "types", "routes.d.ts"), "after the watcher died\n")
      await until(() => exists(join(root, TO, "types", "routes.d.ts")), "a write after the watcher died to be mirrored by polling")
      expect(lines.join("\n")).toContain("by polling instead")
    } finally {
      mirror.stop()
    }
  })

  it("still performs the initial copy when the watcher cannot be established", async () => {
    await mkdir(join(root, FROM, "types"), { recursive: true })
    await writeFile(join(root, FROM, "types", "routes.d.ts"), "generated during prepare\n")
    const lines: string[] = []
    const mirror = await mirrorTypeDeclarations({
      prototypeRoot: root,
      from: FROM,
      to: TO,
      log: (l) => lines.push(l),
      watch: () => {
        throw new Error("ENOSPC: System limit for number of file watchers reached")
      },
    })
    try {
      expect(await readFile(join(root, TO, "types", "routes.d.ts"), "utf8")).toBe("generated during prepare\n")
      expect(lines.join("\n")).toContain("by polling instead")
    } finally {
      mirror.stop()
    }
  })

  it("tolerates Editor's types dir not existing yet, and does not throw", async () => {
    const mirror = await mirrorTypeDeclarations({ prototypeRoot: root, from: FROM, to: TO })
    try {
      // It created the dir so the watcher could attach; the project's side is untouched.
      expect(await exists(join(root, FROM, "types"))).toBe(true)
      expect(await exists(join(root, TO))).toBe(false)
      await writeFile(join(root, FROM, "types", "routes.d.ts"), "late\n")
      await until(() => exists(join(root, TO, "types", "routes.d.ts")), "a file written after attach to be mirrored")
    } finally {
      mirror.stop()
    }
  })

  it("stops: a write after stop() is not mirrored", async () => {
    await mkdir(join(root, FROM, "types"), { recursive: true })
    const mirror = await mirrorTypeDeclarations({ prototypeRoot: root, from: FROM, to: TO })
    mirror.stop()
    await writeFile(join(root, FROM, "types", "routes.d.ts"), "after\n")
    await new Promise((r) => setTimeout(r, 300))
    expect(await exists(join(root, TO, "types", "routes.d.ts"))).toBe(false)
  })
})

describe("rebaseRelativeSpecifiers", () => {
  const TREE = "/p/.desde/next/dev/types"
  const FROM = `${TREE}/validator.ts`
  const TO = "/p/.next/dev/types/validator.ts"

  it("rebases every relative form Next emits, one level shallower", () => {
    const input = [
      'import type { AppRoutes } from "./routes.js"',
      'import "../../../../src/side-effect.js"',
      "const a = {} as typeof import('../../../../src/app/page.js')",
      'const b = import("../../../../src/app/(group)/[id]/page.js")',
      'import next from "next/types.js"',
    ].join("\n")
    expect(rebaseRelativeSpecifiers(input, FROM, TO, TREE)).toBe(
      [
        'import type { AppRoutes } from "./routes.js"',
        'import "../../../src/side-effect.js"',
        "const a = {} as typeof import('../../../src/app/page.js')",
        'const b = import("../../../src/app/(group)/[id]/page.js")',
        'import next from "next/types.js"',
      ].join("\n"),
    )
  })

  it("is the identity when source and target share a directory", () => {
    const input = 'import "../../../../x.js"'
    expect(rebaseRelativeSpecifiers(input, FROM, `${TREE}/other.ts`, TREE)).toBe(input)
  })
})

describe("guardBuildRoot", () => {
  let root: string
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "desde-next-buildroot-")))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it("accepts a missing or ordinary .desde/next", async () => {
    expect(guardBuildRoot(root).ok).toBe(true)
    await mkdir(join(root, ".desde", "next"), { recursive: true })
    expect(guardBuildRoot(root).ok).toBe(true)
  })

  it("refuses when .desde/next is a symbolic link, naming the segment", async () => {
    await mkdir(join(root, ".desde"))
    await mkdir(join(root, "elsewhere"))
    await symlink(join(root, "elsewhere"), join(root, ".desde", "next"))
    const result = guardBuildRoot(root)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.cause).toContain(".desde/next is a symbolic link")
    expect(result.failure.attachCovers).toBe(true)
  })

  it("refuses when only the dev suffix is a link, given the whole isolated path", async () => {
    // `.desde/next` real, `.desde/next/dev` a link back to `.next/dev`: the
    // exact shape that would quietly recreate the lock collision.
    await mkdir(join(root, ".desde", "next"), { recursive: true })
    await mkdir(join(root, ".next", "dev"), { recursive: true })
    await symlink(join(root, ".next", "dev"), join(root, ".desde", "next", "dev"))
    expect(guardBuildRoot(root, join(".desde", "next")).ok).toBe(true)
    const full = guardBuildRoot(root, join(".desde", "next", "dev"))
    expect(full.ok).toBe(false)
    if (full.ok) return
    expect(full.failure.cause).toContain(".desde/next/dev is a symbolic link")
  })

  it("refuses when .desde itself is the link", async () => {
    await mkdir(join(root, "elsewhere"))
    await symlink(join(root, "elsewhere"), join(root, ".desde"))
    expect(guardBuildRoot(root).ok).toBe(false)
  })
})

describe("guardBuildTree", () => {
  let root: string
  const exists = (p: string) =>
    stat(p).then(
      () => true,
      () => false,
    )
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "desde-next-buildtree-")))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it("accepts a missing tree, and an ordinary one", async () => {
    expect((await guardBuildTree(root)).ok).toBe(true)
    await mkdir(join(root, ".desde", "next", "dev", "types", "app"), { recursive: true })
    await writeFile(join(root, ".desde", "next", "dev", "types", "app", "page.ts"), "x\n")
    expect((await guardBuildTree(root)).ok).toBe(true)
  })

  it("removes a symlinked DESCENDANT the segment rule never looks at, leaving its target alone", async () => {
    // `.desde/next/dev` real, but `dev/types` a link out of the checkout:
    // every generated declaration would be written outside the project.
    await mkdir(join(root, ".desde", "next", "dev"), { recursive: true })
    await mkdir(join(root, "outside"))
    await writeFile(join(root, "outside", "keep.txt"), "mine\n")
    await symlink(join(root, "outside"), join(root, ".desde", "next", "dev", "types"))
    // The segment rule alone still passes — that is the hole being closed.
    expect(guardBuildRoot(root, join(".desde", "next", "dev")).ok).toBe(true)

    const said: string[] = []
    const result = await guardBuildTree(root, join(".desde", "next", "dev"), (line) => said.push(line))
    expect(result.ok).toBe(true)
    // The link is gone; what it pointed at is not.
    expect(await exists(join(root, ".desde", "next", "dev", "types"))).toBe(false)
    expect(await readFile(join(root, "outside", "keep.txt"), "utf8")).toBe("mine\n")
    expect(said.join("\n")).toContain(join(".desde", "next", "dev", "types"))
  })

  it("removes a link nested several levels down", async () => {
    await mkdir(join(root, ".desde", "next", "dev", "server", "app"), { recursive: true })
    await mkdir(join(root, "outside"))
    await symlink(join(root, "outside"), join(root, ".desde", "next", "dev", "server", "app", "chunks"))
    expect((await guardBuildTree(root, join(".desde", "next", "dev"))).ok).toBe(true)
    expect(await exists(join(root, ".desde", "next", "dev", "server", "app", "chunks"))).toBe(false)
    // The real directory around it survives.
    expect(await exists(join(root, ".desde", "next", "dev", "server", "app"))).toBe(true)
  })

  it("does not loop: a second open of a tree it already tidied is clean", async () => {
    await mkdir(join(root, ".desde", "next", "dev"), { recursive: true })
    await mkdir(join(root, "outside"))
    await symlink(join(root, "outside"), join(root, ".desde", "next", "dev", "types"))
    expect((await guardBuildTree(root, join(".desde", "next", "dev"))).ok).toBe(true)
    const said: string[] = []
    expect((await guardBuildTree(root, join(".desde", "next", "dev"), (l) => said.push(l))).ok).toBe(true)
    expect(said).toEqual([])
  })

  it("refuses when the link cannot be removed, rather than booting over it", async () => {
    await mkdir(join(root, ".desde", "next", "dev", "held"), { recursive: true })
    await mkdir(join(root, "outside"))
    await symlink(join(root, "outside"), join(root, ".desde", "next", "dev", "held", "types"))
    await chmod(join(root, ".desde", "next", "dev", "held"), 0o555)
    try {
      const result = await guardBuildTree(root, join(".desde", "next", "dev"))
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.failure.code).toBe("boot-failed")
      expect(result.failure.attachCovers).toBe(true)
      expect(result.failure.cause).toContain("Removing it failed")
    } finally {
      await chmod(join(root, ".desde", "next", "dev", "held"), 0o755)
    }
  })

  it("still refuses the segment rule's own shapes", async () => {
    await mkdir(join(root, "elsewhere"))
    await mkdir(join(root, ".desde"))
    await symlink(join(root, "elsewhere"), join(root, ".desde", "next"))
    expect((await guardBuildTree(root)).ok).toBe(false)
  })

  it("refuses when the tree cannot be listed, rather than assuming it is clean", async () => {
    await mkdir(join(root, ".desde", "next", "dev"), { recursive: true })
    await chmod(join(root, ".desde", "next"), 0o000)
    try {
      const result = await guardBuildTree(root, join(".desde", "next", "dev"))
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.failure.code).toBe("boot-failed")
    } finally {
      await chmod(join(root, ".desde", "next"), 0o755)
    }
  })
})
