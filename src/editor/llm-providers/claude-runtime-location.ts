/**
 * Pure path/name computation for the desktop app's on-demand `claude`
 * binary install — see `tasks/electron-app.md`'s "stop bundling the claude
 * binary, fetch it on first run" work.
 *
 * Why this lives in root `src/`, not `desktop/`: the SAME path shape has to
 * be computed in two places that can never drift apart —
 * `desktop/claude-runtime-installer.ts` (where does the binary get WRITTEN)
 * and `resolve-claude-executable.ts` (where does `query()` LOOK for it).
 * `desktop/` already imports from root `src/` (see `desktop/child.ts`'s
 * reuse of `editor-cli/src/server/*`); the reverse import direction would be
 * wrong (root `src/` must run outside Electron too — the terminal CLI,
 * `editor-cli`'s own tests, a future non-desktop payload consumer), so this
 * module has ZERO dependency on `electron` or anything under `desktop/`.
 *
 * Every function here is pure — no filesystem, no network. Callers own I/O.
 */

import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join as joinPath } from "node:path"

export interface AppSupportDirInput {
  home: string
  platform: NodeJS.Platform
  /** The product's display name — e.g. "Desde". Not hardcoded here on purpose: this module has no opinion on product identity (see `desktop/product-name.ts`'s own doc comment on why that constant is duplicated by hand rather than imported across the same boundary). */
  appName: string
  /**
   * Only the two vars actually consulted, so a test double doesn't need a
   * whole fake `process.env` — and so this module doesn't depend on
   * `NodeJS.ProcessEnv`'s exact shape, which has been observed to vary
   * across this repo's separate `@types/node` installs (root vs.
   * `desktop/`, both nominally `^20` but resolving different patch
   * versions) in a way that broke a `Pick<NodeJS.ProcessEnv, …>` here.
   */
  env: { APPDATA?: string; XDG_DATA_HOME?: string }
}

/**
 * The OS-conventional per-user, per-app writable directory — the same
 * family of paths Electron's own `app.getPath('userData')` resolves.
 * Computed by hand (not via `app.getPath`) because this module is imported
 * by the shared `src/` tree, which must also run OUTSIDE Electron (the
 * terminal CLI, plain `vitest`).
 *
 * Only the darwin path is exercised live by this work (Desde is mac-first —
 * see `tasks/electron-app.md` Phase 0's "Windows posture for v1: defer").
 * The win32/linux branches follow the well-known convention each platform
 * uses but are untested against a real Windows/Linux machine.
 */
export function resolveAppSupportDir(input: AppSupportDirInput): string {
  switch (input.platform) {
    case "darwin":
      return joinPath(input.home, "Library", "Application Support", input.appName)
    case "win32":
      return joinPath(input.env.APPDATA || joinPath(input.home, "AppData", "Roaming"), input.appName)
    default:
      // XDG Base Directory convention (Linux and other POSIX platforms).
      return joinPath(input.env.XDG_DATA_HOME || joinPath(input.home, ".local", "share"), input.appName)
  }
}

export interface ClaudeRuntimeDirInput {
  /** The app-support root — {@link resolveAppSupportDir}'s return value, or the `EDITOR_CLAUDE_RUNTIME_DIR` env var the desktop shell sets on every process it spawns. */
  appSupportDir: string
  /** The exact version of `@anthropic-ai/claude-agent-sdk` the running payload ships — see {@link readInstalledClaudeAgentSdkVersion}. */
  sdkVersion: string
}

/**
 * The version-keyed install root. Keying by version (not a fixed
 * "current" directory) is what makes an SDK upgrade land cleanly: a new
 * payload build with a newer `@anthropic-ai/claude-agent-sdk` computes a
 * DIFFERENT directory here, so it re-installs fresh into its own space
 * rather than either clobbering a binary an older, still-running Desde
 * process might have open, or silently running a mismatched
 * SDK-JS/native-binary pair (the brief calls this out explicitly as "a real
 * failure mode"). A stale older version's directory is simply never looked
 * at again — cleaning it up is left for later (out of scope here; nothing
 * about this design prevents adding a GC pass).
 */
export function resolveClaudeRuntimeDir(input: ClaudeRuntimeDirInput): string {
  return joinPath(input.appSupportDir, "claude-runtime", input.sdkVersion)
}

/** `claude` everywhere except win32, where the SDK's own resolver looks for `claude.exe` (matches `Q2` in `@anthropic-ai/claude-agent-sdk/sdk.mjs`). */
export function claudeExecutableFileName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "claude.exe" : "claude"
}

export interface ClaudeExecutablePathInput {
  runtimeDir: string
  platform: NodeJS.Platform
}

/**
 * Where the binary lives INSIDE the runtime dir. Flat, not nested under a
 * `node_modules/@anthropic-ai/claude-agent-sdk-<platform>-<arch>/` path —
 * the installer extracts the platform package's CONTENTS directly into
 * {@link resolveClaudeRuntimeDir}'s directory (`pacote.extract(spec, dest)`
 * unpacks the tarball root into `dest`, not into a nested node_modules
 * shape), so the binary sits right at the runtime dir's root.
 */
export function resolveClaudeExecutablePathIn(input: ClaudeExecutablePathInput): string {
  return joinPath(input.runtimeDir, claudeExecutableFileName(input.platform))
}

/**
 * True on a musl-libc Linux host (Alpine and similar) rather than glibc.
 * Same test the SDK itself uses (`Lx` in `sdk.mjs`) and the same test
 * `tasks/scripts/payload-gate.mts`'s `isLinuxMusl` already ports — this is
 * the ONE shared copy both now use (see that script's own doc comment on
 * why it was refactored to import this rather than keep its own copy).
 */
export function isLinuxMusl(
  platform: NodeJS.Platform = process.platform,
  getReport: () => { header?: { glibcVersionRuntime?: unknown } } | null = () =>
    (process.report?.getReport?.() as { header?: { glibcVersionRuntime?: unknown } } | undefined) ?? null,
): boolean {
  if (platform !== "linux") return false
  const report = getReport()
  return report != null && report.header?.glibcVersionRuntime === undefined
}

/**
 * Ordered `@anthropic-ai/claude-agent-sdk-*` package name SUFFIXES for
 * `platform`/`arch`, highest-priority first — the SDK's own candidate order
 * (`Q2` in `sdk.mjs`). darwin/win32 have exactly one candidate; linux has
 * two, musl-first or glibc-first depending on {@link isLinuxMusl}.
 */
export function claudeAgentSdkPlatformCandidates(
  platform: NodeJS.Platform,
  arch: string,
  musl: boolean = isLinuxMusl(platform),
): string[] {
  if (platform === "linux") {
    return musl ? [`linux-${arch}-musl`, `linux-${arch}`] : [`linux-${arch}`, `linux-${arch}-musl`]
  }
  return [`${platform}-${arch}`]
}

/** `@anthropic-ai/claude-agent-sdk-<suffix>` — the npm package name for one of {@link claudeAgentSdkPlatformCandidates}'s entries. */
export function claudeAgentSdkPackageName(suffix: string): string {
  return `@anthropic-ai/claude-agent-sdk-${suffix}`
}

/**
 * Reads the EXACT installed version of `@anthropic-ai/claude-agent-sdk`
 * resolvable from `resolveFrom` (typically a caller's own `import.meta.url`,
 * or — for the desktop installer, which has no direct dependency on the SDK
 * at all — a path inside the PAYLOAD whose runtime this installs for).
 *
 * Version pinning matters (the brief: "a mismatched pair is a real failure
 * mode") — the installer must fetch the SAME version the SDK's JS side was
 * built against, never `latest`.
 *
 * Reads `package.json` directly with `fs` rather than
 * `require.resolve(pkg + "/package.json")` — MEASURED (see
 * `scripts/build-server-package.mts`'s `makeVersionResolver`, which
 * hit the identical issue): `@anthropic-ai/claude-agent-sdk`'s `exports` map
 * does not expose `./package.json` as a subpath, so that call throws
 * `ERR_PACKAGE_PATH_NOT_EXPORTED` even though the file is sitting right
 * there on disk. Resolving the package's MAIN entry (`sdk.mjs`, which IS
 * exported) and reading its sibling `package.json` sidesteps the exports
 * map entirely — correct because we're reading metadata about the package,
 * not importing through its public surface.
 *
 * `createRequire(resolveFrom)` (not a bare `require.resolve`, since this
 * module is ESM) resolves relative to `resolveFrom`'s own location on disk,
 * which is what makes this work identically pre- and post-bundling: after
 * `editor-cli`'s esbuild bundle inlines this file into `dist/cli.js`, a
 * caller's `import.meta.url` at RUNTIME still points at wherever that
 * bundle file actually executes from (`<payload>/dist/cli.js`), and walking
 * up node_modules from there finds `<payload>/node_modules/@anthropic-ai/
 * claude-agent-sdk` correctly — no `payloadRoot` seam needed here, unlike
 * the `import.meta.url`-derived walk-ups `tasks/electron-app.md` Phase 1
 * task 3 had to fix elsewhere (this one was never broken by bundling,
 * because it was never written pre-bundling in the first place).
 */
export function readInstalledClaudeAgentSdkVersion(resolveFrom: string): string {
  const requireFrom = createRequire(resolveFrom)
  const entry = requireFrom.resolve("@anthropic-ai/claude-agent-sdk")
  const pkgJsonPath = joinPath(dirname(entry), "package.json")
  const parsed = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as { version?: unknown }
  if (typeof parsed.version !== "string" || parsed.version.length === 0) {
    throw new Error(`${pkgJsonPath} has no string "version" field.`)
  }
  return parsed.version
}
