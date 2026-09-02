import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

/**
 * One settings section, in its own container: a title, a line saying what the
 * section is for, and its controls.
 *
 * The container is what lets a settings page read as a document rather than as
 * one long undifferentiated form. Without it every control sits directly on the
 * page background and the reader has to infer the grouping from spacing alone.
 *
 * Extracted from the Editor's project settings page (2026-08-21), when Mo asked
 * for the Viewer's settings to match it. Sharing the component is the point:
 * "match the Editor" implemented by copying its class strings is two designs
 * that agree today, and the second one is the one nobody remembers to update.
 */
export interface SettingsSectionProps {
  /**
   * Optional, because a section shown one-at-a-time under a TAB is already
   * named by the tab (Mo, 2026-08-28). Repeating it puts "Members" directly
   * under a selected tab reading "Members", which is a heading that tells the
   * reader something they just clicked.
   *
   * Omit it there. Keep it wherever several sections stack in one column and
   * the reader has to tell them apart — which is the same condition `frame`
   * already draws its border for.
   */
  title?: string
  /** One line on what this section is for. Shown under the title. */
  description?: ReactNode
  /**
   * A section-scoped action, rendered to the RIGHT of the title.
   *
   * The title row is where it belongs: the button acts on the collection the
   * title names, so putting it under the collection makes the reader scroll
   * past a list to find out they can add to it.
   */
  action?: ReactNode
  /**
   * `card` (default) draws a border around the section. Use it when several
   * sections stack in one column and have to be told apart.
   *
   * `bare` draws nothing. Use it when something else already delimits the
   * section — a tab that shows one section at a time, most obviously. A card
   * around the only thing on screen is a box drawn for no one.
   */
  frame?: "card" | "bare"
  /**
   * Appends "Changes here save as you make them." to the description.
   *
   * Said on the section that behaves this way, never once in a page footnote.
   * A settings page that stages some changes behind a Save and writes others
   * immediately has to say which is which AT the control, because a reader who
   * just removed something needs to know it is already gone before they go
   * looking for a Cancel.
   */
  savesImmediately?: boolean
  className?: string
  children: ReactNode
}

export function SettingsSection({
  title,
  description,
  action,
  frame = "card",
  savesImmediately = false,
  className,
  children,
  ...props
}: SettingsSectionProps & { "data-testid"?: string }) {
  return (
    <section
      data-frame={frame}
      className={cn("flex flex-col gap-3", frame === "card" && "rounded-lg border p-4", className)}
      {...props}
    >
      {/* The row is skipped entirely when there is nothing to put in it, so a
          title-less section with no description and no action does not open
          with an empty flex row holding a `gap-3`. */}
      {title || description || savesImmediately || action ? (
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            {/*
              A step larger when bare. Inside a card the border marks where the
              section starts, so the heading only has to name it; with no card
              the heading is doing both jobs, and at `text-base` it sat two full
              steps under the page title with nothing in between.
            */}
            {title ? (
              <h2 className={cn("font-medium", frame === "bare" ? "text-lg" : "text-base")}>
                {title}
              </h2>
            ) : null}
            {description || savesImmediately ? (
              <p className="text-sm text-muted-foreground">
                {description}
                {savesImmediately ? " Changes here save as you make them." : null}
              </p>
            ) : null}
          </div>
          {action ? <div className="flex-none">{action}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  )
}
