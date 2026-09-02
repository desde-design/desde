/**
 * Shared classifier for "does this `path.relative` result actually
 * escape the base it was computed against" — used by every repo-relative
 * helper in this directory that has to answer that question
 * (`edit-ack.ts`'s `toRel` + `findMatchingExternalRoot`,
 * `sdk-write-guard.ts`'s `toRepoRelative`,
 * `write-invalidate-hook.ts`'s `resolveRepoRelative`) so they can't
 * drift out of sync again.
 *
 * History:
 * - `toRel` originally checked a blunt `rel.startsWith('..')`, which also
 *   matches a legally-named child whose name happens to start with two
 *   dots (`..fixture.vue`) — misclassifying a perfectly normal file as a
 *   root escape (Task 14 review round-2 P2). Fixed there by requiring
 *   the `..` be a full PATH SEGMENT, not just a string prefix.
 * - That fix was then hand-copied into `toRepoRelative` (and
 *   `resolveRepoRelative`), but with a HARDCODED POSIX `'../'` literal.
 *   `path.relative` returns platform-NATIVE separators — `\` on Windows,
 *   `/` on POSIX — so on Windows an actual escape (`..\\outside.txt`)
 *   has no `/` in it and silently passed as "in-root" (Task 14 review
 *   round-3 P2): `toRepoRelative` gated a file READ (info-leak) and
 *   `resolveRepoRelative` gated a Vite-invalidation resolve.
 *
 * Checks BOTH separator forms EXPLICITLY (`\` and `/`), not
 * `path.sep` — `path.sep` is only the separator of whatever OS the CODE
 * happens to be running on, so a check built from it "happens to work"
 * in production (a Windows host's `path.relative` output and that same
 * host's `path.sep` naturally agree) but can't be verified on a POSIX
 * CI runner, and silently reopens this exact gap if `path.relative` is
 * ever swapped for something that doesn't perfectly track `path.sep`.
 * Hardcoding both makes the classification correct — and testable — on
 * every host, independent of which one it runs on.
 *
 * NOT used by `editor-cli/src/server/session-lock.ts`'s
 * `normalizeLockPath` — that function deliberately canonicalizes every
 * input to POSIX-style forward slashes FIRST (via `path.posix.*`) so its
 * lock keys are separator-independent regardless of host OS; its own
 * escape check operates on an already-POSIX-only string, so sharing this
 * (POSIX-or-win32) classifier there would be a no-op at best. Its escape
 * check was independently audited and boundary-fixed in round 2 — see
 * its inline comment.
 */

/**
 * True when `rel` (a `path.relative` result) escapes the base it was
 * computed against: `rel === '..'` exactly (resolves to the base's
 * immediate parent, no trailing segment) or `rel` starts with a `..`
 * PATH SEGMENT, POSIX (`../`) or win32 (`..\`) form.
 */
export function isRootEscape(rel: string): boolean {
  return rel === '..' || rel.startsWith('../') || rel.startsWith('..\\')
}
