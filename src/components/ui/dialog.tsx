"use client"

import * as React from "react"
import { Dialog as DialogPrimitive } from "radix-ui"

import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"
import { TONE_SURFACE } from "@/lib/tone-surface"
import { Button } from "@/components/ui/button"
import { XIcon } from "lucide-react"

function Dialog({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

function DialogTrigger({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 isolate z-50 bg-black/80 duration-100 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
        className
      )}
      {...props}
    />
  )
}

/**
 * Width is a `size` VARIANT, not a className.
 *
 * The base used to hardcode `sm:max-w-sm`, so a call site passing an
 * unprefixed `max-w-2xl` got both classes: tailwind-merge does not treat
 * `max-w-2xl` and `sm:max-w-sm` as conflicting (different variant scopes), and
 * the media query wins at every viewport above 640px. Measured consequence:
 * EVERY dialog in the app rendered at 384px, including several that had been
 * asking for `max-w-2xl` for months. The width prop was dead and nothing said
 * so.
 *
 * A variant makes the choice typed and impossible to silently lose. If you need
 * a width that isn't here, add a variant rather than passing a className.
 */
const dialogContentVariants = cva(
  cn(
    // `grid-cols-[minmax(0,1fr)]`, not a bare `grid`: a grid track is
    // auto-sized to its content by default, so one unbreakable child (a long
    // token name, a selector chain, a file path) widens the track past the
    // dialog's own max-width and everything inside spills out the right edge.
    // `minmax(0,…)` lets the track shrink so children can truncate or wrap.
    "fixed top-1/2 left-1/2 z-50 grid grid-cols-[minmax(0,1fr)] w-full max-w-[calc(100%-2rem)]",
    "-translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl bg-popover p-5",
    "text-sm text-popover-foreground ring-1 ring-foreground/10",
    "duration-100 outline-none",
    "data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95",
    "data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
  ),
  {
    variants: {
      size: {
        /** Confirm / single input. */
        sm: "sm:max-w-sm",
        /** Short form. */
        md: "sm:max-w-md",
        /** Standard form. */
        lg: "sm:max-w-lg",
        /** Decision dialogs with option cards. */
        xl: "sm:max-w-xl",
        /** Content-heavy: save trace, swap catalog, conventions digest. */
        "2xl": "sm:max-w-2xl",
      },
    },
    defaultVariants: { size: "md" },
  },
)

function DialogContent({
  className,
  size,
  children,
  showCloseButton = true,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> &
  VariantProps<typeof dialogContentVariants> & {
    showCloseButton?: boolean
  }) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(dialogContentVariants({ size }), className)}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close data-slot="dialog-close" asChild>
            <Button
              variant="ghost"
              className="absolute top-2 right-2"
              size="icon-sm"
            >
              <XIcon
              />
              <span className="sr-only">Close</span>
            </Button>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  )
}

/**
 * Two spacings, doing different jobs.
 *
 * `gap-2` INSIDE the header: once the description became body copy rather than
 * a caption, 4px read as the title and description being one block. They are
 * two things, so they get 8px.
 *
 * `mb-1` BELOW it: the dialog grid's own `gap-4` spaces every section equally,
 * which made the header just another band in the stack. The header is the
 * question; what follows is how you answer it. Adding 4px on top of the grid
 * gap sets it apart without inventing a second rhythm for the rest of the
 * dialog.
 */
function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-2 mb-1", className)}
      {...props}
    />
  )
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
        className
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close asChild>
          <Button variant="outline">Close</Button>
        </DialogPrimitive.Close>
      )}
    </div>
  )
}

/**
 * `text-lg font-medium`, a step above the body.
 *
 * It used to be `text-base font-normal`, which was the SAME size and weight as the
 * description once that became `tone="lead"` body copy. Two lines at identical
 * type read as one paragraph with a line break in it, so the title stopped
 * announcing itself as the question being asked.
 */
function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("text-lg font-medium", className)}
      {...props}
    />
  )
}

/**
 * One register: body copy, `text-base` at full foreground.
 *
 * This briefly had a `tone` variant with a small gray `muted` default and an
 * opt-in `lead`. That produced exactly the split it was meant to manage: seven
 * dialogs opted in and nine did not, so the same line under the same kind of
 * title rendered two different ways depending on when it was written. A variant
 * whose two values mean "readable" and "less readable" is not a design
 * decision, it is a way to forget one.
 *
 * The description is where a decision dialog explains the choice, so it has to
 * be legible; there is no dialog here whose explanation deserves to be
 * caption-sized. A one-off that genuinely needs smaller text can still pass
 * `className`, the way the smoke-test report does for its compact header.
 */
function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn(
        "text-base text-foreground",
        "*:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground",
        className,
      )}
      {...props}
    />
  )
}

/**
 * The dialog's description, plus any failures under it.
 *
 * These are two different kinds of sentence and they were briefly conflated: an
 * earlier version took one flat list of "points" and bulleted all of them, so
 * the standing description of what the dialog is for became a list item
 * alongside a transient error. A description is not one of the errors.
 *
 * So the description is always a paragraph, and only the issues can become a
 * list. One issue reads as a paragraph too, because a lone bullet is a
 * paragraph wearing a dot; two or more get bulleted, since that is the case
 * where running them together buries the second.
 *
 * ## Issues render as a destructive banner (changed 2026-08-17)
 *
 * They used to be bare red prose under the description, on the reasoning that
 * a tinted box was a second block to read before the first control. Mo
 * reversed that: a failure that comes back after you pressed a button is a
 * different event from a caption, and it has to look like one.
 *
 * The earlier reasoning was not wrong about section count, it was wrong about
 * WHICH cases it applied to. A permanent explanatory Callout that is on screen
 * before the user does anything is still worth merging away, and § "2 good, 3
 * max" still says so. A post-submit failure is transient, arrives after an
 * action, and is the reason the dialog is still open. Two red sentences in a
 * paragraph do not read as "that did not work"; a red box does.
 *
 * ## …unless the modal IS the error (`titleCarriesError`)
 *
 * The discriminator is **whether the dialog's TITLE states the error**.
 *
 * A dialog that opened in order to explain a failure is already the container
 * for it: the title says "Save failed", the whole surface is about that, and a
 * red box inside a red-titled modal is a banner in a banner. Those pass
 * `titleCarriesError` and the issues render as plain destructive prose.
 *
 * A dialog whose title is about something else ("Connect to a viewer", "New
 * project", "Swap Button") and which then had an action fail inside it is the
 * banner case: the surface is not about the failure, so the failure needs its
 * own container to be found at all.
 *
 * The exception, which belongs to `Field` and not here: an error UNDER AN
 * INPUT stays plain small text. It is scoped to the control above it, the
 * proximity is what tells you which field is wrong, and boxing it would put a
 * banner inside a form row. **That case is not exclusive with the banner** — a
 * submit can legitimately raise a form-level banner AND mark two fields.
 *
 * `role` comes from the caller's node, not from the Callout: `Callout` defaults
 * to the polite `role="status"`, and a wrapper that hard-coded `alert` would
 * make every dialog's validation message interrupt a screen reader mid-
 * sentence. The nodes already carry their own `role`, so the banner is marked
 * `role="presentation"` to keep it from announcing a second time.
 *
 * Which element carries `aria-describedby` depends on what exists. With a
 * description it is the description; with only issues the issues become it,
 * via `asChild` because `DialogDescription` renders a `<p>` and a `<ul>` cannot
 * live inside one.
 *
 * Give each issue `role="status"` (or `alert` when it blocks): the description
 * is announced when the dialog opens, not when its text changes. Callers no
 * longer need `text-destructive` on the node, the banner carries the tone, but
 * passing it is harmless.
 */
function DialogCopy({
  description,
  issues = [],
  titleCarriesError = false,
  ...props
}: {
  description?: React.ReactNode
  issues?: ReadonlyArray<{ key: string; node: React.ReactNode }>
  /**
   * True when this dialog's TITLE already states the failure, i.e. the modal
   * exists to explain it. Renders the issues as plain destructive prose rather
   * than a banner, because the modal is already the container. See the
   * `titleCarriesError` section above for the discriminator.
   */
  titleCarriesError?: boolean
} & React.ComponentProps<typeof DialogPrimitive.Description>) {
  // `size="lg"` is `text-base`, matching `DialogDescription`. These nodes are
  // siblings of the description, never children (a <ul> inside its <p> would
  // be invalid), so they inherit nothing from it and the size has to be said.
  const issueBody =
    issues.length === 0 ? null : issues.length === 1 ? (
      <p>{issues[0].node}</p>
    ) : (
      <ul className="list-disc space-y-1 pl-4">
        {issues.map((issue) => (
          <li key={issue.key}>{issue.node}</li>
        ))}
      </ul>
    )

  // The tone recipe comes from `TONE_SURFACE` rather than from `Callout`.
  // `Callout` is a block, blocks compose primitives, and a primitive reaching
  // back up for a block inverts that. `TONE_SURFACE` lives in `lib/`, which
  // both layers may use, and is the single definition either way, so this box
  // and every `Callout` move together. Geometry matches `Callout size="lg"`.
  const issueNode = !issueBody ? null : titleCarriesError ? (
    // No box. The red title above is the container, and nesting one tinted
    // block inside a surface that is already entirely about this failure is a
    // banner in a banner. Still `text-destructive`, so the colour carries.
    <div data-slot="dialog-issues" className="text-base text-destructive">
      {issueBody}
    </div>
  ) : (
    <div
      data-slot="dialog-issues"
      // `presentation`, not `alert`: the caller's nodes already carry their own
      // `role="status"` / `role="alert"`, and announcing the wrapper too would
      // read the failure twice.
      role="presentation"
      className={cn("rounded-md border p-3 text-base", TONE_SURFACE.destructive)}
    >
      {issueBody}
    </div>
  )

  if (description) {
    return (
      <>
        <DialogDescription {...props}>{description}</DialogDescription>
        {issueNode}
      </>
    )
  }
  if (!issueNode) return null
  // `asChild` onto the Callout: with no description this IS the described
  // content, and the Callout is a <div>, so it can hold a <ul> that a
  // `DialogDescription`'s own <p> could not.
  return (
    <DialogDescription asChild {...props}>
      {issueNode}
    </DialogDescription>
  )
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogCopy,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}
