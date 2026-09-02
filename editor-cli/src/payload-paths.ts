/**
 * Single seam for every "where does this asset live on disk" question the CLI
 * asks — the payload-path resolvers. Exists ahead of the esbuild bundler
 * (Phase 1 task 2) on purpose: bundling collapses every `import.meta.url` in
 * the whole module graph to ONE value, the bundle's own file URL
 * (`editor-cli/dist/cli.js`). Any code that walks up from its own file
 * location to find an asset is calibrated to that file's depth in the
 * checkout, and silently miscomputes once every such site shares one depth.
 * Centralising the walk-up here means there is exactly one place that can be
 * wrong, and the colocated test below (`devPathsFrom`) pins it against both
 * the checkout depth AND the future bundle depth.
 *
 * Two runtime layouts, one seam:
 *
 * - **Checkout (dev, today).** No env var. Assets live where they always
 *   have — scattered across `<repo>/editor-cli/…`, `<repo>/dist/…`,
 *   `<repo>/public/…`, `<repo>/src/…` — and each resolver below reproduces
 *   the exact walk-up its call site used to do locally.
 * - **Staging payload (packaged).** `EDITOR_PAYLOAD_ROOT` points at one flat
 *   directory assembled by a packaging script (Phase 1 task 2), with no repo
 *   checkout underneath it:
 *   ```
 *   <payload>/dist/cli.js
 *   <payload>/package.json
 *   <payload>/node_modules/
 *   <payload>/ui/
 *   <payload>/assets/bridge-bundle.js
 *   <payload>/assets/html2canvas.min.js
 *   <payload>/attach/stampers/*.entry.ts
 *   <payload>/plugins/*.ts       ← the stamper entries' own relative imports
 *   <payload>/hosts/*.ts         ← (source-tag-plugin.ts et al import "../hosts/…")
 *   <payload>/icon-preview/
 *   ```
 *
 *   The stamper entries are never bundled — `write-stampers.ts` feeds the raw
 *   `.entry.ts` file straight to a live Vite `build()` call at CLI-boot time
 *   (attach mode only; see that file's doc comment for why). That build
 *   resolves the entry's OWN relative imports (`../../plugins/source-tag-
 *   plugin.js`, `../../hosts/stamp-policy.js`) the same way Node/Vite always
 *   resolve a relative import — against the entry file's own path on disk,
 *   not against `EDITOR_PAYLOAD_ROOT` or Vite's `root` option. So the payload
 *   has to reproduce the SAME relative depth the checkout has
 *   (`editor-cli/src/attach/stampers/*.entry.ts` sits two directories below
 *   `editor-cli/src/plugins/` and `editor-cli/src/hosts/`) — `attach/stampers/`
 *   nested under the payload root, not the flat `stampers/` an earlier
 *   version of this payload shipped. A flat `stampers/` passed every check
 *   Phase 1 task 3 ran (none of them booted attach mode) and broke on the
 *   first live attach-mode boot with `Could not resolve
 *   '../../plugins/source-tag-plugin.js'` — `payload-gate.mts` leg 8 is what
 *   catches this class of defect; the six copied `plugins/`/`hosts/` files
 *   are the full transitive VALUE-import closure of the three stamper
 *   entries (`import type` edges don't need their target file to exist —
 *   Vite's SSR build erases type-only imports before module resolution).
 *
 * Every resolver is env-override-first, dev-walk-up-second, and reads the env
 * var fresh on every call (never cached) — tests set it per-case and the CLI
 * itself must not depend on a particular import order to see it.
 */

import { isAbsolute, resolve as resolvePath } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Absolute path to the packaged payload root, or `null` in a checkout.
 * Set by the packaged app (Electron, or a future standalone install) to the
 * directory holding `ui/`, `assets/`, `stampers/`, `icon-preview/` and
 * `package.json` — see the module doc comment for the full layout.
 *
 * Deliberately re-reads `process.env` on every call rather than caching at
 * module load: tests set/restore the variable per-case, and nothing about
 * boot order should determine whether the CLI sees it.
 *
 * A relative value is refused rather than silently falling back to the dev
 * walk-up — a packaged app that mis-sets this must fail loudly (wrong
 * directory entirely) rather than quietly serve whatever the checkout-shaped
 * fallback happens to resolve to on the target machine, which could be
 * nothing, or worse, something that exists but is wrong.
 *
 * Deliberately does NOT check existence here — callers already produce good
 * errors when a resolved file is missing (e.g. `core.ts`'s "run npm run
 * build:bridge" message). Adding an existence check here would just produce
 * a second, worse-worded version of the same error.
 *
 * Checks for "effectively unset" with `raw.trim() === ""`, but never trims
 * the value it actually RETURNS or validates. A directory name with a
 * leading or trailing space is valid on both macOS and Linux — trimming the
 * whole value would silently rewrite such a path into a DIFFERENT one that
 * doesn't exist on disk, and every resolver below would then point outside
 * the real payload with no error at all (a missing `ui/`, `stampers/`,
 * `icon-preview/`, each reported as its own unrelated-looking failure
 * further down the boot). `.trim()` earlier only ever needed to answer one
 * question — "is this value blank/whitespace, i.e. functionally unset" —
 * and checking that without also mutating the value is enough to answer it.
 * One consequence, and it is deliberate, not an oversight: a value with
 * accidental whitespace PADDING around an otherwise-valid path (e.g. a
 * wrapper script that introduced a stray leading space) now fails the
 * `isAbsolute` check below and throws, rather than being silently
 * "corrected" — consistent with the relative-path case just below, this
 * function fails loudly on a malformed value instead of guessing what was
 * meant.
 */
export function payloadRoot(): string | null {
  const raw = process.env.EDITOR_PAYLOAD_ROOT
  if (raw === undefined) return null
  if (raw.trim() === "") return null
  if (!isAbsolute(raw)) {
    throw new Error(
      `EDITOR_PAYLOAD_ROOT must be an absolute path, got: ${JSON.stringify(raw)}`,
    )
  }
  return raw
}

/**
 * The dev-checkout fallback paths, as pure math over a module's own file
 * path — no `process.env` read, no `import.meta.url` read. Factored out so a
 * test can call it with BOTH `editor-cli/src/payload-paths.ts` (this file,
 * today) and `editor-cli/dist/cli.js` (this file's post-bundle location) and
 * assert the results agree. That assertion is what actually protects the
 * bundle: this file's prose can claim depth-invariance, but only a test that
 * feeds both locations through the same function proves it.
 *
 * Every value is anchored on `repoRoot` — found once by walking up from
 * `modulePath` — and then extended by the FULL fixed path from the repo root,
 * never by a second relative walk from `modulePath` itself. That is what
 * makes every one of these correct regardless of whether `modulePath` sits
 * under `editor-cli/src/` or `editor-cli/dist/`: `repoRoot` lands in the same
 * place either way (both are exactly two path segments below the repo root —
 * `editor-cli/src/<file>` and `editor-cli/dist/<file>` — so three `..` pops
 * reach it from either), and everything appended after that point names an
 * actual source location (e.g. the stamper `.entry.ts` files, which are never
 * bundled and always live under `editor-cli/src/attach/stampers`
 * regardless of which of `src`/`dist` is currently running).
 */
export function devPathsFrom(modulePath: string): {
  uiBundleRoot: string
  bridgeBundlePath: string
  html2canvasPath: string
  stampersDir: string
  editorCliPackageJson: string
  iconPreviewDir: string
  demoFixtureDir: string
} {
  const repoRoot = resolvePath(modulePath, "..", "..", "..")
  return {
    uiBundleRoot: resolvePath(repoRoot, "editor-cli", "ui-src", "dist"),
    bridgeBundlePath: resolvePath(repoRoot, "dist", "bridge-bundle.js"),
    html2canvasPath: resolvePath(repoRoot, "public", "vendor", "html2canvas.min.js"),
    stampersDir: resolvePath(repoRoot, "editor-cli", "src", "attach", "stampers"),
    editorCliPackageJson: resolvePath(repoRoot, "editor-cli", "package.json"),
    iconPreviewDir: resolvePath(repoRoot, "src", "editor", "icon-preview"),
    demoFixtureDir: resolvePath(repoRoot, "editor-cli", "demo"),
  }
}

/** This module's own path, resolved fresh per call (see {@link payloadRoot}). */
function here(): string {
  return fileURLToPath(import.meta.url)
}

/** `<payload>/ui`, or `<repo>/editor-cli/ui-src/dist` in a checkout. */
export function resolveUiBundleRoot(): string {
  const root = payloadRoot()
  if (root !== null) return resolvePath(root, "ui")
  return devPathsFrom(here()).uiBundleRoot
}

/** `<payload>/assets/bridge-bundle.js`, or `<repo>/dist/bridge-bundle.js` in a checkout. */
export function resolveBridgeBundlePath(): string {
  const root = payloadRoot()
  if (root !== null) return resolvePath(root, "assets", "bridge-bundle.js")
  return devPathsFrom(here()).bridgeBundlePath
}

/**
 * `<payload>/assets/html2canvas.min.js`, or
 * `<repo>/public/vendor/html2canvas.min.js` in a checkout.
 */
export function resolveHtml2canvasPath(): string {
  const root = payloadRoot()
  if (root !== null) return resolvePath(root, "assets", "html2canvas.min.js")
  return devPathsFrom(here()).html2canvasPath
}

/**
 * `<payload>/attach/stampers`, or `<repo>/editor-cli/src/attach/stampers` in
 * a checkout. These are `.entry.ts` SOURCE files fed to a live Vite build at
 * boot time (see `write-stampers.ts`) — never bundled themselves — so the
 * dev fallback always points under `src/`, independent of whether the code
 * asking for it is currently running from `editor-cli/src` or (post-bundle)
 * `editor-cli/dist`.
 *
 * `attach/stampers`, not a flat `stampers` — the entry files import sibling
 * source by RELATIVE path (`../../plugins/source-tag-plugin.js`,
 * `../../hosts/stamp-policy.js`), resolved by Vite against the entry file's
 * own location on disk at build time. The payload has to sit those two
 * directories at the SAME relative depth the checkout has them at, or that
 * resolution lands outside the payload entirely. See the module doc comment.
 */
export function resolveStampersDir(): string {
  const root = payloadRoot()
  if (root !== null) return resolvePath(root, "attach", "stampers")
  return devPathsFrom(here()).stampersDir
}

/**
 * `<payload>/package.json`, or `<repo>/editor-cli/package.json` in a
 * checkout. Used as a build-freshness key (stamper bundling) and a version
 * source (Next loader cache namespacing) — never parsed here, callers own
 * that.
 */
export function resolveEditorCliPackageJson(): string {
  const root = payloadRoot()
  if (root !== null) return resolvePath(root, "package.json")
  return devPathsFrom(here()).editorCliPackageJson
}

/**
 * `<payload>/icon-preview`, or `<repo>/src/editor/icon-preview` in a
 * checkout. `src/editor/icon-preview/render.ts` lives in the ROOT `src/`
 * tree and cannot import this module (the dependency runs the other way —
 * `editor-cli` depends on root `src/`, never the reverse), so it keeps a
 * small local copy of this same env-var read rather than importing it. This
 * export exists for the packaging script (Phase 1 task 2), which DOES run
 * from `editor-cli/` and needs to know where to copy the icon-preview
 * scripts from.
 */
export function resolveIconPreviewDir(): string {
  const root = payloadRoot()
  if (root !== null) return resolvePath(root, "icon-preview")
  return devPathsFrom(here()).iconPreviewDir
}

/**
 * `<payload>/demo`, or `<repo>/editor-cli/demo` in a checkout.
 *
 * The bundled demo prototype: a standalone Vite + React app the launcher copies
 * to `~/.desde/demo/` on first click. Source is tracked; its `node_modules` are
 * installed into the staged payload at packaging time, which is what keeps the
 * `lightningcss` native binary correct per architecture.
 *
 * A missing directory is not this function's problem — it returns a path, and
 * the materializer decides what to do when nothing is there. That matters
 * because a payload built with `--skip-install`, or a checkout where the demo
 * has not been installed, is a normal state and must not make the CLI throw on
 * a code path nobody asked for.
 */
export function resolveDemoFixtureDir(): string {
  const root = payloadRoot()
  if (root !== null) return resolvePath(root, "demo")
  return devPathsFrom(here()).demoFixtureDir
}
