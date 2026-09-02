/**
 * The single letter shown in an avatar when there is no photo — or when the
 * photo fails to load.
 *
 * **One letter, not two** (Mo, 2026-08-19). "Dana Okafor" is `D`, not `DO`.
 * Two letters read as an acronym or a monogram, which is a different kind of
 * thing from "this is a person we could not show you a picture of"; and in a
 * 16px circle in a dense list, two glyphs are a smudge where one is legible.
 *
 * The rule is deliberately the simplest one that is always true: **the first
 * letter or digit in the name.** Everything before it is skipped, so leading
 * punctuation and decoration cannot become the initial — `"-mo-"` is `M`, and
 * `"(guest)"` is `G` rather than a bracket or a `?`.
 *
 * That replaced a first-and-last-word rule which had three implementations
 * that disagreed with each other (the Editor's comment list took two letters
 * from a one-word name where the Viewer's took one), and which produced `D(`
 * for `"Dana (reviewer)"` — the last "word" being `(reviewer)`. Taking only
 * the first letter makes that entire class of bug unreachable rather than
 * handled.
 *
 * A name with no letter or digit in it at all gives `?`, so the fallback
 * always renders something.
 */
export function avatarInitial(displayName: string): string {
  const match = displayName.match(/[\p{L}\p{N}]/u)
  return match ? match[0].toUpperCase() : "?"
}
