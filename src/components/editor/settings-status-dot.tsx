import { StatusDot } from "@/components/blocks"
import { cn } from "@/lib/utils"
import type { DesktopUpdateState } from "@/types/desktop-bridge"
import { desktopUpdateBadgeTone } from "./desktop-update-menu"

/**
 * The ONE status dot on a settings button.
 *
 * ## Why one
 *
 * There used to be two, on the same 24px icon, told apart only by corner and
 * hue: a blue update badge at the top-right and an amber "AI features need an
 * API key" marker at the bottom-right. The bottom-right position was not a
 * design choice, it was collision avoidance — the comment it replaced said
 * sharing the corner "hid update-ready and update-error whenever credentials
 * were also missing".
 *
 * That is a workaround for having two dots, and it cost what workarounds cost.
 * Mo, 2026-09-02, reading the amber one in the project view: "there is a dot on
 * the settings icon to show that there is an update. That dot should be on the
 * top right (not bottom right)". It was not an update dot. Two dots on one
 * glyph cannot be told apart by anyone who has not read this file, and the
 * corner was carrying meaning that nothing announced.
 *
 * So there is one dot, in one corner, and the MENU says which state it is.
 * A dot's job is "look here"; it was never going to carry "which of four
 * things".
 *
 * ## Priority
 *
 * An update state outranks a missing credential. That preserves the intent of
 * the arrangement this replaces, which went out of its way to keep update-ready
 * and update-error visible when a key was also missing. A missing key is a
 * standing condition the user has usually already decided about; an update
 * that finished downloading is news.
 *
 * ## Tone is semantic, not decorative
 *
 * Blue for an available or downloading update, green for ready, red for a
 * failure, amber for a missing key. Painting the credential warning the brand
 * teal would make a misconfiguration look like an accent.
 */
export function SettingsStatusDot({
  state,
  credentialMissing,
  credentialTestId,
  className,
}: {
  /** Desktop update state, or undefined outside the desktop app. */
  state?: DesktopUpdateState
  credentialMissing: boolean
  /** Per-surface testid for the credential case, which the suites assert on. */
  credentialTestId: string
  className?: string
}) {
  const update = state ? desktopUpdateBadgeTone(state) : null

  if (update && state) {
    return (
      <StatusDot
        tone={update.tone}
        size="sm"
        pulse={update.pulse}
        className={cn("absolute -top-0.5 -right-0.5", className)}
        data-testid="desktop-update-badge"
        data-phase={state.phase}
      />
    )
  }

  if (credentialMissing) {
    return (
      <StatusDot
        tone="warning"
        size="sm"
        className={cn("absolute -top-0.5 -right-0.5", className)}
        data-testid={credentialTestId}
        aria-label="AI features need an API key"
      />
    )
  }

  return null
}
