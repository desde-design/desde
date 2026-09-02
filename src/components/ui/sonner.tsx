"use client"

import { useTheme } from "next-themes"
import { Toaster as Sonner, type ToasterProps } from "sonner"
import { CircleCheckIcon, InfoIcon, TriangleAlertIcon, OctagonXIcon, Loader2Icon } from "lucide-react"

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme()

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      icons={{
        success: (
          <CircleCheckIcon className="size-4" />
        ),
        info: (
          <InfoIcon className="size-4" />
        ),
        warning: (
          <TriangleAlertIcon className="size-4" />
        ),
        error: (
          <OctagonXIcon className="size-4" />
        ),
        loading: (
          <Loader2Icon className="size-4 animate-spin" />
        ),
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      // `closeButton` on every toast, matching the banners — a toast that
      // reports a failure must be dismissable rather than only waitable-out.
      closeButton
      toastOptions={{
        /*
         * Explicit, so it is a decision rather than whatever Sonner defaults
         * to (Mo, 2026-08-18: "I would like them to auto disappear after a
         * short period"). 5s is long enough to read two lines and short
         * enough that a burst does not stack up.
         *
         * Two toasts deliberately override this with `duration: Infinity`,
         * and both are STATES rather than events: the component-edit-mode
         * indicator (dismissing it would hide the only sign you are in that
         * mode) and the prototype-disconnected error (still true until it
         * reconnects). Everything else times out.
         */
        duration: 5000,
        classNames: {
          toast: "cn-toast",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
