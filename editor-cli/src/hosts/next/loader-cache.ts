import { readFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { nextLoaderFiles } from "../../attach-preflight/index.js"
import { writeStamperFiles } from "../../attach/write-stampers.js"
import { resolveEditorCliPackageJson } from "../../payload-paths.js"

/**
 * Where the Next lane's Turbopack loader is written, and why it is not anywhere
 * else.
 *
 * The Next host cannot pass a live plugin object: Turbopack runs loaders in a
 * FORKED WORKER, so the only thing that survives is a file path plus
 * JSON-serialisable options (which is what the `AssertJson` guard on
 * {@link StampPolicy} exists to enforce). So there has to be a file, and the
 * question is where.
 *
 * **Not in the customer's repository.** Writing into the repo to boot a server
 * in our own process would give back the exact thing in-process boot exists to
 * provide. MEASURED on a pristine Next 16.3.0 fixture: a loader bundled to a
 * cache dir entirely outside the project, with `turbopack.root` left at its
 * default, stamps every route repo-relatively and the fixture is byte-identical
 * afterwards (no `.next`, no `.desde`, nothing).
 *
 * **Not the package directory.** A global install can be root-owned — `npm root
 * -g` is `/opt/homebrew/lib/node_modules` on the machine this was measured on —
 * so a write there fails for exactly the users least able to debug it.
 *
 * **Not a per-boot temp path.** Turbopack keys its persistent `.next` cache on
 * the loader's BYTES, so a stable path stays warm across boots while a fresh
 * path per boot would invalidate the customer's compile cache every time Editor
 * started.
 *
 * **Not a prebuilt artifact shipped with the package**, which is the option that
 * looks cheapest. `editor-cli`'s `build` script is `build:ui` only and `main`
 * points at `./src/core.ts` — the package runs from TypeScript under `tsx` — so
 * a prebuilt loader would be the only compiled output in the package and the
 * only thing that can silently go stale. `dist/bridge-bundle.js` already
 * demonstrates that failure mode and needs a documented manual ritual to avoid
 * it. Bundling at boot makes freshness structural instead of procedural.
 */

/** The file's name inside the cache directory. */
const LOADER_FILENAME = "next-loader.cjs"

/**
 * What the version segment is for.
 *
 * It is a NAMESPACE, not the freshness check. Two editor-cli installs of
 * different versions must not fight over one path, and an old version's loader
 * must not be picked up by a new one. Actual freshness is
 * `write-stampers.ts`'s content hash over every first-party module the previous
 * bundle pulled in — which is what makes this work during development, where
 * the version does not move but the plugin source does.
 */
function editorCliVersion(): string {
  try {
    // resolveEditorCliPackageJson(), not a local walk-up: this file bundles
    // to editor-cli/dist/cli.js (Phase 1), which collapses import.meta.url
    // to the bundle's own URL. See payload-paths.ts.
    const pkgPath = resolveEditorCliPackageJson()
    const version = (JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: unknown }).version
    if (typeof version === "string" && version.length > 0) return version
  } catch {
    /* fall through */
  }
  // Reachable two ways: the package manifest is unreadable (which would
  // break far more than this), or EDITOR_PAYLOAD_ROOT is set to a relative
  // path and resolveEditorCliPackageJson() throws before ever touching the
  // filesystem. Either way a constant is safe, because the content hash —
  // not this string — decides whether the bundle is rebuilt.
  return "unversioned"
}

/**
 * The per-user cache root, in the platform's own convention.
 *
 * Parameterised rather than reading the ambient environment directly so the
 * resolution ORDER is testable without mutating `process.env` — the thing this
 * function is actually responsible for.
 */
export function cacheHome(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = safeHomedir(),
): string {
  // XDG first on every platform, including macOS: a user who has set it has
  // said where cache data goes, and honouring it costs nothing.
  const xdg = env["XDG_CACHE_HOME"]
  if (typeof xdg === "string" && xdg.length > 0) return xdg
  if (platform === "win32") {
    const local = env["LOCALAPPDATA"]
    if (typeof local === "string" && local.length > 0) return local
  }
  if (home.length > 0) {
    return platform === "darwin" ? join(home, "Library", "Caches") : join(home, ".cache")
  }
  // No home directory at all (some CI containers, some daemon users). A temp
  // dir loses the warm-cache property across reboots and nothing else.
  return tmpdir()
}

/** `<cacheRoot>/desde/<editor-cli version>/stamp` — where the loader lands. */
export function nextLoaderDir(cacheRoot: string = cacheHome(), version: string = editorCliVersion()): string {
  return join(cacheRoot, "desde", version, "stamp")
}

export interface NextLoaderMaterialization {
  /** Absolute path to the bundled CJS loader. */
  loaderPath: string
  /** The directory it lives in, for the failure message. */
  cacheDir: string
  /** False when the content hash matched and nothing was re-bundled. */
  rebuilt: boolean
  ms: number
}

/**
 * Bundle the Turbopack loader into the per-user cache dir.
 *
 * **Failure here is FATAL and LOUD, with the path we tried**, and that asymmetry
 * is deliberate: an unstamped Next dev server boots healthy and serves 200s, so
 * a materialization failure that degraded into "boot anyway" would surface as a
 * refused edit minutes later rather than as a message at boot. The error names
 * the directory so an unwritable cache home is one `chmod` away from fixed.
 *
 * Uses the SAME bundler and the same freshness scheme attach mode uses
 * (`write-stampers.ts`); the only difference is the destination, which is what
 * milestone 9's `prototypeRoot` → `destDir` rename opened up. There is one
 * stamper implementation, one bundler call site, and one cache format.
 */
export async function materializeNextLoader(opts: {
  cacheRoot?: string
} = {}): Promise<NextLoaderMaterialization> {
  const cacheDir = nextLoaderDir(opts.cacheRoot ?? cacheHome())
  // `RequiredStamperFile.path` is the caller's choice — attach mode's
  // `.desde/stamp/` prefix exists only because its committed config block
  // imports the file by a relative path. Nothing here needs that, so the file
  // sits directly in the cache dir with `.build-info.json` beside it.
  const files = nextLoaderFiles().map((file) => ({ ...file, path: LOADER_FILENAME }))

  let result: Awaited<ReturnType<typeof writeStamperFiles>>
  try {
    result = await writeStamperFiles({ destDir: cacheDir, files })
  } catch (err) {
    throw new Error(
      `Editor could not write the Next.js source-code stamper to ${cacheDir}: ${(err as Error).message}. ` +
        "Without it the dev server would boot normally and stamp nothing, so every edit would be " +
        "refused. Editor refuses to boot instead. Set XDG_CACHE_HOME to a writable directory, or " +
        "start the project's dev server yourself and re-run with --attach <url>.",
      { cause: err },
    )
  }

  return {
    loaderPath: join(cacheDir, LOADER_FILENAME),
    cacheDir,
    rebuilt: result.rebuilt,
    ms: result.ms,
  }
}

function safeHomedir(): string {
  try {
    return homedir()
  } catch {
    return ""
  }
}
