/**
 * Relative "how long ago" formatting, shared by the Editor launcher and the
 * Viewer dashboard.
 *
 * It lives here rather than beside either caller because the two surfaces are
 * deliberately built to look the same, and a timestamp that reads "3 days
 * ago" on one and "2026-08-16" on the other is exactly the kind of drift that
 * makes two surfaces stop feeling like one product. Moved out of
 * `src/components/editor/launcher/use-launcher-api.ts` (where it was
 * `formatLastOpened`) on 2026-08-19; the behaviour is unchanged.
 *
 * Not `Intl.RelativeTimeFormat`: that renders "3 days ago" too, but it needs
 * the caller to pick the unit, which is the entire decision this function
 * makes. Rounding, not flooring, at every step — 59 minutes should read as an
 * hour rather than as 59 minutes, which is what a reader means by it.
 *
 * Past ~30 days it stops being relative and gives the date, because "47 days
 * ago" is a number nobody converts. An unparseable input returns "" so a
 * caller can render nothing rather than "NaN days ago".
 */
export function formatRelativeTime(iso: string): string {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return ""
  const seconds = Math.round((Date.now() - then) / 1000)
  if (seconds < 60) return "just now"
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`
  return new Date(then).toLocaleDateString()
}

/**
 * The compact form — `3h ago`, `2d ago`, `40m ago` — for dense meta strips
 * where the long form does not fit.
 *
 * This exists because it was MEASURED, not because compact looked tidier. The
 * Viewer's project card carries a one-line uppercase strip 215px wide at 4
 * columns; `Members · Build failed 40 minutes ago` renders 237px there and
 * truncates. Every realistic combination fits in the compact form.
 *
 * Deliberately a SECOND function rather than an option on the first. The
 * Editor launcher's card has a whole line to itself and reads better long
 * ("Opened 3 minutes ago"), so the two callers genuinely want different
 * strings — and a boolean parameter would invite the wrong one to be passed
 * by a caller that never measured its own width.
 *
 * It ABSORBED `src/utils/format-relative-time.ts` (deleted 2026-08-19), which
 * had been doing almost this since long before and which this function was
 * written next to without noticing. The two differed in three ways, and this
 * one is right on all three: it ROUNDS rather than floors (90 minutes is
 * nearer 2h than 1h), it falls back to a date past ~30 days rather than
 * emitting "412d ago", and it survives an unparseable input instead of
 * rendering "NaNd ago". Its Editor callers moved here — three at the time,
 * and a fourth (`activity-detail-dialog.tsx`) that arrived on main from
 * another branch while this change was in flight and had to be rewired on
 * the rebase. Only the typecheck caught that one; a deleted module and a new
 * caller for it can land on two branches without either noticing.
 *
 * Same thresholds and the same past-30-days date fallback as
 * `formatRelativeTime`, so the two never disagree about WHICH unit an age
 * falls into — only about how many letters it spells.
 */
export function formatRelativeTimeShort(iso: string): string {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return ""
  const seconds = Math.round((Date.now() - then) / 1000)
  if (seconds < 60) return "just now"
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(then).toLocaleDateString()
}

/**
 * A span in either direction, in words: `11 days ago`, `in 1 year`.
 *
 * The third of these, and the reason it is a third rather than an option on
 * the first two is the **date fallback**. `formatRelativeTime` deliberately
 * stops being relative past ~30 days and prints a date, because "47 days ago"
 * is a number nobody converts. That is right for a project card, where the
 * question is "was I in here recently?" and an exact date answers it.
 *
 * It is wrong for a credential. Asked for by Mo, 2026-08-21, on the token
 * list: an expiry wants "in 1 year", not "2027-08-21", because the decision
 * it feeds is "is this about to stop working?" and a date makes the reader do
 * the arithmetic. So this one keeps going: months, then years, both ways.
 *
 * Rounding, not flooring, at every step, matching its two siblings, so the
 * three never disagree about which unit an age falls into.
 *
 * Months are 30 days and years are 12 of those. That is approximate and it is
 * meant to be: at the point a string reads "in 4 months" nobody is counting,
 * and a calendar-exact version would still round to the same words.
 *
 * An unparseable input returns "" so a caller can render nothing rather than
 * "NaN days ago".
 */
export function formatRelativeSpan(iso: string): string {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return ""

  const deltaMs = then - Date.now()
  const future = deltaMs > 0
  const say = (count: number, unit: string): string => {
    const measure = `${count} ${unit}${count === 1 ? "" : "s"}`
    return future ? `in ${measure}` : `${measure} ago`
  }

  const seconds = Math.round(Math.abs(deltaMs) / 1000)
  if (seconds < 60) return future ? "in a moment" : "just now"
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return say(minutes, "minute")
  const hours = Math.round(minutes / 60)
  if (hours < 24) return say(hours, "hour")
  const days = Math.round(hours / 24)
  if (days < 30) return say(days, "day")
  const months = Math.round(days / 30)
  if (months < 12) return say(months, "month")
  return say(Math.round(months / 12), "year")
}
