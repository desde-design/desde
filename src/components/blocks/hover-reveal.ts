/**
 * The class recipe for a control that appears when its card is hovered.
 *
 * Used by the project cards in BOTH surfaces — the Viewer dashboard and the
 * Editor launcher (Mo, 2026-08-25: "It should work that way for both"). It is
 * a shared constant rather than a copied string precisely because those two
 * cards are supposed to behave identically, and a copied string is how they
 * stop.
 *
 * The parent card must carry `group`.
 *
 * ## Every clause here is load-bearing
 *
 * - `opacity-0` + `group-hover` is the reveal itself. Opacity, never
 *   `hidden`: the control keeps its space, so revealing it cannot reflow the
 *   row underneath the pointer that is reaching for it.
 * - `focus-visible` is the keyboard path. Without it the control is
 *   unreachable by tab in any meaningful sense — focus lands on something
 *   invisible.
 * - `data-[state=open]` is the one that looks like a bug when it is missing.
 *   Radix sets it on an open menu's trigger. A dropdown portals to `body`, so
 *   moving the pointer from the trigger into the menu LEAVES the card:
 *   `group-hover` goes false and the button fades out from under its own open
 *   menu.
 * - `[@media(hover:none)]` is touch. A device with no hover has no way to
 *   reveal this, so it is always shown there. Not a nicety — without it the
 *   control does not exist on a tablet.
 *
 * If a surface wants the control always visible, do not reach for a variant
 * of this: just leave it off.
 */
export const HOVER_REVEAL =
  "opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100"
