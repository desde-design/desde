import Link from "next/link"
import { loadConfig } from "../../../server/config"
import { EmptyState } from "@/components/blocks"
import { Button } from "@/components/ui/button"

/**
 * Next.js special file: rendered whenever `notFound()` fires inside this
 * route segment. Two cases collapse into this ONE view: "couldn't fetch the
 * project list" and "not in the readable list". Same indistinguishable-404
 * principle as the server-side visibility gate in `server/auth/authorize.ts`:
 * telling a genuinely-missing slug apart from a project the visitor can't
 * read would itself leak that the project exists.
 *
 * "No active deployment" USED to be a third case here and no longer is
 * (2026-09-01). It never belonged: that project is one the caller has already
 * been proven entitled to see, so hiding it behind the 404 protected nothing
 * and cost an honest answer. It now renders `never-deployed.tsx` instead.
 * See `resolveReviewProject` for why splitting the two leaks nothing.
 *
 * Phase 3b-1 Task 4: since a `members`-visibility project is exactly the
 * kind of thing that lands here for a signed-out visitor, the copy adds a
 * plain pointer at sign-in — without claiming the project actually exists,
 * which would defeat the indistinguishable-404 property above. The sign-in
 * link itself is only offered when this deployment has GitHub OAuth
 * configured at all (`config.githubAuth`); otherwise it would be a dead
 * link, and "sign in" isn't even a coherent action.
 */
export default function ReviewNotFound() {
  const config = loadConfig()

  return (
    <main className="mx-auto flex max-w-md flex-col items-center p-8 text-center">
      {/*
        The buttons go in `EmptyState`'s own children slot, not beside it.

        They used to be a sibling in a `gap-4` column, which stacked three
        separate spacings between the description and the buttons: the block's
        `py-6` bottom padding, the column's `gap-4`, and the block's internal
        `mt-3` doing nothing because it was on an empty slot. That measured
        40px where the block intends 16, which is what Mo saw on 2026-08-28
        ("tighten up the distance between the text and the buttons in these
        type of screens").

        This is the exact failure the block's action-row comment describes,
        arriving from the other direction: that one was callers ADDING their
        own margin, this one is a caller routing around the slot entirely. The
        rule either way is that the block owns the rhythm.
      */}
      <EmptyState
        /* `denied`, not the default empty bowl (Mo, 2026-08-29). This screen
           covers both "does not exist" and "exists but is not yours", and the
           404 is deliberately byte-identical for the two (see
           `server/auth/authorize.ts` — a 403 would leak existence). One
           picture for "the way in is not open" is exactly right for a message
           that must not say which of the two it is. */
        tone="denied"
        title="Project not found"
        description={
          config.githubAuth
            ? "This project doesn't exist, or it's members-only and you're not signed in as a member. If you were invited, try signing in."
            : "This project doesn't exist, or you don't have access to it."
        }
      >
        {config.githubAuth ? (
          <Button asChild size="sm">
            <a href="/api/v1/auth/github">Sign in with GitHub</a>
          </Button>
        ) : null}
        <Button asChild variant="outline" size="sm">
          <Link href="/">Back to projects</Link>
        </Button>
      </EmptyState>
    </main>
  )
}
