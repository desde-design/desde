/**
 * Finding a slug that is actually free.
 *
 * A project's slug is its URL, so it has to be unique. Until 2026-08-29 a
 * collision was the caller's problem: `POST /projects` answered 409 and the
 * dialog showed "A prototype with that slug already exists", leaving someone
 * who typed a perfectly ordinary name to invent a variation. Mo: "can we not
 * be smart and append some digits to make the slug unique. We also don't have
 * to show that to the user. Just happens transparently in the background."
 *
 * So the server suffixes instead: `checkout-redesign`, then
 * `checkout-redesign-2`, `-3`, and so on.
 *
 * ## The length rule is why this is not a one-liner
 *
 * Slugs are capped at 63 characters (`SLUG_PATTERN`). Appending to a slug
 * already at the cap produces one the route's own validator would reject, so
 * the BASE is trimmed to make room for the suffix rather than the suffix
 * being appended blindly. Trimming can also strip back to a trailing hyphen
 * ("my-long-name-" + "-2"), which is legal for the pattern but reads as a
 * typo, so the trailing hyphens come off.
 *
 * ## Why the caller must still handle a conflict
 *
 * The route ASKS whether each candidate is taken, which is a read followed by
 * a write with a gap in between. Two creates racing on the same name can both
 * be told `-2` is free. So the route retries the create on `ConflictError`,
 * advancing the suffix each time: the check makes collisions rare, the retry
 * makes them correct.
 *
 * Only the pure suffixing lives here, which is what makes the length and
 * hyphen rules testable without a database.
 */

/** Matches the route's own validator. Kept in step with it deliberately. */
const MAX_SLUG_LENGTH = 63

/**
 * `base` with `-n` on the end, trimmed to fit the length cap.
 *
 * `n` of 1 returns the base unchanged — the first candidate is always the
 * slug the caller asked for.
 */
export function nextSlugCandidate(base: string, n: number): string {
  if (n <= 1) return base
  const suffix = `-${n}`
  const room = MAX_SLUG_LENGTH - suffix.length
  // `replace` rather than a while loop: trimming can expose several hyphens
  // ("a-b---" sliced mid-run), and a slug ending in one reads as a typo even
  // though the pattern allows it.
  const trimmed = base.slice(0, room).replace(/-+$/, "")
  // A base that was ALL hyphens after the first character would trim to
  // nothing; fall back to the untrimmed head so the result still starts with
  // an alphanumeric, which the pattern requires.
  return `${trimmed || base.slice(0, 1)}${suffix}`
}
