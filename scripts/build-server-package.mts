/**
 * Assembles the standalone Editor CLI PAYLOAD — a directory that runs the
 * server with no repo checkout, no `tsx`, and no devDependencies. This is
 * the deliverable of Phase 1 task 3 in `tasks/electron-app.md`: the exact
 * tree Electron later ships as `Resources/server`, and equally what a
 * future npm package would ship.
 *
 * The directory shape is NOT this script's choice — it must match what
 * `editor-cli/src/payload-paths.ts`'s resolvers look for under
 * `EDITOR_PAYLOAD_ROOT`:
 *
 *   <out>/dist/cli.js, dist/cli.js.map, dist/mcp.js, dist/mcp.js.map
 *   <out>/package.json           ← generated here, see generatePackageJson()
 *   <out>/node_modules/          ← `npm install --omit=dev` runs IN <out>, then
 *                                   pruneNodeModules() drops what nothing runs
 *                                   (source maps, docs, tests, .d.ts outside
 *                                   typescript/) — see its doc comment
 *   <out>/demo/                  ← the bundled demo's source, plus its dependency
 *                                   tree packed as ONE `node_modules.tgz`
 *                                   (materialize.ts unpacks it on first open)
 *   <out>/ui/                    ← editor-cli/ui-src/dist, copied as one set
 *   <out>/assets/bridge-bundle.js, assets/html2canvas.min.js
 *   <out>/attach/stampers/*.entry.ts  ← raw source, fed to a live Vite build at boot
 *   <out>/plugins/*.ts, hosts/*.ts    ← the stamper entries' own relative-import
 *                                        closure (see payload-paths.ts's doc
 *                                        comment on resolveStampersDir — NOT a
 *                                        flat <out>/stampers/, the entries need
 *                                        their siblings at the checkout's depth)
 *   <out>/icon-preview/*.mjs     ← raw source, spawned as a child process
 *
 * Usage:
 *   ./node_modules/.bin/tsx scripts/build-server-package.mts --out <dir> [--skip-build] [--skip-install]
 *   npm run build:payload -- --out <dir>
 *
 * --out            Staging destination. Required. Refused if it resolves
 *                   inside this repo's working tree and is not git-ignored —
 *                   a stray multi-hundred-MB tree showing up in `git status`
 *                   is a real hazard, not a style nit.
 * --skip-build      Assume `editor-cli/dist` and `editor-cli/ui-src/dist`
 *                    are already built (fast iteration on this script).
 * --skip-install     Skip `npm install --omit=dev` in the staging dir (fast
 *                    iteration / dry runs that only need the file layout).
 */
import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, readFileSync, promises as fs } from "node:fs"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
// `editor-cli/package.json` declares `"type": "module"`, so files under
// `editor-cli/src/**` compile as real ESM (module format is decided by the
// nearest package.json to the FILE BEING IMPORTED, not the importer) — a
// plain static import of its named exports works, and payload-paths.ts's
// resolvers all re-read `process.env.EDITOR_PAYLOAD_ROOT` fresh on every
// call rather than caching it at import time, so importing this before
// EDITOR_PAYLOAD_ROOT is set is safe; only the later CALLS need it set.
import { DEMO_NODE_MODULES_ARCHIVE } from "../editor-cli/src/server/demo/paths.js"
import {
  resolveBridgeBundlePath,
  resolveEditorCliPackageJson,
  resolveHtml2canvasPath,
  resolveIconPreviewDir,
  resolveStampersDir,
  resolveUiBundleRoot,
} from "../editor-cli/src/payload-paths.js"
// Plain `.mjs`, no transpilation needed — see that module's own doc comment
// for why it exists as its own file: `desktop/scripts/payload-manifest-guard.mjs`
// (packaging time) needs to import the IDENTICAL algorithm this file uses
// (staging time) without going through tsx, which is not in that script's
// invocation path at all.
import { computePayloadFingerprint } from "./payload-fingerprint.mjs"

/**
 * Dynamic import + `default` unwrap, not a static named import.
 *
 * Root `package.json` has no `"type": "module"`, so `tsx` compiles `src/**`
 * as CJS; a static `import { derivePayloadDependencies } from "…"` inside
 * this `.mts` (ESM) file fails at link time with "does not provide an
 * export named…". See `tasks/scripts/publish-live-smoke.mts` for the same
 * pattern and the same reason — copied deliberately, not reinvented.
 */
const derivePayloadDependenciesModule = await import(
  "../src/editor/packaging/derive-payload-dependencies.js"
)
const { derivePayloadDependencies } = (
  (derivePayloadDependenciesModule as { default?: unknown }).default ??
  derivePayloadDependenciesModule
) as typeof import("../src/editor/packaging/derive-payload-dependencies.js")

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(SCRIPT_DIR, "..")
const EDITOR_CLI_ROOT = join(REPO_ROOT, "editor-cli")

/**
 * Written to `<out>/payload-manifest.json` on every successful run, and
 * checked BEFORE cleaning an existing `--out` directory: a directory that
 * already has this file is recognisably a previous staging output and is
 * safe to blow away and rebuild. A directory that is merely non-empty (a
 * typo'd `--out` pointing at something the user cares about) is not — see
 * {@link cleanDestination}.
 *
 * Exported (along with {@link cleanDestination} itself) for
 * `build-server-package.test.mts`, which imports this module directly
 * rather than spawning it as a subprocess — see the `main()` guard at the
 * bottom of this file for why that is safe to do.
 */
export const MANIFEST_FILENAME = "payload-manifest.json"

interface CliArgs {
  out: string
  skipBuild: boolean
  skipInstall: boolean
}

function parseArgs(argv: string[]): CliArgs {
  let out: string | null = null
  let skipBuild = false
  let skipInstall = false
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--out") out = argv[++i] ?? null
    else if (arg === "--skip-build") skipBuild = true
    else if (arg === "--skip-install") skipInstall = true
    else {
      throw new Error(`unrecognized argument: ${arg}`)
    }
  }
  if (!out) {
    throw new Error(
      "--out <dir> is required — the staging destination for the assembled payload.",
    )
  }
  return { out: resolve(process.cwd(), out), skipBuild, skipInstall }
}

/**
 * Refuses to stage into a path inside this repo's working tree unless git
 * already ignores it. Cheap to get wrong and expensive when you do: the
 * payload is hundreds of MB (the bundled `claude` binary alone is ~198MB —
 * see `tasks/electron-app.md` C3), and `git status` silently sweeping that
 * up because someone typo'd `--out build` instead of `--out ../build` is
 * exactly the hazard this guards against.
 *
 * A path OUTSIDE the repo tree entirely (the recommended, and tested, way
 * to run this script) always passes — the check only fires for paths that
 * resolve under {@link REPO_ROOT}.
 */
function ensureSafeDestination(out: string): void {
  const rel = relative(REPO_ROOT, out)
  // `rel === ""` means `out` IS `REPO_ROOT` — that counts as "inside", not
  // an exemption from the check (a `relative()` result never starting with
  // ".." and never absolute is the general "inside or equal to" test; the
  // empty-string case is just its boundary, not a special case to carve out).
  const isInsideRepo = !rel.startsWith("..") && !isAbsolute(rel)
  if (!isInsideRepo) return

  const result = spawnSync("git", ["-C", REPO_ROOT, "check-ignore", "-q", out], {
    stdio: "ignore",
  })
  // `check-ignore -q` exits 0 when the path IS ignored, 1 when it is not.
  // Any other status (missing git, repo confusion, …) is treated as "not
  // provably safe" — refuse rather than guess.
  if (result.status !== 0) {
    throw new Error(
      `--out resolves to ${out}, which is INSIDE this repo's working tree (${REPO_ROOT}) ` +
        `and is not covered by .gitignore. Refusing to write there — a payload this large ` +
        `showing up in \`git status\` is a real hazard. Either point --out outside the repo, ` +
        `or add the directory to .gitignore first.`,
    )
  }
}

/**
 * Deletes an existing `--out` directory ONLY if it is empty or recognisably
 * a previous run of this same script (carries {@link MANIFEST_FILENAME}).
 * Anything else is left alone and the script refuses to proceed — deleting
 * a directory the user actually cares about because they mistyped `--out`
 * is not an acceptable failure mode.
 *
 * `--out` is refused outright if it is itself a symlink, checked with
 * `lstat` BEFORE the `readdir` below. `readdir` follows symlinks — a
 * `--out` that is a symlink pointing at an empty directory would otherwise
 * sail through the "empty is safe" branch just below with the guard never
 * having run at all, and every artifact this script writes would land in
 * the SYMLINK'S TARGET, not at the path the caller actually named. A typo
 * (`--out build` landing on a pre-existing symlink) or a planted symlink
 * both reach the same outcome: an arbitrary directory gets populated with
 * no error and no indication anything unusual happened. Refusing is simpler
 * and safer than resolving the symlink and re-running the same guards
 * against its target — this script has no legitimate reason to stage a
 * multi-hundred-MB payload through an indirection layer, so there is no
 * behavior worth preserving on the other side of "just don't."
 */
export async function cleanDestination(out: string): Promise<void> {
  if (!existsSync(out)) return
  const st = await fs.lstat(out)
  if (st.isSymbolicLink()) {
    throw new Error(
      `--out (${out}) is a symlink. Refusing to stage a payload through it — writes would land ` +
        `at whatever it resolves to, not at the path you named, and this script's own "already ` +
        `looks like a previous build" / "empty is safe" checks below would be checking the WRONG ` +
        `directory. Point --out at a real (non-symlink) path instead.`,
    )
  }
  const entries = await fs.readdir(out)
  if (entries.length === 0) return
  if (!entries.includes(MANIFEST_FILENAME)) {
    throw new Error(
      `--out (${out}) already exists, is not empty, and does not contain ` +
        `${MANIFEST_FILENAME} — the marker this script writes on every successful run. ` +
        `Refusing to delete a directory that doesn't look like a previous payload build. ` +
        `Remove it yourself first if you're sure, or point --out somewhere new.`,
    )
  }
  await fs.rm(out, { recursive: true, force: true })
}

/** Runs an editor-cli build script, streaming its output, and fails loudly on a non-zero exit. */
function runEditorCliScript(scriptName: string): void {
  console.log(`\n▸ npm run ${scriptName} (in editor-cli)`)
  const result = spawnSync("npm", ["run", scriptName], {
    cwd: EDITOR_CLI_ROOT,
    stdio: "inherit",
  })
  if (result.status !== 0) {
    throw new Error(
      `"npm run ${scriptName}" failed (exit ${String(result.status)}) — see output above.`,
    )
  }
}

async function copyFile(src: string, dest: string): Promise<void> {
  await fs.mkdir(dirname(dest), { recursive: true })
  await fs.copyFile(src, dest)
}

async function copyDir(src: string, dest: string): Promise<void> {
  await fs.mkdir(dirname(dest), { recursive: true })
  await fs.cp(src, dest, { recursive: true })
}

/** Absolute paths of every `*.entry.ts` file in a directory, sorted for stable output. */
async function globEntryFiles(dir: string, suffix: string): Promise<string[]> {
  const entries = await fs.readdir(dir)
  return entries
    .filter((name) => name.endsWith(suffix))
    .sort()
    .map((name) => join(dir, name))
}

interface CopyResult {
  /** Filenames copied into `<out>/attach/stampers/`. */
  stamperFiles: string[]
  /** Repo-relative (from `editor-cli/src/`) paths copied into `<out>/<same path>`. */
  stamperSupportFiles: string[]
  /** Filenames copied into `<out>/icon-preview/`. */
  iconPreviewFiles: string[]
}

/**
 * The full transitive VALUE-import closure of the three stamper entries,
 * beyond the entries themselves — every file `vue-source-tag.entry.ts` /
 * `jsx-source-tag.entry.ts` / `next-loader.entry.ts` reach via a relative
 * import, traced by hand against the real source (`import type` edges
 * excluded: Vite's SSR build erases those before module resolution runs, so
 * `hosts/types.ts` — imported only as `import type` from two of these files —
 * is included anyway, cheaply, rather than betting the boundary is exactly
 * where the erasure happens on every future Vite version).
 *
 * Paths are relative to `editor-cli/src/`, and land at the SAME relative path
 * under `<out>/` — this is what makes the entries' own `../../plugins/…` /
 * `../../hosts/…` imports resolve once `<out>/attach/stampers/*.entry.ts`
 * sits at the matching depth. See `payload-paths.ts`'s `resolveStampersDir`
 * doc comment for the full reasoning; this list is the OTHER half of that fix
 * — the entries alone are not enough once they sit somewhere resolvable, they
 * also need somewhere real to resolve TO.
 */
const STAMPER_SUPPORT_FILES = [
  "plugins/source-tag-plugin.ts",
  "plugins/jsx-source-tag-plugin.ts",
  "plugins/source-version.ts",
  "plugins/transform-input.ts",
  "hosts/stamp-policy.ts",
  "hosts/types.ts",
]

/**
 * Copies every artifact per the layout table in the module doc comment.
 * Each destination matches a resolver in `editor-cli/src/payload-paths.ts`
 * exactly — {@link verifyPayloadPaths} checks that after the fact instead
 * of trusting this function's own bookkeeping.
 */
async function copyArtifacts(out: string): Promise<CopyResult> {
  console.log("\n▸ Copying artifacts")

  const distFiles = ["cli.js", "cli.js.map", "mcp.js", "mcp.js.map"]
  for (const name of distFiles) {
    await copyFile(join(EDITOR_CLI_ROOT, "dist", name), join(out, "dist", name))
  }

  // One matched set from one build — index.html is content-coupled to the
  // exact content-hashed chunk filenames in assets/ (see
  // gw-payload-inventory.md §2). Copying the whole directory in one `cp`
  // call is what keeps that pairing intact; copying index.html and assets/
  // separately would risk interleaving two different builds.
  await copyDir(join(EDITOR_CLI_ROOT, "ui-src", "dist"), join(out, "ui"))

  // The bundled demo prototype — SOURCE only. Its own node_modules are
  // installed into the staged copy below rather than copied, which is what
  // keeps its `lightningcss` native binary matched to the architecture the
  // payload is being staged for. `resolveDemoFixtureDir` (payload-paths.ts)
  // expects it at `<out>/demo`.
  //
  // node_modules and dist are removed after the copy rather than filtered
  // during it: `editor-cli/demo/.gitignore` keeps both out of git, so a clean
  // checkout has neither, but a checkout where the demo has been run locally
  // has both and would otherwise ship a host-architecture install.
  await copyDir(join(EDITOR_CLI_ROOT, "demo"), join(out, "demo"))
  await fs.rm(join(out, "demo", "node_modules"), { recursive: true, force: true })
  await fs.rm(join(out, "demo", "dist"), { recursive: true, force: true })
  // `.desde/config.json` MUST ship — it is the pre-filled viewer link, and the
  // only reason "Open in viewer" works on first launch with no setup. Every
  // sibling under `.desde/` is per-machine cache written by a local boot
  // (manifests are version-keyed, chat sessions and backups quote the
  // developer's own source) and must not.
  for (const entry of await fs.readdir(join(out, "demo", ".desde")).catch(() => [])) {
    if (entry === "config.json") continue
    await fs.rm(join(out, "demo", ".desde", entry), { recursive: true, force: true })
  }

  await copyFile(join(REPO_ROOT, "dist", "bridge-bundle.js"), join(out, "assets", "bridge-bundle.js"))
  await copyFile(
    join(REPO_ROOT, "public", "vendor", "html2canvas.min.js"),
    join(out, "assets", "html2canvas.min.js"),
  )

  // Raw *.entry.ts source — write-stampers.ts feeds these to a LIVE Vite
  // build at CLI-boot time (see that file's own doc comment: the output is
  // specific to the target consumer's own node_modules, so it cannot be
  // pre-bundled here). Globbed rather than hardcoded to the three files
  // that exist today so a future fourth stamper ships automatically.
  //
  // Destination is `<out>/attach/stampers/`, NOT a flat `<out>/stampers/` —
  // see `resolveStampersDir`'s doc comment (payload-paths.ts) and
  // STAMPER_SUPPORT_FILES just above: the entries import sibling source by
  // RELATIVE path, resolved against their own on-disk location, so the
  // payload has to reproduce the checkout's depth or that resolution walks
  // out of the payload entirely. MEASURED: a flat `<out>/stampers/` passed
  // every check this script runs and then broke the first live attach-mode
  // boot with `Could not resolve '../../plugins/source-tag-plugin.js'` —
  // this script's own verification never actually bundled the entry, only
  // confirmed the FILE existed, which is not the same claim.
  const stampersSrcDir = join(EDITOR_CLI_ROOT, "src", "attach", "stampers")
  const stamperPaths = await globEntryFiles(stampersSrcDir, ".entry.ts")
  if (stamperPaths.length === 0) {
    throw new Error(`no *.entry.ts files found in ${stampersSrcDir} — expected at least one.`)
  }
  for (const src of stamperPaths) {
    await copyFile(src, join(out, "attach", "stampers", basename(src)))
  }

  for (const rel of STAMPER_SUPPORT_FILES) {
    await copyFile(join(EDITOR_CLI_ROOT, "src", rel), join(out, rel))
  }

  // Raw render-*.mjs — spawned as a child process (src/editor/icon-preview/
  // render.ts), never imported by the module graph, so esbuild cannot and
  // does not inline it. Globbed for the same future-proofing reason as the
  // stampers above (a render-react.mjs lands the same way per that file's
  // own doc comment).
  const iconPreviewSrcDir = join(REPO_ROOT, "src", "editor", "icon-preview")
  const iconPreviewEntries = await fs.readdir(iconPreviewSrcDir)
  const iconPreviewFiles = iconPreviewEntries.filter((name) => /^render-.*\.mjs$/.test(name)).sort()
  if (iconPreviewFiles.length === 0) {
    throw new Error(`no render-*.mjs files found in ${iconPreviewSrcDir} — expected at least one.`)
  }
  for (const name of iconPreviewFiles) {
    await copyFile(join(iconPreviewSrcDir, name), join(out, "icon-preview", name))
  }

  return {
    stamperFiles: stamperPaths.map((p) => basename(p)),
    stamperSupportFiles: STAMPER_SUPPORT_FILES,
    iconPreviewFiles,
  }
}

interface EsbuildMetafile {
  inputs: Record<string, unknown>
  outputs: Record<string, unknown>
}

/**
 * Reads a package's OWN `package.json` `version` directly off disk, walking
 * the same node_modules search order Node itself uses when resolving a bare
 * import from `<out>/dist/cli.js` (nearest `node_modules` first): this
 * repo's `editor-cli/node_modules`, then the repo root's `node_modules`.
 *
 * Reads the file directly with `fs` rather than `require.resolve(pkg +
 * "/package.json")` — MEASURED: several packages in this dependency set
 * (`@anthropic-ai/sdk`, `@anthropic-ai/claude-agent-sdk`, `tailwind-merge`,
 * `vite-plugin-vue-tracer`) declare an `exports` map that does not expose
 * `./package.json` as a subpath, so `require.resolve` throws
 * `ERR_PACKAGE_PATH_NOT_EXPORTED` even though the file is sitting right
 * there on disk. A direct `fs` read bypasses the exports map entirely,
 * which is correct here: we're reading metadata about the package, not
 * importing from it.
 *
 * Deliberately does NOT fall back to a semver range from a source
 * `package.json` — the range and the installed version can differ, and the
 * payload must reproduce what was actually built and tested, not merely
 * something compatible with a range.
 */
function makeVersionResolver(): (pkg: string) => string {
  const searchRoots = [join(EDITOR_CLI_ROOT, "node_modules"), join(REPO_ROOT, "node_modules")]
  return (pkg: string): string => {
    const tried: string[] = []
    for (const root of searchRoots) {
      const pkgJsonPath = join(root, ...pkg.split("/"), "package.json")
      tried.push(pkgJsonPath)
      if (!existsSync(pkgJsonPath)) continue
      const parsed = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as { version?: unknown }
      if (typeof parsed.version === "string" && parsed.version.length > 0) {
        return parsed.version
      }
      throw new Error(`${pkgJsonPath} has no string "version" field.`)
    }
    throw new Error(
      `could not resolve an installed version for "${pkg}". Tried:\n` +
        tried.map((p) => `  ${p}`).join("\n"),
    )
  }
}

/**
 * Builds the payload's `package.json`. `dependencies` comes from
 * {@link derivePayloadDependencies} over `editor-cli/dist/metafile.json` —
 * esbuild's own record of every bare import it left external — never from a
 * hand-maintained list. See that function's doc comment for why: it is the
 * only source that can't drift from what the bundler actually produced, and
 * it is what guarantees `typescript` / `vue-component-meta` (devDependencies
 * everywhere they're declared, but genuine runtime imports of the manifest/
 * grounding pipeline) end up in the payload's real `dependencies` without
 * this function needing to special-case them.
 */
async function generatePackageJson(out: string): Promise<Record<string, string>> {
  console.log("\n▸ Generating package.json")
  const metafileRaw = await fs.readFile(join(EDITOR_CLI_ROOT, "dist", "metafile.json"), "utf8")
  const metafile = JSON.parse(metafileRaw) as EsbuildMetafile

  const editorCliPkg = JSON.parse(
    await fs.readFile(join(EDITOR_CLI_ROOT, "package.json"), "utf8"),
  ) as { name: string; version: string; engines?: { node?: string } }

  const dependencies = derivePayloadDependencies(metafile, makeVersionResolver())

  const payloadPkg = {
    name: editorCliPkg.name,
    // Read at runtime by `editorCliVersion()` (editor-cli/src/hosts/next/
    // loader-cache.ts) as a cache-namespace key; falls back to
    // "unversioned" if this file is absent. Copied verbatim from
    // editor-cli's own package.json — the payload IS that build, so its
    // version identity should be the same one, not a second number to keep
    // in sync by hand.
    version: editorCliPkg.version,
    type: "module" as const,
    private: true as const,
    // Vite 8's own floor, and the version `require(esm)` stabilized in —
    // see editor-cli/package.json's own `engines` field and
    // tasks/electron-app.md Phase 1 task 5, which calls out shipping this
    // in "the generated manifest" explicitly, not just editor-cli's own.
    engines: editorCliPkg.engines ?? { node: ">=22.12" },
    dependencies,
  }

  await fs.writeFile(join(out, "package.json"), `${JSON.stringify(payloadPkg, null, 2)}\n`, "utf8")
  return dependencies
}

/**
 * Drops the parts of an installed dependency tree that nothing executes.
 * Every file shipped is a file the desktop updater has to download, unzip,
 * signature-verify and move on EVERY update, and the user's first launch of a
 * fresh install pays for it again in Gatekeeper's scan — measured
 * 2026-09-02: the payload's node_modules were 8,494 of the bundle's 14,706
 * files, and about 3,500 of those were source maps, README/CHANGELOG-style
 * docs, test directories and type declarations.
 *
 * What goes, and why each is safe:
 *   - `*.map` — consulted only by a debugger or a source-map-aware stack
 *     trace, never by the running code.
 *   - `*.md` / `*.markdown` — docs. LICENSE/LICENCE/NOTICE/COPYING files are
 *     KEPT whatever their extension: `desktop/scripts/generate-notices.mjs`
 *     resolves them by name for the shipped notices, and they are the legal
 *     reason a package may be redistributed at all.
 *   - `test/`, `tests/`, `__tests__/` directories — a package's own suite.
 *   - `*.d.ts` / `*.d.mts` / `*.d.cts` — type declarations, read only by a
 *     TypeScript checker. The ONE exception is `typescript/` itself: its
 *     `lib/*.d.ts` are the default libraries the checker loads at runtime
 *     when the manifest extractor (vue-dts-meta) analyses a user's project,
 *     so that package is left whole.
 *
 * Deliberately NOT removed: `.ts` sources that ship beside compiled output
 * (some packages point bundler-facing `exports` conditions at them), and
 * anything under the demo (`<out>/demo/node_modules` is a USER project as
 * far as the Editor is concerned — its `.d.ts` files are exactly what the
 * manifest extractor reads).
 *
 * Exported for `build-server-package.test.mts`.
 */
export async function pruneNodeModules(
  nodeModulesDir: string,
): Promise<{ files: number; dirs: number; bytes: number }> {
  const result = { files: 0, dirs: 0, bytes: 0 }
  if (!existsSync(nodeModulesDir)) return result
  const keepWhole = new Set([join(nodeModulesDir, "typescript")])
  const isLicenseLike = (name: string) => /^(licen[cs]e|notice|copying)/i.test(name)
  const isDeclaration = (name: string) => /\.d\.(ts|mts|cts)$/.test(name)
  const isTestDir = (name: string) => name === "test" || name === "tests" || name === "__tests__"

  async function removeTree(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        await removeTree(full)
      } else {
        const st = await fs.lstat(full)
        result.files += 1
        result.bytes += st.size
      }
    }
    await fs.rm(dir, { recursive: true, force: true })
  }

  async function walk(dir: string, insideKeptPackage: boolean): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        const kept = insideKeptPackage || keepWhole.has(full)
        if (!kept && isTestDir(entry.name) && dir !== nodeModulesDir && !dir.endsWith(`${sep}node_modules`)) {
          await removeTree(full)
          result.dirs += 1
          continue
        }
        await walk(full, kept)
        continue
      }
      if (insideKeptPackage || !entry.isFile()) continue
      const name = entry.name
      const drop =
        name.endsWith(".map") ||
        ((name.endsWith(".md") || name.endsWith(".markdown")) && !isLicenseLike(name)) ||
        isDeclaration(name)
      if (!drop) continue
      const st = await fs.lstat(full)
      await fs.rm(full, { force: true })
      result.files += 1
      result.bytes += st.size
    }
  }

  await walk(nodeModulesDir, false)
  return result
}

/**
 * Packs `<out>/demo/node_modules` into `<out>/demo/node_modules.tgz` and
 * removes the loose tree — see DEMO_NODE_MODULES_ARCHIVE (paths.ts) for why,
 * and materialize.ts for the unpack. `tar` rather than a JS tar library:
 * symlinks (`.bin/*`) and modes round-trip exactly, and the same `tar` is
 * what unpacks it on the user's machine.
 */
export async function packDemoNodeModules(out: string): Promise<{ files: number; bytes: number }> {
  const demoDir = join(out, "demo")
  const loose = join(demoDir, "node_modules")
  const { files } = await directorySizeAndCount(loose)
  const archive = join(demoDir, DEMO_NODE_MODULES_ARCHIVE)
  const result = spawnSync("tar", ["-czf", archive, "-C", demoDir, "node_modules"], { stdio: "inherit" })
  if (result.status !== 0) {
    throw new Error(`tar failed (exit ${String(result.status)}) packing ${loose}`)
  }
  await fs.rm(loose, { recursive: true, force: true })
  const { size } = await fs.stat(archive)
  return { files, bytes: size }
}

/** Runs `npm install --omit=dev` inside `<out>`, streaming output. */
function runNpmInstall(out: string): void {
  console.log("\n▸ npm install --omit=dev (in the staging dir)")
  const result = spawnSync("npm", ["install", "--omit=dev"], {
    cwd: out,
    stdio: "inherit",
    env: {
      ...process.env,
      // Suppresses Playwright's ~1GB browser download — the review-surface
      // feature falls back to an installed system Chrome first (see
      // gw-payload-inventory.md §5c) and only reaches for a bundled
      // chromium as a last resort, so skipping this is a size win with a
      // narrow, clearly-erroring failure mode rather than a silent one.
      PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
    },
  })
  if (result.status !== 0) {
    throw new Error(`"npm install --omit=dev" failed (exit ${String(result.status)}) in ${out}`)
  }
}

/**
 * Runs `npm install --omit=dev` inside `<out>/demo`, streaming output.
 *
 * Separate from the payload's own install because it is a separate package
 * tree: the demo is a standalone prototype, and resolving its dependencies the
 * way any user repo would is the whole point of shipping it.
 *
 * `--omit=dev` is correct here, but only because the demo's package.json puts
 * Tailwind in `dependencies` rather than `devDependencies`. Its vite.config
 * loads the PostCSS plugin at SERVE time, so a supervised prototype needs it at
 * runtime; classifying it as build-only would install a demo that cannot boot.
 * `vite` itself stays a devDependency and is deliberately absent, because the
 * Editor supplies its own — which is why that config must not import
 * `defineConfig` (see editor-cli/demo/vite.config.ts).
 */
function runDemoNpmInstall(out: string): void {
  const demoDir = join(out, "demo")
  console.log("\n▸ npm install --omit=dev (in the staged demo)")
  const result = spawnSync("npm", ["install", "--omit=dev"], {
    cwd: demoDir,
    stdio: "inherit",
    env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" },
  })
  if (result.status !== 0) {
    throw new Error(
      `"npm install --omit=dev" failed (exit ${String(result.status)}) in ${demoDir}`,
    )
  }
}

/**
 * Removes the platform-specific `@anthropic-ai/claude-agent-sdk-<platform>-
 * <arch>[-musl]` package `npm install` staged into the payload as an
 * optional dependency of `@anthropic-ai/claude-agent-sdk` — see
 * `tasks/electron-app.md`'s "stop bundling the claude binary, fetch it on
 * first run" work. That package's only real content is the ~198MB `claude`
 * native binary. Anthropic's npm package for it states "© Anthropic PBC.
 * All rights reserved" with no clear grant to redistribute it through a
 * THIRD PARTY's own distribution channel (Desde) — so Desde no longer
 * ships it. `desktop/claude-runtime-installer.ts` instead fetches it
 * directly from npm onto the user's OWN machine on first run: the user
 * obtains the binary from Anthropic, and we never redistribute it.
 *
 * The SDK's own JS package (`@anthropic-ai/claude-agent-sdk` — no platform
 * suffix) is untouched: that one IS a normal runtime dependency of our own
 * code (imported directly by `claude-agent-sdk-provider.ts` /
 * `run-chat-turn-sdk.ts`, and present in `derivePayloadDependencies`'s
 * output), it's pure JS, and there's no redistribution question — Desde
 * still needs it to construct `query()` calls.
 *
 * Runs AFTER `npm install` rather than trying to prevent the download with
 * a package.json trick (e.g. `overrides` pointing the optional dep at a
 * nonexistent version): npm's own optionalDependencies resolution is
 * exactly what correctly picks the ONE package matching the build
 * machine's platform+arch in the first place (`writeManifest`'s own doc
 * comment already notes "npm only fetches the HOST's variant") —
 * re-deriving that logic here to dodge a download would duplicate npm's
 * resolution and risk drifting from it for a one-time, build-machine-only
 * bandwidth cost that never reaches a shipped artifact.
 */
async function stripClaudeAgentSdkPlatformPackages(
  out: string,
): Promise<{ removed: string[]; bytes: number }> {
  const scopeDir = join(out, "node_modules", "@anthropic-ai")
  let entries: string[]
  try {
    entries = await fs.readdir(scopeDir)
  } catch {
    // No @anthropic-ai scope directory at all — nothing to strip (shouldn't
    // happen after a real install, since the SDK's own JS package lives
    // here too, but this must never be the reason staging fails).
    return { removed: [], bytes: 0 }
  }

  const removed: string[] = []
  let bytes = 0
  for (const entry of entries) {
    // Keep the JS package itself (no platform suffix) and anything else
    // unrelated that might land in this scope.
    if (!entry.startsWith("claude-agent-sdk-")) continue
    const full = join(scopeDir, entry)
    const size = await directorySizeAndCount(full)
    bytes += size.bytes
    await fs.rm(full, { recursive: true, force: true })
    removed.push(entry)
  }
  return { removed, bytes }
}

/**
 * BUILD-TIME gate for the claude-runtime download anchor (the desktop
 * installer's F1 fix): after staging + stripping, prove the staged
 * `package-lock.json` actually carries the `integrity` expectation
 * `desktop/main.ts` will read at runtime for THIS build machine's
 * platform+arch — using the REAL reader (`claude-runtime-expectation.ts`),
 * not a reimplementation. Without this, a payload whose lockfile went
 * missing (or recorded a different SDK version) would assemble cleanly,
 * ship, and only fail on the user's machine at first-run install — with a
 * refusal, because the installer fails closed, but a refusal the build
 * could have caught for free. The dynamic import matches
 * `generatePackageJson`'s CJS-interop pattern below and keeps this module's
 * static import surface unchanged for the unit tests that import it.
 */
export async function assertClaudeRuntimeAnchor(out: string): Promise<void> {
  console.log("\n▸ Verifying the claude-runtime integrity anchor in the staged lockfile")
  const { readInstalledClaudeAgentSdkVersion, claudeAgentSdkPlatformCandidates, claudeAgentSdkPackageName } =
    await import("../src/editor/llm-providers/claude-runtime-location.js")
  const { readClaudeRuntimeExpectedIntegrity } = await import("../desktop/claude-runtime-expectation.js")
  const sdkVersion = readInstalledClaudeAgentSdkVersion(pathToFileURL(join(out, "package.json")).href)
  const [suffix] = claudeAgentSdkPlatformCandidates(process.platform, process.arch)
  const packageName = claudeAgentSdkPackageName(suffix)
  // Throws (failing the build) when the lockfile is missing, records a
  // different version, or carries no well-formed SRI for the platform package.
  const integrity = readClaudeRuntimeExpectedIntegrity({ payloadDir: out, packageName, sdkVersion })
  console.log(`  ${packageName}@${sdkVersion} → ${integrity.slice(0, 24)}…`)
}

/**
 * The single highest-value check in this script: import the REAL
 * `payload-paths.ts` resolvers (not a reimplementation of their logic) with
 * `EDITOR_PAYLOAD_ROOT` pointed at the just-built staging dir, and confirm
 * every path they resolve to actually exists on disk. A payload that
 * assembles without error but has one resolver pointing at nothing would
 * otherwise only be caught by the Phase 1 gate booting the real product —
 * expensive to diagnose, and exactly the class of bug `payload-paths.ts`'s
 * own colocated tests can't catch (they test the resolver's MATH, not
 * whether a real build actually produced the files it points at).
 */
async function verifyPayloadPaths(out: string, copied: CopyResult): Promise<void> {
  console.log("\n▸ Verifying payload-paths.ts resolvers against the staged output")

  // The resolvers re-read `process.env.EDITOR_PAYLOAD_ROOT` fresh on every
  // call rather than caching it at import time (see payload-paths.ts's own
  // doc comment), so it's enough to set it right before calling them —
  // restored in `finally` so this script's own later steps aren't affected.
  const priorPayloadRoot = process.env.EDITOR_PAYLOAD_ROOT
  process.env.EDITOR_PAYLOAD_ROOT = out
  let checks: Array<{ label: string; path: string }>
  try {
    checks = [
      { label: "resolveUiBundleRoot() → index.html", path: join(resolveUiBundleRoot(), "index.html") },
      { label: "resolveBridgeBundlePath()", path: resolveBridgeBundlePath() },
      { label: "resolveHtml2canvasPath()", path: resolveHtml2canvasPath() },
      { label: "resolveEditorCliPackageJson()", path: resolveEditorCliPackageJson() },
      // Directory resolvers are checked against the SPECIFIC files this
      // script copied into them, not mere directory existence — an empty
      // directory would pass `existsSync` and still leave the CLI unable
      // to find a stamper or the icon-preview renderer at runtime.
      ...copied.stamperFiles.map((name) => ({
        label: `resolveStampersDir() → ${name}`,
        path: join(resolveStampersDir(), name),
      })),
      // Not behind a resolver (nothing at runtime looks these up by name —
      // Vite's own module resolver finds them via the stamper entries'
      // relative imports) but just as load-bearing, so checked the same way:
      // against the exact path the entries will ask for, not the directory.
      ...copied.stamperSupportFiles.map((rel) => ({
        label: `stamper support file → ${rel}`,
        path: join(out, rel),
      })),
      ...copied.iconPreviewFiles.map((name) => ({
        label: `resolveIconPreviewDir() → ${name}`,
        path: join(resolveIconPreviewDir(), name),
      })),
    ]
  } finally {
    if (priorPayloadRoot === undefined) delete process.env.EDITOR_PAYLOAD_ROOT
    else process.env.EDITOR_PAYLOAD_ROOT = priorPayloadRoot
  }

  const failures: string[] = []
  for (const check of checks) {
    const ok = existsSync(check.path)
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${check.label} → ${check.path}`)
    if (!ok) failures.push(check.label)
  }

  if (failures.length > 0) {
    throw new Error(
      `payload-paths.ts verification failed for: ${failures.join(", ")}. ` +
        `The staged payload does not match what the CLI will look for at runtime.`,
    )
  }
}

interface PayloadManifest {
  /**
   * `git rev-parse HEAD` at build time — with a `-dirty` suffix when the
   * working tree had pending changes, same convention as `git describe
   * --dirty`. See {@link currentGitCommit} for why this matters: without the
   * suffix, a payload built from uncommitted work claims to BE a specific
   * commit, which is exactly the staleness question this field exists to
   * answer, answered wrong.
   *
   * F9 (whole-branch review, fourth pass, P1 fix): kept for PROVENANCE and
   * the human-readable packaging-time warning — it is no longer what
   * DECIDES staleness. See {@link payloadFingerprint} below for why: a git
   * commit cannot see a change to a gitignored built artifact, and it never
   * covered the staging recipe at all.
   */
  gitCommit: string
  builtAt: string
  platform: NodeJS.Platform
  arch: string
  dependencies: Record<string, string>
  /**
   * F9 (whole-branch review, fourth pass, P1 fix): `computePayloadFingerprint`'s
   * own sha256 digest (`payload-fingerprint.mjs`) over every file that
   * determines this payload's bytes — see that module's doc comment for the
   * exact boundary (what's covered, and what's deliberately not). THIS is
   * what `desktop/scripts/payload-manifest-guard.mjs`'s packaging-time
   * freshness check compares against a freshly recomputed value; `gitCommit`
   * above is provenance only now.
   */
  payloadFingerprint: string
}

/**
 * True when `git status --porcelain` reports any pending change — staged,
 * unstaged, or untracked — in `repoRoot`. `repoRoot` defaults to this
 * script's own checkout; the parameter exists so
 * `build-server-package.test.mts` can point it at a scratch git repo instead
 * of depending on (or perturbing) the real checkout's working-tree state.
 * Exported for that test suite; production code reaches it only through
 * {@link currentGitCommit}.
 */
export function isWorkingTreeDirty(repoRoot: string = REPO_ROOT): boolean {
  const output = execFileSync("git", ["-C", repoRoot, "status", "--porcelain"], { encoding: "utf8" })
  return output.trim().length > 0
}

/**
 * The commit the payload was staged from, suffixed `-dirty` when the tree
 * had uncommitted changes at build time (fix-round F4). Before this suffix,
 * `gitCommit` recorded a clean SHA regardless of the tree's actual state —
 * a payload built from uncommitted work would claim to BE that exact
 * commit, when the bytes it actually contains include whatever was
 * uncommitted on top of it. The manifest exists specifically to answer "is
 * this payload stale?"; an unmarked dirty build answers that question with
 * a confident lie. `-dirty` (not a sibling boolean field) keeps the
 * information attached to the one field a reader is already looking at,
 * the same way `git describe --dirty` does.
 *
 * `repoRoot` defaults to this script's own checkout, same reasoning as
 * {@link isWorkingTreeDirty}. Exported for the test suite.
 */
export function currentGitCommit(repoRoot: string = REPO_ROOT): string {
  const sha = execFileSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()
  return isWorkingTreeDirty(repoRoot) ? `${sha}-dirty` : sha
}

/**
 * Records enough to answer "is this payload stale, or built for the wrong
 * machine?" without re-deriving anything: the exact commit it was staged
 * from (dirty-suffixed per {@link currentGitCommit} when applicable), when,
 * and which platform+arch `npm install` resolved native dependencies for
 * (the bundled `claude` binary and esbuild are both platform+arch-specific
 * optional deps — npm only fetches the HOST's variant, so a payload built
 * on one machine cannot be assumed to run on another architecture).
 */
async function writeManifest(out: string, dependencies: Record<string, string>): Promise<void> {
  const manifest: PayloadManifest = {
    gitCommit: currentGitCommit(),
    builtAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    dependencies,
    // Computed AFTER the editor-cli build steps and copyArtifacts() have
    // already run (writeManifest is called near the end of main(), below) —
    // so editor-cli/dist and editor-cli/ui-src/dist are the FRESHLY BUILT
    // bytes this payload actually contains, not whatever was there before
    // this run.
    payloadFingerprint: computePayloadFingerprint(REPO_ROOT),
  }
  await fs.writeFile(join(out, MANIFEST_FILENAME), `${JSON.stringify(manifest, null, 2)}\n`, "utf8")
}

async function directorySizeAndCount(dir: string): Promise<{ bytes: number; files: number }> {
  let bytes = 0
  let files = 0
  const entries = await fs.readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      const sub = await directorySizeAndCount(full)
      bytes += sub.bytes
      files += sub.files
    } else if (entry.isFile()) {
      const stat = await fs.stat(full)
      bytes += stat.size
      files += 1
    }
  }
  return { bytes, files }
}

function humanBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"]
  let value = bytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex++
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv)
  console.log(`Staging destination: ${args.out}`)

  ensureSafeDestination(args.out)

  if (!args.skipBuild) {
    runEditorCliScript("build:server")
    runEditorCliScript("build:ui")
  } else {
    console.log("\n▸ --skip-build: assuming editor-cli/dist and editor-cli/ui-src/dist are current")
  }

  if (!existsSync(join(EDITOR_CLI_ROOT, "dist", "cli.js"))) {
    throw new Error(
      `${join(EDITOR_CLI_ROOT, "dist", "cli.js")} does not exist. Run "npm run build:server" ` +
        `in editor-cli (or drop --skip-build) before staging.`,
    )
  }
  if (!existsSync(join(EDITOR_CLI_ROOT, "ui-src", "dist", "index.html"))) {
    throw new Error(
      `${join(EDITOR_CLI_ROOT, "ui-src", "dist", "index.html")} does not exist. Run "npm run build:ui" ` +
        `in editor-cli (or drop --skip-build) before staging.`,
    )
  }

  await cleanDestination(args.out)
  await fs.mkdir(args.out, { recursive: true })

  const copied = await copyArtifacts(args.out)
  const dependencies = await generatePackageJson(args.out)
  await verifyPayloadPaths(args.out, copied)

  if (!args.skipInstall) {
    runNpmInstall(args.out)
    console.log("\n▸ Stripping the @anthropic-ai/claude-agent-sdk-<platform>-<arch> binary package")
    const stripped = await stripClaudeAgentSdkPlatformPackages(args.out)
    if (stripped.removed.length === 0) {
      console.log("  (none found — nothing to strip)")
    } else {
      console.log(
        `  Removed ${stripped.removed.join(", ")} (${humanBytes(stripped.bytes)}). Desde's ` +
          "installer fetches it on first run instead — see claude-runtime-installer.ts.",
      )
    }
    await assertClaudeRuntimeAnchor(args.out)
    console.log("\n▸ Pruning the payload's node_modules")
    const pruned = await pruneNodeModules(join(args.out, "node_modules"))
    console.log(`  Removed ${pruned.files} file(s) and ${pruned.dirs} test director(ies) (${humanBytes(pruned.bytes)})`)
    runDemoNpmInstall(args.out)
    console.log("\n▸ Packing the demo's node_modules")
    const packed = await packDemoNodeModules(args.out)
    console.log(`  ${packed.files} files → ${DEMO_NODE_MODULES_ARCHIVE} (${humanBytes(packed.bytes)})`)
  } else {
    console.log("\n▸ --skip-install: skipping npm install — node_modules/ will be absent")
  }

  await writeManifest(args.out, dependencies)

  const { bytes, files } = await directorySizeAndCount(args.out)
  console.log("\n▸ Done")
  console.log(`  Size:  ${humanBytes(bytes)} (${bytes} bytes)`)
  console.log(`  Files: ${files}`)
  console.log(`\n  Run it:`)
  console.log(`    EDITOR_PAYLOAD_ROOT="${args.out}" node "${join(args.out, "dist", "cli.js")}" [repo-path]`)
}

// Only run the packaging pipeline when this file is the process's own entry
// point (`tsx scripts/build-server-package.mts …` / `npm run
// build:payload`), not when something else imports it. `main()` parses
// `process.argv`, shells out to real builds, and calls `process.exit(1)` on
// failure — every one of which is wrong (and the last one actively unsafe:
// it would kill the whole test process) if this module is imported for its
// exports instead, which `build-server-package.test.mts` does to unit-test
// {@link cleanDestination} directly rather than spawning a subprocess and
// depending on `editor-cli/dist` already being built.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`\nbuild-server-package failed: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  })
}
