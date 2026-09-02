import type { ReactNode } from "react"
import { cn } from "@/lib/utils"
import { Wordmark } from "./wordmark"

/**
 * The full-bleed top bar: wordmark on the left, an underline along the bottom,
 * and whatever chrome the surface owns on the right.
 *
 * Three surfaces render this — the Editor launcher, the Viewer dashboard, and
 * the Viewer's settings page. Before it existed, two of them carried the same
 * recipe with a comment on each saying the classes were "duplicated on purpose
 * and coupled", and the third had an eyebrow instead and did not look like
 * either. Mo, 2026-08-21: "The top nav has the wordmark and an underline."
 *
 * ## The bar is full-bleed, its CONTENTS are not
 *
 * The border and the sticky ground have to reach both window edges, so the
 * `<header>` spans the window. What is inside rides the same centred column as
 * the `<main>` below it, so the wordmark's left edge lines up with the content
 * rather than sitting 24px off the window.
 *
 * ## `width` is not decoration, and it is the whole reason this took a prop
 *
 * The column here MUST match the one on `<main>`. The Editor launcher switches
 * its own between `max-w-5xl` (the project list) and `max-w-2xl` (the create
 * flow) precisely because a header pinned to the wider one left the wordmark a
 * long way left of the form it was heading. Passing the width makes that
 * coupling something a reader can see, instead of two class strings in two
 * files that have to be changed together.
 */
export interface AppHeaderProps {
  /** Must match the `max-w-*` on the `<main>` below. */
  width?: "2xl" | "4xl" | "5xl"
  /** Where the wordmark links, when this is not already the home page. */
  href?: string
  /** Chrome pinned to the right: an account menu, a settings menu. */
  children?: ReactNode
  className?: string
}

export function AppHeader({ width = "5xl", href, children, className }: AppHeaderProps) {
  return (
    <header
      className={cn(
        "sticky top-0 z-40 flex h-12 shrink-0 items-center border-b bg-background",
        className,
      )}
    >
      <div
        className={cn(
          "mx-auto flex w-full items-center px-6",
          width === "2xl" ? "max-w-2xl" : width === "4xl" ? "max-w-4xl" : "max-w-5xl",
        )}
      >
        {href ? (
          <a href={href} className="rounded-sm focus-visible:outline-2 focus-visible:outline-ring">
            <Wordmark />
          </a>
        ) : (
          <Wordmark />
        )}
        {children ? <div className="ml-auto flex items-center">{children}</div> : null}
      </div>
    </header>
  )
}
