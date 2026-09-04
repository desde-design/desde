import { createHash } from "node:crypto"
import { promises as fs } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join, relative, resolve } from "node:path"
import { build } from "vite"
import { desdePathOrNull } from "../../../src/editor/worktree/desde-dir.js"
import type { RequiredStamperFile } from "../attach-preflight/index.js"
import {
  resolveEditorCliPackageJson,
  resolveStampersDir,
} from "../payload-paths.js"

/**
 * Bundles the stampers to a destination the caller chooses.
 *
 * **Why the CLI writes them at all.** "Add our plugin to your config" presumes
 * a published package, and there isn't one: `editor-cli`'s build script is
 * `build:ui` only and the plugins are TypeScript source with no entry point.
 * v1 keeps distribution internal — the CLI drops a bundle where the consumer
 * can reach it and points the consumer at a path that never moves.
 *
 * **Two consumers, two destinations** — see {@link WriteStampersRequest.destDir}.
 * Attach mode writes into the prototype (its generated config block, which the
 * user commits, imports the file by relative path); the in-process Next host
 * writes into a per-user cache dir, because the entire value of booting
 * in-process is that the customer's repository is untouched.
 *
 * **Why bundled at boot rather than shipped as a build artifact.** The
 * requirement is that the stamper the user's dev server loads is built from the
 * CURRENT plugin source, and a checked-in artifact cannot promise that: nothing
 * in this repo rebuilds one automatically (see `dist/bridge-bundle.js`, which
 * has exactly this failure mode and needs a documented manual ritual to avoid
 * it). `editor-cli` also has no build step for `src/` at all — it runs from
 * TypeScript through `tsx` — so an artifact would be the only compiled output
 * in the package and the only thing that could silently go stale. Bundling here
 * makes freshness structural instead of procedural.
 *
 * **Why Vite's bundler and not esbuild.** `vite` is already a direct dependency
 * (it *is* the supervisor). `esbuild` is not, and is not reachable transitively
 * either — Vite 8 bundles with rolldown — so the esbuild route would mean
 * adding a dependency to serve one code path.
 *
 * MEASURED on this machine: a cold bundle of the Vue lane is ~520ms and 310KB;
 * with the content-hash cache below, an unchanged boot re-writes nothing.
 */

/** Cache format version — bump to force every prototype to rebuild once. */
const BUILD_INFO_VERSION = 1
const BUILD_INFO_NAME = ".build-info.json"

/**
 * `@vue/compiler-sfc` stays external. Everything else — including
 * `@babel/parser`, which a Next project has no reason to install — is inlined.
 *
 * **Externalising it is not a size preference, it is the only thing that
 * works.** MEASURED: inlining it yields a 1.59MB bundle that does not load at
 * all. `@vue/compiler-sfc` reaches `consolidate` for custom-block
 * preprocessing, `consolidate` `require`s two dozen optional template engines
 * (`velocityjs`, `mustache`, `marko`, …), and the CommonJS-to-ESM interop
 * hoists every one of those to a top-level static `import` — so the first line
 * of the generated stamper throws `ERR_MODULE_NOT_FOUND: velocityjs`. Kept
 * external it is 308KB and 271ms, and the import resolves from the prototype's
 * own `node_modules`, where `vue` (which declares `@vue/compiler-sfc` as a
 * direct dependency) put it.
 *
 * The React lane never touches this: the two lanes are separate bundles
 * precisely so the Vue compiler cannot leak into a React-only project.
 */
const EXTERNAL_PACKAGES = ["@vue/compiler-sfc"]
const EXTERNAL = [/^@vue\/compiler-sfc(\/|$)/]

interface EntrySpec {
  /** Absolute path to the bundle entry under `src/attach/stampers/`. */
  entry: string
  format: "es" | "cjs"
}

export interface WriteStampersRequest {
  /**
   * Directory each `file.path` is resolved against.
   *
   * **Attach mode passes the prototype root**, because its generated config
   * block imports the stamper with a path relative to the config file — so the
   * bundle has to live under the directory that config sits in, and
   * `stamper-files.ts` fixes that at `.desde/stamp/`.
   *
   * **The in-process Next host passes a per-user cache dir**, outside the
   * repository entirely. It registers the loader by absolute path in a
   * `turbopack.rules` entry we build in memory, so nothing needs the file to be
   * reachable by a relative path — and writing into the customer's repo to boot
   * a server in their process would give back the one thing in-process boot
   * exists to provide. MEASURED on a pristine Next 16.3.0 fixture
   * (`tasks/dev-server-hosts.md` § 2, "Where the in-process Next loader file
   * lives"): a loader bundled to a cache dir outside the project, with
   * `turbopack.root` left at its default, stamps every route repo-relatively
   * and writes nothing into the repo.
   *
   * Was `prototypeRoot`. The rename is the whole point: the destination is a
   * caller's choice, and the old name asserted an answer.
   */
  destDir: string
  /** Exactly what the preflight declared it needs. */
  files: readonly RequiredStamperFile[]
}

export interface WriteStampersResult {
  /** Paths relative to `destDir`, in the order requested. */
  written: string[]
  /** False when every output was already current and nothing was re-bundled. */
  rebuilt: boolean
  /** Conditions the caller should surface but that do not block a boot. */
  warnings: string[]
  ms: number
}

/**
 * The absolute path a stamper file should be written to, or `null` when it
 * lives under a `.desde` that is a symbolic link.
 *
 * Only paths that actually start with `.desde` are guarded — the Next lane
 * writes its loader into a per-user cache directory outside the repository,
 * and that has no `.desde` to check.
 */
function guardedTarget(destDir: string, filePath: string): string | null {
  const segments = filePath.split(/[\\/]+/).filter((s) => s.length > 0)
  if (segments[0] !== ".desde") return resolve(destDir, filePath)
  return desdePathOrNull(destDir, ...segments.slice(1))
}

export async function writeStamperFiles(
  req: WriteStampersRequest,
): Promise<WriteStampersResult> {
  const started = Date.now()
  const written: string[] = []
  const warnings: string[] = []
  let rebuilt = false

  for (const file of req.files) {
    // `.desde/…` paths go through the guard; anything else (the Next lane's
    // per-user cache dir, which is not in the repo at all) is resolved as
    // before. A prototype that ships `.desde` — or `.desde/stamp` — as a
    // symbolic link would otherwise have its generated source-tag plugins
    // written outside the working tree. Refusing is reported through the
    // `warnings` channel this function already returns, because this runs on
    // the boot path: the user gets an editor without stamping, not a CLI
    // that will not start.
    const target = guardedTarget(req.destDir, file.path)
    if (target === null) {
      warnings.push(
        `Refusing to write '${file.path}': '.desde' in this project is a symbolic link, so Desde cannot install its source-tag helpers.`,
      )
      continue
    }
    await fs.mkdir(dirname(target), { recursive: true })

    if (file.role === "type-declaration") {
      // Not bundled: a hand-written declaration, because a `.d.mts` generated
      // from the plugin's own types would drag in Vite's, and a prototype may
      // not have Vite installed at all (Nuxt's dashboard template does not).
      await writeAtomic(target, declarationSource())
    } else {
      rebuilt = (await bundleTo(target, specFor(file))) || rebuilt
      warnings.push(...missingExternals(req.destDir, file))
    }
    written.push(file.path)
  }

  return { written, rebuilt, warnings, ms: Date.now() - started }
}

/**
 * The one import the stamper does not carry with it has to resolve from where
 * the bundle lands, and that depends on the package manager's hoisting: npm and
 * yarn put a transitive `@vue/compiler-sfc` at the top level, pnpm does not.
 *
 * The base is `destDir` rather than a separately-supplied project root because
 * Node resolves a module's imports by walking up from the module's OWN
 * location. For attach mode the two are the same tree (the bundle lands at
 * `<destDir>/.desde/stamp/`), and starting the walk at `destDir` is the
 * conservative half of it — every directory it checks, the real resolution also
 * checks.
 *
 * Reported rather than refused. The failure it predicts is loud (the user's own
 * dev server refuses to load its config) rather than silent, the remedy is one
 * install away, and this check uses Node's resolver while the dev server uses
 * Vite's — so a refusal here could be wrong in the direction that blocks a
 * working setup.
 */
function missingExternals(destDir: string, file: RequiredStamperFile): string[] {
  if (file.stamper !== "vue3") return []
  const from = createRequire(join(destDir, "noop.js"))
  const missing = EXTERNAL_PACKAGES.filter((pkg) => {
    try {
      from.resolve(pkg)
      return false
    } catch {
      return true
    }
  })
  if (missing.length === 0) return []
  return [
    `${file.path} imports ${missing.join(", ")}, which does not resolve from ${destDir}. ` +
      `Your dev server will fail to load its config until you install it (npm i -D ${missing.join(" ")}).`,
  ]
}

function specFor(file: RequiredStamperFile): EntrySpec {
  // resolveStampersDir(), not a local walk-up: this file bundles to
  // editor-cli/dist/cli.js (Phase 1), which collapses import.meta.url to the
  // bundle's own URL and breaks a walk-up calibrated to THIS file's depth.
  // See payload-paths.ts.
  const stampersDir = resolveStampersDir()
  if (file.role === "webpack-loader") {
    return { entry: join(stampersDir, "next-loader.entry.ts"), format: "cjs" }
  }
  return {
    entry: join(
      stampersDir,
      file.stamper === "vue3" ? "vue-source-tag.entry.ts" : "jsx-source-tag.entry.ts",
    ),
    format: "es",
  }
}

/**
 * Bundle `spec.entry` to `target`. Returns true when it actually rebuilt.
 *
 * The freshness key is the content of every FIRST-PARTY module the previous
 * build pulled in (recorded from the bundler's own `moduleIds`, so it cannot
 * drift from what was really compiled) plus `editor-cli/package.json`, which is
 * what changes when a bundled third-party dependency moves. A file that was
 * deleted since hashes as absent, so a removal invalidates too.
 */
async function bundleTo(target: string, spec: EntrySpec): Promise<boolean> {
  const infoPath = join(dirname(target), BUILD_INFO_NAME)
  const info = await readBuildInfo(infoPath)
  const name = relative(dirname(target), target)
  const recorded = info?.outputs[name]

  if (recorded && (await exists(target))) {
    const current = await hashSources(recorded.sources)
    if (current === recorded.hash) return false
  }

  const output = await runBundler(spec)
  await writeAtomic(target, output.code)
  await writeBuildInfo(infoPath, {
    ...(info ?? { version: BUILD_INFO_VERSION, outputs: {} }),
    version: BUILD_INFO_VERSION,
    outputs: {
      ...(info?.outputs ?? {}),
      [name]: { sources: output.sources, hash: await hashSources(output.sources) },
    },
  })
  return true
}

async function runBundler(spec: EntrySpec): Promise<{ code: string; sources: string[] }> {
  // Vite's `build()` DEFAULTS `process.env.NODE_ENV` to "production" when it is
  // unset, and never puts it back. MEASURED on this checkout: null before, and
  // "production" after, persisting for the life of the CLI process.
  //
  // That is ambient state, and bundling our own loader is an implementation
  // detail nothing outside this function should be able to observe. Two
  // consequences were measured downstream, both of which reach into the user's
  // machine:
  //
  //  - Next, booted for DEV in the same process, sees a production NODE_ENV and
  //    REWRITES the customer's `tsconfig.json`. In-process boot exists to leave
  //    the repo untouched; this wrote to it on the very first boot.
  //  - Every child process the agent spawns inherits it, so an `npm install`
  //    silently skips devDependencies.
  //
  // `desde` sets no NODE_ENV, so the unset case IS the shipped one
  // — which is also why this hid from a vitest probe, where vitest has already
  // set NODE_ENV="test" and Vite therefore leaves it alone.
  const priorNodeEnv = process.env.NODE_ENV
  try {
    return await runBundlerInner(spec)
  } finally {
    if (priorNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = priorNodeEnv
  }
}

async function runBundlerInner(spec: EntrySpec): Promise<{ code: string; sources: string[] }> {
  const result = await build({
    configFile: false,
    // Silent because this runs inside CLI boot, whose own log lines are the
    // user-facing narrative. `outDir` is a temp dir, which Vite would otherwise
    // announce as "outside the project root" on every attach boot.
    logLevel: "silent",
    root: editorCliRoot(),
    ssr: { noExternal: true, target: "node", external: EXTERNAL_PACKAGES },
    build: {
      // `build.ssr` (not `build.lib`) so Node conditions win during resolution.
      // Measured: without it, `@vue/compiler-sfc` resolves to its
      // `esm-browser` build, which has no `node:crypto` and fails to bundle.
      ssr: spec.entry,
      write: false,
      minify: true,
      target: "node20",
      rollupOptions: {
        external: EXTERNAL,
        output: {
          format: spec.format,
          // One file, no sibling chunks: the generated config block imports a
          // single path and nothing else is written next to it.
          codeSplitting: false,
          // A webpack loader is `module.exports = fn`, not
          // `module.exports.default = fn`.
          ...(spec.format === "cjs" ? { exports: "default" as const } : {}),
        },
      },
    },
  })

  const chunk = firstChunk(result)
  if (!chunk) throw new Error(`Stamper bundle produced no output for ${spec.entry}`)
  return {
    code: chunk.code,
    sources: chunk.moduleIds.filter((id) => id.startsWith(editorCliRoot()) && !id.includes("node_modules")),
  }
}

interface OutputChunkLike {
  type: string
  code: string
  moduleIds: string[]
}

/** Narrow Vite's `build()` return (single build | watcher | array) to one chunk. */
function firstChunk(result: unknown): OutputChunkLike | null {
  const candidates = Array.isArray(result) ? result : [result]
  for (const candidate of candidates) {
    const output = (candidate as { output?: unknown })?.output
    if (!Array.isArray(output)) continue
    for (const item of output) {
      const chunk = item as Partial<OutputChunkLike>
      if (chunk.type === "chunk" && typeof chunk.code === "string") {
        return { type: "chunk", code: chunk.code, moduleIds: chunk.moduleIds ?? [] }
      }
    }
  }
  return null
}

function editorCliRoot(): string {
  // The directory holding editor-cli/package.json (dev) or the payload's
  // package.json (packaged) — i.e. the package root, used above both as the
  // Vite build `root` and as the first-party-module-id prefix. Derived from
  // resolveEditorCliPackageJson() rather than a local walk-up: this file
  // bundles to editor-cli/dist/cli.js (Phase 1), which collapses
  // import.meta.url to the bundle's own URL. See payload-paths.ts.
  return dirname(resolveEditorCliPackageJson())
}

interface BuildInfo {
  version: number
  outputs: Record<string, { sources: string[]; hash: string }>
}

async function readBuildInfo(path: string): Promise<BuildInfo | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(path, "utf8")) as BuildInfo
    if (parsed?.version !== BUILD_INFO_VERSION || typeof parsed.outputs !== "object") return null
    return parsed
  } catch {
    return null
  }
}

async function writeBuildInfo(path: string, info: BuildInfo): Promise<void> {
  await writeAtomic(path, `${JSON.stringify(info, null, 2)}\n`)
}

/**
 * Stands in for a source file that has since been deleted, so a removal
 * invalidates the cache instead of hashing as "unchanged".
 *
 * It used to be a pair of literal NUL bytes, on the reasonable-sounding theory
 * that a NUL cannot appear in a text file. It can — and the cost was that
 * `grep` classified THIS file as binary and skipped it entirely, so
 * `write-stampers.ts` was invisible to every `grep -r` over `editor-cli/src`,
 * including the security check in `tasks/dev-server-hosts.md` § 4 (S12) that
 * enumerates which files may import Vite. A file that silently passes a grep
 * gate by being unreadable is worse than a marginally weaker sentinel: the
 * collision it prevents (a source file whose entire content is this string)
 * changes a rebuild decision, while the one it caused hides a file from
 * auditing.
 */
const ABSENT_SENTINEL = "@@desde:source-absent@@"

async function hashSources(sources: readonly string[]): Promise<string> {
  const hash = createHash("sha256")
  hash.update(`v${BUILD_INFO_VERSION}\n`)
  // The manifest of the CLI itself, so an `npm install` that moves a bundled
  // dependency invalidates even though no first-party file changed.
  hash.update(await readOrAbsent(join(editorCliRoot(), "package.json")))
  for (const source of [...sources].sort()) {
    hash.update(`\n--${relative(editorCliRoot(), source)}--\n`)
    hash.update(await readOrAbsent(source))
  }
  return hash.digest("hex")
}

async function readOrAbsent(path: string): Promise<string> {
  try {
    return await fs.readFile(path, "utf8")
  } catch {
    return ABSENT_SENTINEL
  }
}

/**
 * Write through a sibling temp file + rename, so a second CLI booting against
 * the same prototype can never expose a half-written stamper to a dev server
 * that is watching the directory.
 */
async function writeAtomic(path: string, content: string): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`
  await fs.writeFile(tmp, content, "utf8")
  await fs.rename(tmp, path)
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.access(path)
    return true
  } catch {
    return false
  }
}

/**
 * The sibling `.d.mts` for a `.mjs` plugin bundle.
 *
 * Not optional polish: a TypeScript config importing a bare `.mjs` fails with
 * TS7016 ("could not find a declaration file"), which breaks `nuxt typecheck` /
 * `vue-tsc` for anyone who runs it. Self-contained on purpose — importing
 * Vite's `Plugin` type would make the declaration unresolvable in a prototype
 * that has no Vite dependency of its own.
 */
function declarationSource(): string {
  return `// Generated by the Desde Editor CLI. Do not edit.
declare function desdeSourceTag(): {
  name: string
  enforce: 'pre'
  apply: 'serve'
  transform(code: string, id: string): { code: string; map: null } | null
}
export default desdeSourceTag
`
}
