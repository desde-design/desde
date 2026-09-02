import path from "node:path"
import type { StampPolicy } from "./types.js"

/**
 * The ONE implementation of "may this file be stamped, and what path goes in
 * the stamp" — shared by `source-tag-plugin.ts`, `jsx-source-tag-plugin.ts` and
 * (across a process boundary, as plain JSON) the Next Turbopack loader.
 *
 * **Why one implementation.** Stamping a file is a PROMISE THAT AN EDIT WILL
 * LAND: the bridge offers every stamped element as an edit target, and the edit
 * server resolves the stamped path back through `resolve-editable-path.ts`'s
 * containment guard. When the two disagree the user gets a selectable element
 * whose every edit 400s — a failure that surfaces minutes after boot, mid-click,
 * with nothing in the logs. The rule is therefore derived from the same place
 * for both sides (see `stamp-root-parity.test.ts`), not written twice.
 *
 * The rule the two plugins carried until this module replaced it was
 * `id.includes("/node_modules/")` paired with a bare `relative(repoRoot, id)`,
 * and it was wrong in both directions:
 *
 *  - **Too narrow.** It admits any file outside the repo that has no
 *    `node_modules` segment — a linked or sibling first-party file — producing
 *    `../outside-lib/Card.tsx:6:4`, which the edit server refuses with "File
 *    path escapes prototype root".
 *  - **Too broad.** Substring, not segment: a repo that itself lives under a
 *    `node_modules` directory would have every one of its own files skipped.
 *
 * Leaving an element unstamped is strictly better than stamping it and
 * refusing: the bridge walks up to the nearest stamped ancestor, which is an
 * editable target that works.
 */

/**
 * Segments that disqualify a file everywhere, for every host.
 *
 * Exactly `node_modules` — the same segment-exact test `edit-handler.ts` runs
 * for the token-value lane, so the plugin guard and the server guard agree on
 * the word. Build output is NOT here: `.nuxt` / `.astro` / `.next` are
 * per-host, they are legal directory names elsewhere in a repo, and a host
 * declares its own through `DevServerHost.buildDirs` → {@link StampPolicy.denyDirs}.
 */
export const DEFAULT_DENY_SEGMENTS: readonly string[] = ["node_modules"]

export interface StampPolicyInput {
  /** Git root, as the user typed it. Always becomes a root. */
  repoRoot: string
  /**
   * The same root with symlinks resolved, when it differs — `core.ts` computes
   * it and passes `undefined` when it does not.
   *
   * Load-bearing, and it used to be dropped on the floor at the plugin
   * construction site. Vite defaults to `preserveSymlinks: false`, so a
   * checkout reached through a symlink hands the stamper module ids anchored at
   * the REAL path (`/private/tmp/...`) while `repoRoot` is the typed path
   * (`/tmp/...`) — exactly what macOS does to anything under `/tmp`.
   * Relativising against the typed root then yields `../private/tmp/...` for
   * every stamp in the repo, and every edit 400s. Proved red on a real
   * symlinked fixture in `__tests__/stamp-root-parity.test.ts`.
   */
  repoRootReal?: string | undefined
  /**
   * Root the host's `buildDirs` are relative to — `repoRoot` or a subdirectory
   * of it. Defaults to `repoRoot`.
   */
  prototypeRoot?: string
  /** From `DevServerHost.buildDirs`, e.g. `[".nuxt", "dist"]`. */
  buildDirs?: readonly string[]
}

/**
 * **There is deliberately no `extraRoots`.** An earlier draft carried one, on
 * the reasoning that widening to a linked sibling directory should be a config
 * change rather than a redesign. Measured against the implementation, that was
 * wrong in a way worth recording so it is not re-added.
 *
 * `roots` exists to hold the two ALIASES of one tree (typed and
 * symlink-resolved), which name the same files — so relativising against
 * whichever contains the id yields the same repo-relative string either way. A
 * genuinely different root breaks that: with a root at `/other`,
 * `/other/src/A.vue` stamps as `src/A.vue`, which the edit server resolves
 * against the prototype root and lands on `/repo/src/A.vue` — a DIFFERENT
 * EXISTING FILE. Not a dead stamp that 400s; a silent write to the wrong file.
 *
 * So widening reach is a change to the stamp FORMAT (it would have to carry
 * which root it came from) and to the edit server's resolver, in one commit —
 * not a list this module can safely accept. Hence: no field.
 */

/**
 * Build the policy. Pure: no filesystem access, no realpath — the caller
 * supplies `repoRootReal` because it already computed it once at boot.
 */
export function buildStampPolicy(input: StampPolicyInput): StampPolicy {
  const repoRoot = normalizeRoot(input.repoRoot)
  const prototypeRoot = normalizeRoot(input.prototypeRoot ?? input.repoRoot)

  // `stampRoot` is the CANONICAL root, because that is what the other side of
  // the promise uses: `resolvePrototypeRoot` realpaths the repo root before
  // resolving any client-supplied path against it. Anchoring stamps anywhere
  // else would put the two guards on different trees.
  const stampRoot = input.repoRootReal ? normalizeRoot(input.repoRootReal) : repoRoot

  // Order is documented as insignificant — `stampRoot` is an explicit field
  // precisely so nothing depends on a positional convention — but a Set keeps
  // the non-symlinked case from listing the same directory twice.
  const roots = [...new Set([stampRoot, repoRoot])]

  // Build dirs must be anchored under EVERY root, not just the typed one.
  // Anchoring them at `prototypeRoot` alone (which defaults to the typed
  // `repoRoot`) meant that on the symlinked checkout this module exists to fix,
  // containment admitted `/private/tmp/x/.nuxt/foo.js` via the resolved root
  // while the denial compared it against `/tmp/x/.nuxt` and missed — so build
  // output was denied on exactly the layouts where it was NOT denied before,
  // and stamped on the one layout that motivated the module. Found by two
  // independent reviewers, both measuring it.
  //
  // The offset from repo root to prototype root is what is stable across
  // aliases, so map that offset into each root rather than resolving the
  // absolute `prototypeRoot` twice. If the caller passed a `prototypeRoot`
  // outside `repoRoot` the offset escapes and there is no sane mapping — fall
  // back to the literal path, which is still correct for that root.
  const protoOffset = path.relative(repoRoot, prototypeRoot)
  const offsetEscapes =
    path.isAbsolute(protoOffset) ||
    protoOffset === ".." ||
    protoOffset.startsWith(".." + path.sep)
  const prototypeRoots = offsetEscapes
    ? [prototypeRoot]
    : [...new Set(roots.map((root) => normalizeRoot(path.resolve(root, protoOffset))))]

  const buildDirs = input.buildDirs ?? []
  const denyDirs = [
    ...new Set(
      prototypeRoots.flatMap((base) =>
        buildDirs.map((dir) => normalizeRoot(path.resolve(base, dir))),
      ),
    ),
  ]

  return {
    roots,
    denySegments: [...DEFAULT_DENY_SEGMENTS],
    denyDirs,
    stampRoot,
  }
}

/**
 * How a stamper is told what it may stamp.
 *
 * Two forms, because there are two kinds of caller and only one of them knows
 * enough to build a policy:
 *
 *  - `{ policy }` — every in-process host. It has resolved the symlinked root
 *    and knows the framework's build directories, so it passes the whole rule.
 *  - `{ repoRoot }` — attach mode's generated wrapper modules
 *    (`attach/stampers/*.entry.ts`, which derive a root from their own location
 *    inside the user's repo) and any hand-written `vite.config` that imports the
 *    plugin directly. This is a documented public surface, not a test
 *    affordance.
 *
 * The shorthand is a shorter way to SAY the policy, not a second implementation
 * of it: it expands to `buildStampPolicy({ repoRoot })` and goes through the
 * identical containment and denial rules.
 */
export type StampScope = { policy: StampPolicy } | { repoRoot: string }

/** Expand a {@link StampScope} to the policy both forms ultimately mean. */
export function resolveStampPolicy(scope: StampScope): StampPolicy {
  return "policy" in scope ? scope.policy : buildStampPolicy({ repoRoot: scope.repoRoot })
}

/**
 * Is this arbitrary value a policy we can safely stamp with?
 *
 * Needed because a policy does not always arrive from `buildStampPolicy` in
 * this process. The Next lane's stamper is a Turbopack loader, and Turbopack
 * runs loaders in a FORKED WORKER — the policy crosses that boundary as JSON
 * (which is why {@link StampPolicy} is compiler-constrained to JSON in
 * `types.ts`). On the far side it is untyped data, and the type annotation the
 * loader would otherwise put on it is a claim nothing checked.
 *
 * The failure this closes is asymmetric, which is why it is a hard check rather
 * than a coerce-and-continue:
 *
 *  - A policy that is MISSING a field throws inside `relativeWithinRoots`
 *    (`undefined.includes`), the loader's catch-all swallows it, and every file
 *    goes unstamped — recoverable, and `verifyStamping` sees zero stamps and
 *    refuses the boot loudly.
 *  - A policy whose ROOTS are wrong does not throw. It stamps every file with a
 *    path relative to the wrong tree, `verifyStamping` counts a healthy stamp
 *    count and passes, and the user discovers it minutes later when an edit
 *    resolves onto a different existing file.
 *
 * So a malformed policy must be REFUSED at the boundary rather than repaired or
 * substituted: the caller (`next-loader.entry.ts`) declines to stamp, which
 * routes the failure into the gate designed to catch it.
 *
 * `roots` must contain `stampRoot` because {@link StampPolicy} says so, and
 * because a `stampRoot` outside `roots` is exactly the shape that stamps
 * against a tree containment never checked.
 */
export function isStampPolicy(value: unknown): value is StampPolicy {
  if (typeof value !== "object" || value === null) return false
  const candidate = value as Partial<Record<keyof StampPolicy, unknown>>
  if (!isAbsolutePathArray(candidate.roots) || candidate.roots.length === 0) return false
  if (!isStringArray(candidate.denySegments)) return false
  if (!isAbsolutePathArray(candidate.denyDirs)) return false
  if (typeof candidate.stampRoot !== "string" || candidate.stampRoot.length === 0) return false
  return candidate.roots.includes(candidate.stampRoot)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0)
}

/**
 * Roots and build dirs are compared with `path.relative`, which silently
 * resolves a relative root against `process.cwd()` — and the loader's cwd is
 * the forked worker's, not ours. An absolute check here keeps that from
 * becoming a containment test against an arbitrary directory.
 */
function isAbsolutePathArray(value: unknown): value is string[] {
  return isStringArray(value) && value.every((item) => path.isAbsolute(item))
}

/**
 * May this file be stamped?
 *
 * `absPath` must be ABSOLUTE and query-stripped — a caller passes Vite's id
 * with `?t=<ts>` / `?vue&type=script` already removed. Neither is normalised
 * here on purpose: a `?` is legal in a filename, so truncating one would be a
 * guess, and resolving a relative id against `process.cwd()` would let a
 * virtual module id land inside the repo by accident. Both are refused instead.
 */
export function isStampable(policy: StampPolicy, absPath: string): boolean {
  return relativeWithinRoots(policy, absPath) !== null
}

/**
 * The path to write into `data-desde-src`, or `null` when the file is not
 * stampable — one call answering both questions, so a caller cannot check one
 * and emit the other.
 *
 * Relativised against the root that CONTAINS the file rather than
 * unconditionally against `stampRoot`. On a symlinked checkout both roots name
 * the same tree, so either yields the same repo-relative string for a file
 * genuinely inside it — but only the containing root yields that string for an
 * id anchored at the *other* alias, which is the whole point of carrying two.
 */
export function stampPathFor(policy: StampPolicy, absPath: string): string | null {
  return relativeWithinRoots(policy, absPath)
}

/**
 * Root-containment + segment-exact denial + build-dir denial, in that order.
 * Returns the root-relative path on success so callers never re-derive it.
 */
function relativeWithinRoots(policy: StampPolicy, absPath: string): string | null {
  if (!path.isAbsolute(absPath)) return null
  const target = path.normalize(absPath)

  let rel: string | null = null
  for (const root of policy.roots) {
    const candidate = containedRelative(root, target)
    if (candidate !== null) {
      rel = candidate
      break
    }
  }
  if (rel === null) return null

  const segments = rel.split(path.sep)
  if (segments.some((segment) => policy.denySegments.includes(segment))) return null

  // Build output (`.nuxt`, `.next`, …) sits INSIDE the repo root, so
  // containment admits it, and its contents are regenerated on the next boot —
  // a stamp there is a stamp on a file that will not exist by the time anyone
  // edits it.
  for (const dir of policy.denyDirs) {
    if (containedRelative(dir, target) !== null || target === dir) return null
  }

  return rel
}

/**
 * `path.relative`, never `startsWith` — otherwise `/repo-backup` passes for
 * root `/repo`, which is the classic string-prefix containment bug and here it
 * would stamp files from a directory the edit server refuses.
 *
 * Returns the relative path when `target` is strictly inside `root`, else null.
 * The `..` test is segment-aware (`".."` exactly, or `"../"`) rather than a
 * bare `startsWith("..")`, which would reject a legitimately-named `..rc` file
 * sitting in the root.
 */
function containedRelative(root: string, target: string): string | null {
  const rel = path.relative(root, target)
  if (rel === "" || path.isAbsolute(rel)) return null
  if (rel === ".." || rel.startsWith(".." + path.sep)) return null
  return rel
}

/** Absolute, normalised, no trailing separator — so containment compares like with like. */
function normalizeRoot(root: string): string {
  return path.resolve(root)
}
