"use client"

import Link from "next/link"
import { Github } from "lucide-react"
import { useState, type FormEvent } from "react"
import { CatAtPortal, Field, Wordmark } from "@/components/blocks"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import { fetchJson, failureMessage } from "../api-client"
import { useCurrentUser } from "../use-current-user"
import { LOCAL_OPERATOR_SENTENCE } from "./sign-in-copy"

/**
 * What `POST /auth/magic-link` answers with once the link is sent.
 *
 * The "15 minutes" here is a THIRD copy of a duration whose single source of
 * truth is `SIGN_IN_LINK_TTL_MINUTES` in `viewer/server/auth/auth-constants.ts`
 * (that file's own doc comment already tracks two: the route's
 * `MAGIC_LINK_EXPIRES_MS` and `notify/auth-email.ts`'s rendered sentence).
 * App code cannot import server code here (`viewer/app` ships to the
 * browser; `viewer/server` pulls in Node-only modules like `better-sqlite3`
 * that cannot be bundled for a client), so this stays a literal rather than
 * a shared constant. Exported so `page.test.ts` can assert it still tracks
 * `SIGN_IN_LINK_TTL_MINUTES` — that test is what turns a TTL change into a
 * failing test instead of a silently stale sentence.
 */
export const SIGN_IN_LINK_SENT = "Check your email. The link expires in 15 minutes."

/**
 * The email half of the page. Its own component so the "sent" state can
 * `return` early without disturbing the GitHub button or divider beside it.
 */
function EmailSignInForm() {
  const [email, setEmail] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const trimmed = email.trim()
    if (!trimmed || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      // `fetchJson` resolves on ANY 2xx and rejects on everything else — and
      // `POST /auth/magic-link` answers 202 for a member, a domain-rule
      // address, and a stranger alike, on purpose (see that route's own doc
      // comment on why the response can never distinguish them). Flipping to
      // `sent` off nothing but a successful `fetchJson` call, never off
      // anything IN the resolved body, is this form's half of that same
      // discipline: it must not learn — or leak — anything the response
      // withholds.
      //
      // A 400 (malformed address) is the one case that legitimately answers
      // differently, and it lands in the `catch` below as a normal
      // `ApiError` with the server's own sentence — that one differs because
      // it is a fact about what was TYPED, not about who has an account.
      await fetchJson("/api/v1/auth/magic-link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: trimmed }),
      })
      setSent(true)
    } catch (err) {
      setError(failureMessage(err))
    } finally {
      setSubmitting(false)
    }
  }

  if (sent) {
    return (
      <p data-testid="signin-email-sent" className="text-base text-foreground">
        {SIGN_IN_LINK_SENT}
      </p>
    )
  }

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-3">
      <Field label="Email" htmlFor="signin-email" error={error}>
        <Input
          id="signin-email"
          type="email"
          autoComplete="email"
          placeholder="name@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          data-testid="signin-email-input"
        />
      </Field>
      <Button
        type="submit"
        className="w-full"
        disabled={!email.trim() || submitting}
        data-testid="signin-email-submit"
      >
        Email a sign-in link
      </Button>
    </form>
  )
}

/**
 * `/signin` — viewer-membership Task 15.
 *
 * `AccountMenu`'s "Sign in" button already goes straight to GitHub when
 * GitHub is the only configured method (see its own doc comment), so this
 * page only has to earn a visit by having a real choice to offer: GitHub,
 * email, or both. What it shows is read off `useCurrentUser()` — the same
 * `GET /api/v1/me` fetch `AccountMenu` makes — rather than the boot-time
 * `ViewerConfig`, because `signInUrl` in particular tracks the LIVE GitHub
 * provider (it can appear mid-process via the App Manifest flow; see
 * `auth-routes.ts`'s own doc comment), and this page must agree with the
 * button that sent someone here.
 *
 * Four content states, chosen by two booleans:
 *
 * | `signInUrl` | `emailSignInEnabled` | Shown |
 * | --- | --- | --- |
 * | set | false | GitHub button only |
 * | null | true | Email form only |
 * | set | true | GitHub button, a divider, the email form |
 * | null | false | The local-operator sentence |
 *
 * The last row is reachable only by someone who lands here directly (a stale
 * bookmark, a typed URL): on that deployment shape `AccountMenu` renders no
 * "Sign in" button anywhere, so nothing in the product links here. (It does
 * still render a Settings link in that corner as of 2026-08-28 — what it
 * drops is the sign-in button, not the whole control.)
 */
export default function SignInPage() {
  const { loading, signInUrl, emailSignInEnabled } = useCurrentUser()
  const hasAnyMethod = signInUrl !== null || emailSignInEnabled

  return (
    /*
      Centred, then raised (Mo, 2026-08-28: "the vertical positioning of the
      content seems just a little low"). True centring is not optical
      centring: a block sitting exactly halfway down reads as low, because
      the eye takes the midpoint of a page to be a little above the
      geometric one.

      The lift is asymmetric padding, not a transform: `justify-center`
      centres within the content box, so a taller bottom pad shrinks that box
      from below and moves the centre up by half the difference — here
      (24 - 8) / 2 = 8 units, 32px. A `-translate-y` would move the box off
      its own layout position instead, which stops being a lift and starts
      being an overlap the moment the card grows (the both-methods state is
      twice this tall).
    */
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-background px-8 pt-8 pb-24 text-foreground">
      {/* The same cat that fronts every "you are not through this door" state
          (Mo, 2026-08-29) — `EmptyState`'s `tone="denied"` uses it for signed
          out, not permitted and not found. This page is the door itself, so it
          gets the drawing directly rather than through an empty state.

          Above the wordmark, which sits between it and the form (Mo,
          2026-08-29). The picture is what the eye lands on; the wordmark then
          says whose door this is, immediately before the control that opens
          it. */}
      <CatAtPortal className="size-40 shrink-0" />
      <Link href="/">
        <Wordmark />
      </Link>
      <Card className="w-full max-w-sm">
        <CardHeader>
          {/*
            "Sign in with", and the button below carries only the provider's
            name (Mo, 2026-08-28). The verb belongs to the heading, so it is
            said once for however many methods this deployment offers rather
            than repeated on each button. It also keeps the buttons a column
            of names, which is what makes a list of providers scannable.

            It drops back to a plain "Sign in" whenever no NAMED provider
            button follows it, which is both the local-operator state and the
            email-only one. "Sign in with" is a preposition, so it needs the
            thing it points at to be the next element on screen: over the
            local-operator sentence it dangles, and over the email form the
            next word is the field's own label rather than a method name.
          */}
          {/* Centred (Mo, 2026-09-01). The card holds a single column of
              full-width controls under it, so a left-aligned heading was the
              only thing on the card not on its centre line. */}
          <CardTitle className="text-center text-lg">
            {signInUrl ? "Sign in with" : "Sign in"}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {/* Blank while `/me` is in flight, rather than guessing: this page
              never had a server-rendered snapshot to show first, and a wrong
              guess (say, the local-operator sentence while GitHub is still
              loading) is worse than a one-tick blank card. */}
          {loading ? null : hasAnyMethod ? (
            <>
              {signInUrl ? (
                <Button asChild variant="outline" className="w-full" data-testid="signin-github">
                  {/* A real page navigation, not client routing — see
                      `AccountMenu`'s matching comment. */}
                  <a href={signInUrl}>
                    <Github />
                    GitHub
                  </a>
                </Button>
              ) : null}
              {signInUrl && emailSignInEnabled ? (
                <div className="flex items-center gap-2">
                  <Separator className="flex-1" />
                  <span className="text-xs text-muted-foreground">or</span>
                  <Separator className="flex-1" />
                </div>
              ) : null}
              {emailSignInEnabled ? <EmailSignInForm /> : null}
            </>
          ) : (
            <p data-testid="signin-local-operator" className="text-base text-muted-foreground">
              {LOCAL_OPERATOR_SENTENCE}
            </p>
          )}
        </CardContent>
      </Card>
    </main>
  )
}
