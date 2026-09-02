"use client"

import { useEffect } from "react"
import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/blocks"

/**
 * The viewer's error boundary — Next renders this when a route below it
 * throws during render.
 *
 * It did not exist until 2026-08-29, so an unhandled exception fell through to
 * Next's own default page: an unstyled stack trace in development and a bare
 * "Application error" in production, on a product that otherwise has a voice.
 * Mo asked for the broken-vacuum drawing to have a home ("this could be used
 * for 500's etc.") and this is the surface that was missing under it.
 *
 * `tone="error"`, not `failure`. The sleeping cat means "this did not load" —
 * a fetch that came back empty-handed. Reaching here means something actually
 * broke, which is a different fact and now has its own picture.
 *
 * ## What it does NOT say
 *
 * Not the error message. `error.message` on a server-rendered throw is
 * whatever the exception carried — a file path, a query fragment, an internal
 * identifier — and none of it is something the reader typed or can change
 * (docs/design.md, "never print an identifier the reader did not type"). The
 * `digest` is the one exception worth showing, because it is the only handle
 * that ties this screen to a server log, and it is generated FOR that purpose.
 * It only exists on production server errors, so it renders when present and
 * is silent otherwise.
 *
 * ## Why the log call is here rather than in the boundary's parent
 *
 * A client boundary is the last place the exception is still an object rather
 * than a rendered page. Next has already reported it server-side; this is what
 * puts it in the BROWSER console for anyone reading the screen, which is where
 * someone debugging a review link will look first.
 */
export default function ViewerError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error("[viewer] unhandled error:", error)
  }, [error])

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center px-8 pt-8 pb-24 text-center">
      <EmptyState
        tone="error"
        title="Something went wrong"
        description="This page hit an error it couldn't recover from. Trying again often works."
      >
        {/*
          `reset` re-renders the boundary's subtree, which is the cheap retry:
          a transient fault clears without losing the tab. "Back to projects"
          is the way out when it does not, and it is a real navigation rather
          than a router push, so it rebuilds the page from the server.
        */}
        <Button size="sm" onClick={reset}>
          Try again
        </Button>
        <Button asChild variant="outline" size="sm">
          <a href="/">Back to projects</a>
        </Button>
      </EmptyState>
      {error.digest ? (
        <p className="mt-3 text-xs text-muted-foreground">
          Error ID <span className="font-mono text-code">{error.digest}</span>
        </p>
      ) : null}
    </main>
  )
}
