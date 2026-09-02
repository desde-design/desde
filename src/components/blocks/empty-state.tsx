import type { ComponentProps, ReactNode } from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { CatAsleep } from "./cat-asleep"
import { CatAtPortal } from "./cat-at-portal"
import { CatVacuumFailure } from "./cat-vacuum-failure"
import { CatEmptyBowl } from "./cat-empty-bowl"
import { cn } from "@/lib/utils"

/**
 * EmptyState — the "nothing here" block. Illustration + title + description +
 * optional actions (children), centred.
 *
 * `size="sm"` is the compact form for tight panel sections; the default owns
 * a panel or a page.
 *
 * ## No border, no card (Mo, 2026-08-25)
 *
 * It carried a dashed box with a muted ground from 2026-08-17 to 2026-08-25,
 * on the argument that a border "draws where the list WOULD be" and stops
 * centred text reading as a paragraph that lost its section. That is gone:
 * the block sits directly on the surface.
 *
 * The border was also the thing that made empty and failed states look
 * different from each other for no reason a reader could act on, since a
 * failure had already opted out of it (`frame="bare"`). One look now, and the
 * only thing that varies is the picture.
 *
 * ## `tone` picks the picture, `frame` picks the layout
 *
 * These used to be one prop, `frame`, with values `box` / `bare` / `panel` —
 * so a caller choosing how much chrome it wanted was also, silently, choosing
 * which cat it got. Once the chrome went away that conflation had nothing
 * left to stand on.
 *
 * | `tone` | Picture | Use when |
 * | --- | --- | --- |
 * | `empty` (default) | cat at an empty bowl | nothing is here |
 * | `failure` | sleeping cat | this went wrong |
 * | `denied` | cat at an open portal | the way in is not open to them |
 * | `error` | cat and a broken vacuum | something actually broke |
 *
 * Four pictures rather than two, on the same reasoning that split `empty`
 * from `failure` in the first place: these are different facts and one image
 * for all of them flattens them into "no content" (Mo, 2026-08-29).
 *
 * The two additions are easy to confuse with `failure`, so the line between
 * them is worth stating:
 *
 * - `failure` is the SLEEPING cat, and it means "this did not load" — a fetch
 *   that came back empty-handed and can usually be retried.
 * - `error` is the broken vacuum, and it means "this broke" — a 500, an
 *   unhandled crash, a fault rather than a failure to arrive.
 * - `denied` is the portal, and it means "the way in is not open" — signed
 *   out, not permitted, not found. Nothing is wrong; the reader simply is not
 *   through the door.
 *
 * | `frame` | Layout | Use when |
 * | --- | --- | --- |
 * | `default` | in the flow, its own padding | a page or a panel section |
 * | `panel` | centred in the full height | a rail is waiting for a selection |
 *
 * **`panel` is the rule for anything inside a rail**, not just for "nothing
 * is selected yet". Pinning a message to the top of a tall panel leaves it
 * stranded, and a rail that centres one message and top-aligns the next reads
 * as two different surfaces. Empty, failure and loading all take it.
 *
 * It is layout ONLY. A caller that supplies a large teal glyph gets that
 * instead of a cat, because two pictures carry one message — but that is the
 * `icon` prop doing it, not the frame. A panel message with no icon keeps its
 * cat.
 *
 * ## One vertical rhythm, and why it is not a single `gap`
 *
 * MEASURED 2026-08-25, before: the empty state and the failure state on the
 * same dashboard disagreed about nearly everything — 48px of vertical padding
 * against 32px, and 24px between description and action against 12px. Two
 * callers had reached past the block with `px-6 py-12` and `mt-4` to get
 * there, so the block's own defaults were not what anyone saw.
 *
 * The rhythm is deliberate rather than uniform, because these are not four
 * peers: the title and description are ONE unit, and the picture and the
 * action are separate things either side of it.
 *
 *   picture  --12px-->  title  --4px-->  description  --16px-->  action
 *
 * That is a `gap-1` container with `mb-2` on the picture and `mt-3` on the
 * action row. A single gap makes the title/description pair look as loosely
 * related as the picture and the button, which is what "the spacing between
 * the items is too large" was describing.
 */
const emptyStateVariants = cva(
  "flex flex-col items-center justify-center px-4 text-center",
  {
    variants: {
      size: {
        default: "gap-1 py-6",
        sm: "gap-1 py-4",
      },
      frame: {
        default: "",
        // `h-full` needs a parent with a height to centre inside; every
        // `TabsContent` in the review rail is `flex-1`, which supplies one.
        //
        // `px-6` overrides the base `px-4`: a panel empty state is a centred
        // sentence with nothing else on the line, and in a 320px rail 16px of
        // margin leaves it almost touching both edges.
        //
        // `pb-24` is an OPTICAL centring correction, not spacing (Mo,
        // 2026-08-28: "the cat and message are a little low"). MEASURED
        // before it: the content sat at the exact geometric centre of a 735px
        // panel, 294px of air above and 294px below. That is the thing that
        // reads as low — the eye takes the midpoint of a tall column to be a
        // little above the true one.
        //
        // It works because `justify-center` centres within the CONTENT box,
        // so a taller bottom pad shrinks that box from below and moves the
        // centre up by half the difference: (96 - 16) / 2 = 40px against the
        // `size="sm"` `py-4`. A transform would move the block off its own
        // layout position instead, which stops being a lift the moment the
        // panel is short enough for the content to reach the edges.
        //
        // Applied on the frame rather than at call sites so every panel
        // message moves together — empty, failure and no-matches replace each
        // other in the same space, and one of them sitting 40px off would be
        // the two-surfaces problem this frame exists to prevent.
        panel: "h-full justify-center px-6 pb-24",
        // A whole page's worth of empty: the signed-out settings screen, the
        // denied page, a load failure, a review route with no such project.
        //
        // Same optical correction as `panel`, plus a second term `panel`
        // never needed. These states live in a `<main className="flex-1">`
        // under a 48px `AppHeader` (`h-12`), so the box they centre in starts
        // 48px down and its centre lands at `vh/2 + 24`. Centring in it is
        // therefore 24px below the centre of the window the reader is
        // looking at, before the eye's own preference is counted at all.
        // Mo, 2026-09-01: "the empty state is vertically centered in the
        // content area but that does not take into account the header so it
        // is actually a little low."
        //
        // Target lift is 24 (the header) + 40 (the optical constant `panel`
        // established) = 64px, and the mechanism is the same: `justify-center`
        // centres within the CONTENT box, so a heavier bottom pad shrinks it
        // from below and lifts the centre by half the difference.
        // `(144 - 16) / 2 = 64` against the `size="sm"` `py-4` these pages use.
        //
        // On the frame for the reason `panel` gives: these messages replace
        // each other in the same space, so one of them sitting 64px off is
        // exactly the mismatch a shared frame exists to prevent.
        page: "flex-1 justify-center px-6 pb-36",
      },
    },
    defaultVariants: { size: "default", frame: "default" },
  },
)

export interface EmptyStateProps
  extends Omit<ComponentProps<"div">, "title">,
    VariantProps<typeof emptyStateVariants> {
  /** Pass the element (e.g. `<FolderOpen />`); the block sizes and mutes it. */
  icon?: ReactNode
  title?: ReactNode
  description?: ReactNode
  /**
   * Which picture, and nothing else. `failure` for "this went wrong",
   * `empty` (the default) for "nothing is here".
   */
  tone?: "empty" | "failure" | "denied" | "error"
  /**
   * Draw the illustration above the title. Default on.
   *
   * Set it `false` for a state that has to stay short — a `size="sm"` block
   * inside a panel only a few rows tall, or one sitting beside other content
   * rather than owning the surface.
   */
  illustration?: boolean
}

export function EmptyState({
  icon,
  title,
  description,
  size,
  frame,
  tone = "empty",
  illustration = true,
  className,
  children,
  ...props
}: EmptyStateProps) {
  const resolvedFrame = frame ?? "default"
  // An explicit `icon` wins: a caller that named a glyph meant that glyph.
  //
  // `frame` no longer takes part in this (Mo, 2026-08-28). It used to also
  // suppress the cat, which made a LAYOUT prop silently choose the picture —
  // the exact conflation the header says these two props exist to keep apart.
  // It was invisible because the sole `panel` caller passes an `icon`, so the
  // clause above already covered it and removing it changes nothing there.
  // What it unblocks is a centred message that KEEPS its cat, which is what
  // the rail's own empty and failure states need.
  const art =
    !illustration || icon ? null : tone === "failure" ? (
      <CatAsleep size={size === "sm" ? 96 : 128} className="mb-2" />
    ) : tone === "denied" ? (
      <CatAtPortal className={cn("mb-2 shrink-0", size === "sm" ? "size-24" : "size-32")} />
    ) : tone === "error" ? (
      // Width, not `size-*`: this drawing's viewBox is 3:2, so a square class
      // would squash it. The widths are chosen to land at the same visual
      // weight as the square cats beside it.
      <CatVacuumFailure className={cn("mb-2 h-auto shrink-0", size === "sm" ? "w-32" : "w-44")} />
    ) : (
      <CatEmptyBowl className={cn("mb-2 shrink-0", size === "sm" ? "size-24" : "size-32")} />
    )
  return (
    <div
      data-slot="empty-state"
      // `data-frame` + a group name so the icon below can style itself off
      // the frame. The alternative is a second prop for icon size and colour,
      // which pushes a decision the frame already implies onto every caller.
      data-frame={resolvedFrame}
      data-tone={tone}
      className={cn("group/empty", emptyStateVariants({ size, frame }), className)}
      {...props}
    >
      {art}
      {icon ? (
        // Bigger and in brand teal on a `panel` frame. A panel empty state is
        // the only thing on screen while it shows, so its icon is carrying the
        // whole surface rather than decorating a row — at `size-8` in muted
        // grey it read as a disabled control. Everywhere else the icon stays a
        // quiet 32px glyph beside content that is about to arrive.
        <span
          aria-hidden
          className={cn(
            "mb-2 size-8 text-muted-foreground/50 [&_svg]:size-full",
            // `stroke-[1.5]` because lucide draws at 2, which is tuned for
            // ~16px. Scaled to 40px that weight comes with it and the glyph
            // reads as a heavy sign rather than a light illustration. Stroke
            // is not proportional to size, so both directions need saying.
            "group-data-[frame=panel]/empty:size-10 group-data-[frame=panel]/empty:text-primary group-data-[frame=panel]/empty:[&_svg]:stroke-[1.5]",
          )}
        >
          {icon}
        </span>
      ) : null}
      {/* `font-medium` because this is a heading and `body` sets
          `font-weight: 300` app-wide — without it every empty state's title
          rendered lighter than ordinary text, which is the opposite of what a
          title is for. */}
      {title ? <p className="text-base font-medium">{title}</p> : null}
      {description ? (
        <p className="text-sm text-muted-foreground">{description}</p>
      ) : null}
      {/* The action row is the block's, not the caller's. Four callers used to
          add their own `mt-4` and the rest added nothing, which is how two
          states on one screen ended up 12px apart on one and 24px on the
          other. */}
      {children ? (
        <div className={cn("flex items-center gap-2", size === "sm" ? "mt-2" : "mt-3")}>
          {children}
        </div>
      ) : null}
    </div>
  )
}
