import type { ReactNode } from "react"

/**
 * Container for `kind: "inline"` fixtures.
 *
 * A modal portals itself to the top of the viewport and brings its own scrim,
 * so it is visible wherever it is rendered. An inline surface — a chat banner,
 * an inspector row — has none of that: rendered bare from the gallery overlay
 * it becomes another block in normal document flow and lands wherever the
 * picker portal happens to push it. `activity-panel`'s fixture hit exactly
 * this and was measured rendering at y=720 in a 720px viewport: correct
 * content, invisible without scrolling, and blank in every screenshot.
 *
 * So inline fixtures get a fixed, visible panel to sit in. The width is the
 * point rather than incidental — these surfaces live in a ~320px right rail,
 * and judging their line-wrapping at full viewport width would flatter copy
 * that actually wraps badly in situ.
 */
export function InlineFrame({
  children,
  width = "narrow",
}: {
  children: ReactNode
  /** `narrow` matches the right rail; `wide` suits a full-width panel row. */
  width?: "narrow" | "wide"
}) {
  return (
    <div
      className={
        width === "narrow"
          ? "fixed left-4 top-4 z-40 w-80 rounded-lg border border-border bg-background p-3 shadow-lg"
          : "fixed left-4 top-4 z-40 w-[36rem] rounded-lg border border-border bg-background p-3 shadow-lg"
      }
    >
      {children}
    </div>
  )
}
