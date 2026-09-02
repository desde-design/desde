/**
 * Map a design-token stylesheet back to a prototype-root-relative source path
 * the `token-value` applicator can write — or null when it isn't a writable
 * first-party file. Pure + unit-tested because it's the shell-side mirror of the
 * server's security gate (the `.css`-only + node_modules refusal in
 * editor-cli's edit-handler.ts).
 *
 * TWO sources, tried in that order:
 *
 *  1. **`ref.href`** — a served URL. Vite serves a first-party `<link>`ed
 *     stylesheet at its root-relative path
 *     (`http://localhost:5173/src/styles/tokens.css` → `src/styles/tokens.css`);
 *     `?v=hash` cache-busting lands in `.search`, so `.pathname` is already
 *     clean. When the prototype is served under a non-root Vite `base` (e.g.
 *     `/app/`), pass `basePath` so it's stripped first — the edit handler expects
 *     a path relative to the prototype ROOT, not the served URL prefix.
 *  2. **`ref.sourceHint`** — the bundler's declared source file for an embedded
 *     `<style>` (Vite's `data-vite-dev-id`), an ABSOLUTE filesystem path. This is
 *     the common case, not an edge one: Vite dev injects every CSS file imported
 *     from JS as a `<style>` tag, so `href` is null for all first-party
 *     stylesheets and the token scope — the remedy the cascade-failure copy
 *     recommends — was unreachable on any Vite dev substrate. Resolving it needs
 *     `repoRoot` (the shell has it from the CLI bootstrap); without one, or for a
 *     path outside that root, we refuse rather than guess, because a wrong answer
 *     here means writing an unintended file. A symlinked checkout has TWO valid
 *     roots (the path the user typed and its realpath, which Vite's module ids may
 *     be anchored at), so both are tried — see `repoRootReal`.
 *
 * Refused (returns null):
 *  - library sheets (`ref.package` set, i.e. a `node_modules/<pkg>` href or
 *    source hint) — the scope dialog's `availableScopes` already gates these out;
 *    defense-in-depth;
 *  - Vite-internal virtual paths (`/@fs/…` absolute-fs, `/@id/…`, `/@vite/…`)
 *    that don't map cleanly to a root-relative file;
 *  - anything that still contains a `node_modules` or `..` path SEGMENT;
 *  - a source hint that isn't an absolute path under `repoRoot`;
 *  - non-`.css` targets (this includes an SFC `<style>` block, whose Vite dev id
 *    is `…/App.vue?vue&type=style&…` — the `.css`-only token lane can't patch
 *    it), or an empty/unparseable href.
 */
import type { StyleOrigin, StyleStylesheetRef } from "@/types/bridge"

export interface TokenSourceOptions {
  /**
   * Resolved Vite `base` of the served prototype (`EDITOR_VITE_BASE`).
   * Stripped off an `href` so the result is prototype-root-relative. Ignored for
   * a source hint, which is a filesystem path, not a served URL.
   */
  basePath?: string
  /**
   * Absolute prototype repo root (`EDITOR_REPO_ROOT`, from the CLI bootstrap).
   * Required to resolve a `sourceHint`: it is an absolute filesystem path and the
   * handler writes root-relative paths. Absent (web shell / older bootstrap) ⇒
   * source hints don't resolve at all, which reproduces the pre-hint behavior.
   */
  repoRoot?: string
  /**
   * The SAME root with symlinks resolved (`EDITOR_REPO_ROOT_REAL`, realpath'd by
   * the CLI at boot — this module is shell-side React with no filesystem access,
   * so the fs work belongs where fs already lives).
   *
   * Why a second root rather than replacing the first: when the checkout is
   * reached through a symlink, BOTH paths are legitimate roots of the same repo
   * and a source hint can be anchored at either. `repoRoot` is the git root as the
   * CLI derived it (the path the user typed), while Vite resolves module ids
   * through the filesystem (`preserveSymlinks: false` is its default), so a
   * `data-vite-dev-id` may be anchored at the real path. Prefix-matching only one
   * of them silently withheld the token scope — the same class of silent
   * unavailability N3 closed. Accepting either does NOT widen the gate: each is
   * independently a root of this repo, and every other refusal
   * (`acceptWritableCss`) still applies to the relative remainder.
   *
   * Absent ⇒ only `repoRoot` is tried, i.e. exactly the previous behavior.
   */
  repoRootReal?: string
}

export function resolveTokenSourceFile(
  ref: Pick<StyleStylesheetRef, "href" | "package" | "sourceHint">,
  options: TokenSourceOptions = {},
): string | null {
  if (ref.package) return null
  // `href` first: a real URL is authoritative, and for an embedded sheet it is
  // only the synthetic `'<style>'` marker, which never resolves.
  return (
    resolveServedHref(ref.href, options.basePath) ??
    resolveSourceHint(ref.sourceHint, options)
  )
}

/**
 * The writable source file for an origin's ROOT token definition (the last hop
 * of the var chain — the concrete value, which is what a token patch rewrites),
 * or null when there's no token or it isn't writable. The single place that rule
 * lives, so the inspector's scope-enabling check and the token edit itself can't
 * disagree about which file a "The token" choice would write.
 */
export function resolveTokenScopeFile(
  origin: Pick<StyleOrigin, "varChain">,
  options: TokenSourceOptions = {},
): string | null {
  const root = origin.varChain[origin.varChain.length - 1]
  if (!root) return null
  return resolveTokenSourceFile(root.definedAt.stylesheet, options)
}

/** A served stylesheet URL → prototype-root-relative path. */
function resolveServedHref(href: string, basePath?: string): string | null {
  let pathname: string
  try {
    // Base handles already-relative hrefs; absolute hrefs ignore the base.
    pathname = new URL(href, "http://localhost").pathname
  } catch {
    return null
  }
  // Strip the prototype's Vite base prefix so the result is prototype-root-
  // relative (what the edit handler expects). Default base `/` is a no-op.
  if (basePath) {
    const base = basePath.endsWith("/") ? basePath : `${basePath}/`
    if (base !== "/" && pathname.startsWith(base)) {
      pathname = `/${pathname.slice(base.length)}`
    }
  }
  return acceptWritableCss(pathname.replace(/^\/+/, ""))
}

/**
 * A bundler source hint (absolute filesystem path, optionally with a `?query`
 * suffix) → prototype-root-relative path. Deliberately NOT parsed as a URL: a
 * real path can contain characters `new URL()` percent-encodes, and an encoded
 * path would no longer match `repoRoot` (or, worse, would resolve to a
 * different file than the one the bundler named).
 */
function resolveSourceHint(
  hint: string | undefined,
  options: TokenSourceOptions,
): string | null {
  if (!hint) return null
  const filePath = collapseSlashes(hint.split(/[?#]/)[0])
  // Only POSIX-absolute paths — a relative hint has no anchor we can trust, and
  // a Windows path (`C:\…`) isn't a substrate Editor supervises today.
  if (!filePath.startsWith("/")) return null
  // Either root is a legitimate anchor for the same repo (see `repoRootReal`).
  // Match is case-SENSITIVE on purpose: on a case-insensitive volume two casings
  // name one file, on a sensitive one they name two, and this module cannot tell
  // which volume it is looking at — so a casing mismatch stays a refusal rather
  // than a guess. The CLI's realpath normalises casing where that matters.
  for (const candidate of [options.repoRoot, options.repoRootReal]) {
    const root = normalizeRoot(candidate)
    if (root === null) continue
    if (!filePath.startsWith(`${root}/`)) continue
    const accepted = acceptWritableCss(filePath.slice(root.length + 1))
    if (accepted !== null) return accepted
  }
  return null
}

/**
 * A candidate root reduced to a comparable form, or null when it can't anchor
 * anything: blank, not POSIX-absolute, or the filesystem root itself (`/`, whose
 * "relative remainder" would be an absolute-looking path from an unrelated tree,
 * not a repo-relative one).
 */
function normalizeRoot(root: string | undefined): string | null {
  if (!root) return null
  const trimmed = collapseSlashes(root.trim()).replace(/\/+$/, "")
  if (trimmed.length === 0) return null
  if (!trimmed.startsWith("/")) return null
  return trimmed
}

/**
 * `a//b` and `a/b` address the same POSIX path, but only one of them survives a
 * string prefix comparison — so normalise both sides before comparing. Safe
 * because collapsing separators never changes which file a POSIX path names, and
 * it cannot manufacture a `..` segment that `acceptWritableCss` would then miss.
 */
function collapseSlashes(path: string): string {
  return path.replace(/\/{2,}/g, "/")
}

/**
 * The shared gate on a candidate root-relative path — the mirror of the
 * server's. Every refusal here is a "we cannot safely write this", so the caller
 * simply doesn't offer the token scope.
 */
function acceptWritableCss(path: string): string | null {
  if (path.length === 0) return null
  if (/^@(fs|id|vite)\//.test(path)) return null
  const segments = path.split("/")
  if (segments.includes("node_modules")) return null
  // A hint like `<root>/src/../../secrets.css` clears the prefix check but must
  // never reach the handler as a write target.
  if (segments.includes("..")) return null
  // Case-SENSITIVE `.css` to match the server's extension gate exactly
  // (edit-handler.ts uses `endsWith(".css")`). A `.CSS` href would be refused
  // server-side, so don't offer the token scope for it shell-side either.
  if (!path.endsWith(".css")) return null
  return path
}
