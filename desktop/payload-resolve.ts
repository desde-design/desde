/**
 * Where does the CLI payload this shell should spawn live? Pure logic, no
 * Electron import — kept separate from `main.ts` specifically so it can be
 * unit-tested directly. (`main.ts` imports `electron`, and `require("electron")`
 * outside an actual Electron process returns a bare path string rather than
 * the API surface, which makes anything that imports it impractical to unit
 * test in plain Node/vitest.)
 *
 * Three sources, in priority order:
 *  1. `--payload <dir>` / `--payload=<dir>` on argv, or `DESDE_DESKTOP_PAYLOAD`
 *     env var — an EXPLICIT path. This is the primary dev-iteration workflow
 *     (`tasks/electron-app.md` §5 Phase 2, brief task 1): build a payload once
 *     with `npm run build:payload -- --out <dir>`, then point every
 *     `npm run desktop` at it without rebuilding. Also doubles as a debugging
 *     override on a PACKAGED build (e.g. QA pointing a packaged app at a
 *     freshly-built payload without repackaging). A missing payload at an
 *     explicit path is an ERROR, not a silent auto-build — a typo'd path
 *     should not trigger a multi-minute surprise rebuild.
 *  2. Packaged app, no explicit override → `<process.resourcesPath>/server`
 *     (`tasks/electron-app.md` §5 Phase 3 task 2). This is where
 *     `electron-builder.config.mjs`'s `extraResources` mapping puts the
 *     Phase-1 payload — OUTSIDE the asar, since it holds a spawned 198MB
 *     native binary and six `.node` modules that cannot live inside one (see
 *     `tasks/electron-app.md` C3). A missing payload here is ALSO a hard
 *     error, never an auto-build trigger: a packaged app ships to a machine
 *     with no repo checkout, no npm, no tsx — there is nothing to build with.
 *  3. Dev, no explicit override, not packaged → a stable cache directory
 *     under `desktop/` itself (`.payload-cache/`, gitignored). `main.ts`
 *     builds into it on first run and reuses it on every run after, so "no
 *     flag, no env var" still means "rebuild once, not every iteration."
 */

import { isAbsolute, resolve as resolvePath } from "node:path"

export const PAYLOAD_ENV_VAR = "DESDE_DESKTOP_PAYLOAD"
export const PAYLOAD_FLAG = "--payload"

/**
 * The literal name electron-builder gives its asar archive (the default, and
 * what `electron-builder.config.mjs` relies on — we never override it). A
 * payload path resolving anywhere under an `app.asar` directory would mean
 * the packaging config regressed to shipping the server INSIDE the asar,
 * which cannot work: the payload's `claude` binary is `spawn()`'d directly
 * and its `.node` modules are `dlopen()`'d, and neither works from inside an
 * archive (`tasks/electron-app.md` C3). {@link assertOutsidePackagedAsar}
 * checks for this substring rather than assuming "extraResources means
 * outside the asar" is self-enforcing — a config typo (e.g. `files` instead
 * of `extraResources`) would silently break this invariant with no error
 * until the first `spawn()` failed at runtime with a confusing ENOENT.
 */
const ASAR_ARCHIVE_NAME = "app.asar"

/**
 * Refuses a payload path that resolves inside a packaged asar archive. Called
 * once, right after {@link resolvePayloadRoot} resolves a path and before it
 * is handed to `spawnPayloadChild` (`main.ts`'s `boot()`) — the single spawn
 * seam this repo has for the payload child. This is an ASSERTION, not a
 * fallback: there is no correct way to "fix" a payload path that landed
 * inside the asar, so this throws rather than trying to relocate it.
 */
export function assertOutsidePackagedAsar(payloadPath: string): void {
  if (payloadPath.includes(ASAR_ARCHIVE_NAME)) {
    throw new Error(
      `Resolved payload path (${payloadPath}) resolves INSIDE a packaged asar archive ` +
        `(contains "${ASAR_ARCHIVE_NAME}"). The CLI payload must never be packed into the asar — ` +
        `it spawns a 198MB native \`claude\` binary and loads six \`.node\` native modules, neither ` +
        `of which works from inside an archive. Check electron-builder.config.mjs's extraResources ` +
        `mapping (it must place the payload under Resources/, not inside files/asar).`,
    )
  }
}

/**
 * Reads `--name value` or `--name=value` out of an argv array. Returns
 * `undefined` when absent, or when `--name` is the last element with no
 * value following it (rather than treating the next flag as the value).
 */
export function parseFlag(argv: string[], name: string): string | undefined {
  const withEquals = `${name}=`
  const eq = argv.find((a) => a.startsWith(withEquals))
  if (eq !== undefined) return eq.slice(withEquals.length)
  const idx = argv.indexOf(name)
  if (idx === -1) return undefined
  const value = argv[idx + 1]
  if (value === undefined || value.startsWith("--")) return undefined
  return value
}

export interface PayloadResolution {
  /** Absolute path to the payload directory. */
  path: string
  /**
   * True when a missing payload at `path` should be a HARD ERROR rather than
   * an auto-build trigger — set for an explicitly-named path (flag or env
   * var, source 1) AND for the packaged-app resource path (source 2, where
   * there is no toolchain to build with). Only the dev default cache
   * directory (source 3) gets `false` — `main.ts` uses this field to decide
   * whether to shell out to `npm run build:payload` on a miss.
   */
  explicit: boolean
}

/**
 * `cwd` resolves a relative `--payload`/env value against the invoking
 * shell's cwd (matches ordinary CLI-flag conventions), NOT against the
 * desktop package's own directory.
 *
 * `packagedResourcesPath` is `process.resourcesPath` when `app.isPackaged` is
 * true, `null` otherwise — the caller (`main.ts`) is responsible for reading
 * both off `electron`, since this module stays Electron-free for testability
 * (see the module doc comment). `null` here means "not a packaged app", not
 * "unknown" — a dev run (`npm run desktop`, `electron .`) always passes
 * `null` regardless of platform.
 */
export function resolvePayloadRoot(
  argv: string[],
  env: NodeJS.ProcessEnv,
  defaultCacheDir: string,
  cwd: string = process.cwd(),
  packagedResourcesPath: string | null = null,
): PayloadResolution {
  const fromFlag = parseFlag(argv, PAYLOAD_FLAG)
  const fromEnv = env[PAYLOAD_ENV_VAR]
  const explicitValue = fromFlag ?? (fromEnv && fromEnv.trim() !== "" ? fromEnv : undefined)
  if (explicitValue !== undefined) {
    const abs = isAbsolute(explicitValue) ? explicitValue : resolvePath(cwd, explicitValue)
    return { path: abs, explicit: true }
  }
  if (packagedResourcesPath !== null) {
    // The extraResources mapping in electron-builder.config.mjs places the
    // payload at Resources/server — see this module's doc comment, source 2.
    // `explicit: true` here means "hard error on a miss", matching the
    // reasoning above: a packaged app has no `npm`/`tsx` to build one with.
    return { path: resolvePath(packagedResourcesPath, "server"), explicit: true }
  }
  return { path: defaultCacheDir, explicit: false }
}
