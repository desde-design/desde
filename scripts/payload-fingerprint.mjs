// The single source of truth for "what determines a staged payload's bytes".
//
// F9 (whole-branch review, fourth pass, P1 fix). `desktop/scripts/
// payload-manifest-guard.mjs`'s freshness check (F2, extended by F7) used
// `git status` to decide whether a payload might be stale — but git answers
// "what changed since a commit", not the question packaging-time freshness
// actually needs: "do the payload's bytes match what this tree would
// produce right now". Two gaps proved those aren't the same question:
//
//   1. `build-server-package.mts` — the STAGING RECIPE ITSELF — sat outside
//      every git pathspec the freshness check scoped to. Change what gets
//      copied, or how the manifest is generated, and payload bytes change
//      while a git-based check still reports clean.
//   2. `editor-cli/dist/**` and `editor-cli/ui-src/dist/**` — the actual
//      server and UI bundles `copyArtifacts()` copies into the payload
//      VERBATIM — are gitignored. `git status` cannot report a change
//      there no matter how it is scoped: these are the two largest,
//      most-likely-to-drift things in the whole payload, and they were
//      structurally invisible to every git-based check that came before
//      this one.
//
// Content hashing sidesteps both: it reads what is actually on disk right
// now, gitignored or not, staging recipe included.
//
// Plain, un-typechecked JS (no build step) so BOTH sides of the freshness
// check can import the IDENTICAL algorithm with no transpilation in
// between: `scripts/build-server-package.mts` (a `.mts` file run via
// tsx, which imports plain `.mjs` modules with no special handling) at
// STAGING time, and `desktop/scripts/payload-manifest-guard.mjs` (plain JS,
// run directly via `node` with no tsx in its invocation path at all — see
// that file's own doc comment on why) at PACKAGING time. One algorithm, two
// call sites, never two copies that could quietly drift apart.
import { createHash } from "node:crypto"
import { readdirSync, readFileSync } from "node:fs"
import { join, relative, sep } from "node:path"

/**
 * Every path that determines a staged payload's bytes, each tagged with
 * whether it is a single file or a directory to walk recursively, and which
 * CLASS of input it is — see the class list right below for what each one
 * means and, deliberately, for the class boundary being the unit a future
 * addition should reason in, not a flat path list. F11 (whole-branch
 * review, fifth pass, P1 fix) added the `recipe`/`build-config` split after
 * a review round found five direct staging inputs missing — all of them
 * `build-config`, none of them application source — which a class-organized
 * list makes structurally harder to under-extend than one more path
 * appended to an undifferentiated array.
 *
 * ── The five classes ─────────────────────────────────────────────────────
 *
 *   - `recipe` — the staging script itself: the code that decides WHAT gets
 *     copied into the payload and how the manifest is generated.
 *   - `build-config` — the tooling and configuration that decides HOW the
 *     `built-output` class below gets produced from the `source-tree`
 *     class. Changing one of these changes payload bytes without touching
 *     a line of application source — the exact shape F11 found missing.
 *   - `built-output` — the actual bytes `copyArtifacts()` copies into the
 *     payload, verbatim. Gitignored; this is the gap a git-based check can
 *     never close, at any pathspec scope (F9's original motivation).
 *   - `source-tree` — application source that `build-config` compiles into
 *     `built-output`. Covering source as well as built output means an
 *     edit that was never rebuilt still changes the fingerprint — the
 *     tree's true "if rebuilt right now" output differs from what is
 *     currently staged, even on the rare occasion the stale built bytes
 *     happen to still match byte-for-byte.
 *   - `committed-asset` — pre-built artifacts checked into git and copied
 *     verbatim; nothing rebuilds them as part of packaging, so their own
 *     content is what matters, not whatever source might correspond to them.
 *
 * ── What IS covered ──────────────────────────────────────────────────────
 *
 *   - `scripts/build-server-package.mts` (recipe). Its own direct
 *     imports (`editor-cli/src/payload-paths.ts`,
 *     `src/editor/packaging/derive-payload-dependencies.ts`) are NOT listed
 *     separately — both already sit inside a directory this list hashes
 *     wholesale (`editor-cli/src`, `src`), so a second, explicit entry
 *     would be redundant, not more correct.
 *   - `editor-cli/package.json` (build-config) — `generatePackageJson`
 *     reads its `name`/`version`/`engines` fields directly into the
 *     generated payload `package.json`.
 *   - `editor-cli/scripts/build-server.mjs` (build-config) — the esbuild
 *     invocation that produces the server bundle. Only imports `esbuild`
 *     (an npm package) and Node builtins — no further local file to trace.
 *   - `editor-cli/tsconfig.json` (build-config) — drives module/alias
 *     resolution (`@/*` → root `src/*`) for that same bundle.
 *   - `editor-cli/ui-src/vite.config.ts` (build-config) — the Vite config
 *     that produces the UI bundle. Its own imports are all npm packages
 *     (`vite`, `@vitejs/plugin-react`, `@tailwindcss/postcss`) plus
 *     `node:path`, so there is no further local MODULE to trace. It does,
 *     however, read repo-root `.env*` files at build time and inject any
 *     `NEXT_PUBLIC_*` values into the bundle — and those files are NOT
 *     fingerprinted (see "What is NOT covered"). Editing only a `.env`
 *     therefore changes the built UI without moving this hash.
 *   - `editor-cli/ui-src/index.html` (build-config) — Vite's own UI entry
 *     point; its content (which scripts/styles it references) is itself an
 *     input to what the built UI bundle contains.
 *   - `editor-cli/dist`, `editor-cli/ui-src/dist` (built-output) — the
 *     built server and UI bundles, copied into the payload VERBATIM.
 *   - `editor-cli/src`, `editor-cli/ui-src/src` (source-tree) — the source
 *     that produces the two bundles above (and, for `editor-cli/src`, also
 *     the `attach/stampers/*.entry.ts` + support files and
 *     `icon-preview/*.mjs` that `copyArtifacts()` copies as raw source, not
 *     a build output).
 *   - `src` (repo root, source-tree) — the shared core `editor-cli`'s own
 *     `tsconfig.json` (above) resolves `@/*` to; both `editor-cli/src` and
 *     `editor-cli/ui-src/src` reach into it.
 *   - `dist/bridge-bundle.js`, `public/vendor/html2canvas.min.js`
 *     (committed-asset).
 *
 * ── What is NOT covered, on purpose ──────────────────────────────────────
 *
 *   - Repo-root `.env*` files. `editor-cli/ui-src/vite.config.ts` loads
 *     them and injects any `NEXT_PUBLIC_*` values into the UI bundle, so
 *     editing one genuinely changes payload bytes without moving this
 *     hash. Excluded because a `.env` is machine-local and frequently
 *     uncommitted: fingerprinting it would make the check fire on ordinary
 *     local configuration differences, and a guard that refuses legitimate
 *     builds is the failure mode this module has already had to walk back
 *     once. Named here rather than papered over.
 *   - `node_modules` anywhere (repo root's or `editor-cli`'s). Hashing an
 *     installed dependency tree is exactly the cost this module exists to
 *     avoid ("fingerprint the INPUTS, not the output" — hashing the staged
 *     payload's own ~8,473 files, or a `node_modules` tree of comparable
 *     size, would turn a sub-100ms check into a multi-second one for every
 *     single package invocation). A concrete, PARTIALLY covered consequence:
 *     a dependency VERSION bump (an `editor-cli/package-lock.json` edit, or
 *     an `npm install` that changes what's resolved, WITHOUT also touching
 *     `editor-cli/package.json`) is not reflected here. This is a real,
 *     named gap, not a silently widened claim — `derivePayloadDependencies`
 *     (imported by the staging recipe) resolves each dependency's PINNED
 *     version by reading the actual installed package on disk at build
 *     time, which is the only accurate source for that question and is not
 *     cheaply fingerprintable without hashing `node_modules` itself.
 *   - Anything outside the paths listed above — `docs/`, `viewer/`,
 *     `mcp-server/`, `desktop/` itself, an unrelated submodule, a root
 *     scratch file. A change there cannot affect a single byte of what
 *     ends up inside the payload, so it must never affect this fingerprint
 *     (this is F7's fix, generalized: the boundary that made the git-based
 *     check correctly IGNORE unrelated changes carries over unchanged to
 *     content hashing).
 *
 * ── On the shape of this list itself ─────────────────────────────────────
 *
 * This is a hand-maintained enumeration, not a derivation from the actual
 * build graph — it can only ever be as complete as the last person to
 * update it was thorough. That is a real, structural limit, not a bug to
 * fix with one more path: this module is a STALENESS HEURISTIC over the
 * inputs someone identified as load-bearing, not a proof that no byte of
 * the payload could possibly have changed. Treat it accordingly — it is
 * meant to catch the common, dangerous cases (a rebuilt bundle, an edited
 * recipe or its direct build config, uncommitted source), not to guarantee
 * bit-for-bit reproducibility.
 *
 * Extending this list (a future payload input) is exactly that: add one
 * entry, in the class it belongs to, with a one-line reason. Nothing else
 * needs to change — both call sites read this same array.
 *
 * @type {Array<{ class: "recipe" | "build-config" | "built-output" | "source-tree" | "committed-asset"; kind: "file" | "dir"; path: string }>}
 */
export const FINGERPRINT_INPUTS = [
  // recipe
  { class: "recipe", kind: "file", path: "scripts/build-server-package.mts" },

  // build-config
  { class: "build-config", kind: "file", path: "editor-cli/package.json" },
  { class: "build-config", kind: "file", path: "editor-cli/scripts/build-server.mjs" },
  { class: "build-config", kind: "file", path: "editor-cli/tsconfig.json" },
  { class: "build-config", kind: "file", path: "editor-cli/ui-src/vite.config.ts" },
  { class: "build-config", kind: "file", path: "editor-cli/ui-src/index.html" },

  // built-output
  { class: "built-output", kind: "dir", path: "editor-cli/dist" },
  { class: "built-output", kind: "dir", path: "editor-cli/ui-src/dist" },

  // source-tree
  { class: "source-tree", kind: "dir", path: "editor-cli/src" },
  { class: "source-tree", kind: "dir", path: "editor-cli/ui-src/src" },
  { class: "source-tree", kind: "dir", path: "src" },

  // committed-asset
  { class: "committed-asset", kind: "file", path: "dist/bridge-bundle.js" },
  { class: "committed-asset", kind: "file", path: "public/vendor/html2canvas.min.js" },
]

/**
 * Every regular file's absolute path under `absDir`, found by a recursive
 * walk, sorted so the result (and therefore the fingerprint) is stable
 * regardless of filesystem readdir order. Symlinks are NOT followed —
 * a symlink pointing outside the fingerprinted trees must not silently pull
 * in bytes this module never declared it covers (same caution
 * `macho-scan.mjs` documents for its own file walk). A directory that
 * doesn't exist yet (a fresh checkout before its first build) contributes
 * no files rather than throwing — the fingerprint still means something for
 * whichever inputs DO currently exist.
 */
function listFilesSorted(absDir) {
  const found = []
  function walk(dir) {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) found.push(full)
    }
  }
  walk(absDir)
  return found.sort()
}

/**
 * The payload fingerprint: one sha256 hex digest over every file named by
 * {@link FINGERPRINT_INPUTS}, each stamped with its repo-relative POSIX path
 * (so a rename or a file moving between two of these roots changes the
 * fingerprint even when no byte of content does) followed by its content,
 * walked in a fixed, deterministic order. Measured on this repo: ~2,160
 * files, ~35MB, under 100ms — see this module's own doc comment for the
 * files knowingly excluded to keep it that cheap.
 *
 * A single FILE input that doesn't exist yet is skipped, same tolerance as
 * a missing directory — a fresh checkout before its first `editor-cli`
 * build has no `editor-cli/dist` to hash, and the fingerprint of "nothing
 * built yet" is still a valid, comparable value (it just won't match a
 * later, real build's).
 *
 * @param {string} repoRoot
 * @returns {string}
 */
export function computePayloadFingerprint(repoRoot) {
  const hash = createHash("sha256")
  for (const input of FINGERPRINT_INPUTS) {
    const absPath = join(repoRoot, input.path)
    const files = input.kind === "file" ? [absPath] : listFilesSorted(absPath)
    for (const file of files) {
      let content
      try {
        content = readFileSync(file)
      } catch {
        continue
      }
      const relPath = relative(repoRoot, file).split(sep).join("/")
      hash.update(relPath)
      hash.update("\0")
      hash.update(content)
      hash.update("\0")
    }
  }
  return hash.digest("hex")
}
