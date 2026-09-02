/**
 * Shared bounded-append logic for `appendDeploymentLog`, so both storage
 * impls truncate at exactly the same byte and emit exactly the same marker.
 * Two copies of this drifted apart in review of an earlier phase; one copy
 * makes the conformance suite meaningful rather than coincidental.
 */
export const LOG_TRUNCATION_MARKER = "\n[log truncated, build continued]\n"

/**
 * Hard cap on a deployment's `buildLog`, in characters — `appendBounded`
 * treats JS string length as the byte count throughout this module and its
 * callers. Lives here, alongside `appendBounded`, rather than in
 * `build/build-queue.ts` (which re-exports it for its own callers): the
 * STORAGE layer has its own caller of `appendBounded` that has nothing to do
 * with a running build — `markInterruptedBuildsFailed` (fix wave 10, item 4)
 * appends its own line directly at boot, and that append has to respect the
 * same cap a streaming build does, or a log already at capacity when the
 * server restarts would grow past it.
 */
export const MAX_BUILD_LOG_BYTES = 512 * 1024

/**
 * Appended to a `"building"` deployment's log when `markInterruptedBuildsFailed`
 * flips it to `"failed"` at boot (see that method's doc comment,
 * `types.ts`). A shared constant, same reason `LOG_TRUNCATION_MARKER` is one:
 * both storage impls must emit exactly the same text for the conformance
 * suite to mean anything.
 */
export const INTERRUPTED_BUILD_LOG_LINE = "\nBuild interrupted by a server restart.\n"

/**
 * Returns the new log value, or `null` when nothing should change.
 *
 * K02: truncation state is derived from `existing.length >= maxBytes` alone
 * — a real, unforgeable measurement — never from `existing.includes(marker)`.
 * The build output streamed into this log is REPO-authored text (S7: it
 * carries the install/build command output verbatim), so a build that
 * simply PRINTS the marker string used to be enough to make this function
 * return `null` forever afterward, from wherever in the log the attacker
 * chose — silencing everything that followed (including, e.g., the actual
 * failure reason) long before the log was anywhere near its real cap. Basing
 * the decision on length instead closes that: the earliest an attacker's own
 * text can ever satisfy the truncation branch is the exact point truncation
 * would have triggered anyway, so forging the marker buys nothing.
 *
 * The `endsWith` check (rather than re-appending the marker on every call
 * once at cap) is what keeps this idempotent — without it, every further
 * append past the cap would tack on another copy of the marker forever,
 * itself an unbounded-growth bug of the same shape this is fixing.
 */
export function appendBounded(existing: string, chunk: string, maxBytes: number): string | null {
  if (existing.length >= maxBytes) {
    return existing.endsWith(LOG_TRUNCATION_MARKER) ? null : existing + LOG_TRUNCATION_MARKER
  }
  const room = maxBytes - existing.length
  if (chunk.length <= room) return existing + chunk
  return existing + chunk.slice(0, room) + LOG_TRUNCATION_MARKER
}
