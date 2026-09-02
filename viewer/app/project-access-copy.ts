/**
 * ONE source for what each project-access value MEANS, in words.
 *
 * Created by the Fix wave M2 review, because the same three ideas were written
 * out five times across three files — the access dialog's read-only sentence,
 * its three `OptionCard` hints, the dashboard card's badge tooltips, and the
 * review rail's badge tooltip — and they had already drifted. "Invited only"
 * was "Only people you add below. Admins can always open it." in the picker,
 * "Only invited people can open this project." on the dashboard badge, and
 * "Only people who were added can open this project." in the summary sentence.
 * Three sentences for one rule, differing in what they promise.
 *
 * Resolved to the third: **"Only people who were added can open this
 * project."** It is the one that is true wherever it appears. "add below"
 * assumes the picker is on screen, which the badge tooltip is not; "Admins can
 * always open it" is true but is a fact about ADMINS, not about this access
 * value, and it belongs in the admin-facing docs rather than in the sentence a
 * reviewer reads to find out whether their colleague can see the link.
 *
 * Plain `.ts`, no React: a badge, a dialog and a sentence all need these
 * strings, and none of them should have to import a component to get them.
 */

/** The three access states — matches the server's stored `ProjectAccess`. */
export type ProjectAccessValue = "all-members" | "invited" | "public-link"

/** The short name of each state — `OptionCard` titles, and anywhere the value is named rather than explained. */
export const ACCESS_LABELS: Record<ProjectAccessValue, string> = {
  "all-members": "All members",
  invited: "Invited only",
  "public-link": "Public link",
}

/**
 * One plain sentence per state — `OptionCard` hints, badge tooltips, and the
 * read-only summary a `viewer` sees instead of the picker. Written to stand
 * alone: each one is true with no other UI visible beside it.
 */
export const ACCESS_DESCRIPTIONS: Record<ProjectAccessValue, string> = {
  "all-members": "Everyone in this viewer can open and comment.",
  invited: "Only people who were added can open this project.",
  "public-link": "Anyone with the link can view. No sign-in needed.",
}

/**
 * Why "Public link" cannot be chosen, when the instance-wide kill switch is
 * off.
 *
 * It replaces that option's hint rather than appearing as an error after Save
 * (Mo, 2026-08-29). See docs/design.md, "Disable what cannot be done, and say
 * why" — the reason belongs on the option the reader is looking at, before
 * they spend a click on it.
 */
export const PUBLIC_LINKS_DISABLED_REASON =
  "Public links are turned off for this viewer. An Admin can turn them on in Settings."

/**
 * What a given access value means RIGHT NOW, taking the instance-wide
 * public-link kill switch into account.
 *
 * The one case the static table cannot express: a project stored as
 * `"public-link"` while the switch is off is treated by `canReadProject`
 * (`server/auth/authorize.ts`) exactly like `"all-members"`. Saying "anyone
 * with the link can view" there would be a disclosure claim that is simply
 * false, so this says what is actually true instead.
 */
export function accessSummary(access: ProjectAccessValue, publicLinksEnabled: boolean): string {
  if (access === "public-link" && !publicLinksEnabled) {
    return "Public links are turned off for this viewer, so only signed-in members can open this project."
  }
  return ACCESS_DESCRIPTIONS[access]
}
