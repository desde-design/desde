"use client"

import { useEffect, useState, type ReactNode } from "react"
import { ExternalLink } from "lucide-react"
import { Callout, Field, OptionCard, OptionCardGroup } from "@/components/blocks"
import { Button } from "@/components/ui/button"
import { DialogFooter } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { ApiError, fetchJson, failureMessage } from "./api-client"

/**
 * The whole create-a-GitHub-App flow as one embeddable card: why the App
 * exists, whose account should own it, and the button that posts a GitHub App
 * Manifest to github.com. Rendered by the connect-repo wizard (when the
 * deployment has no App and the caller is an Admin) and by Settings › GitHub.
 * It replaced the `/setup` page, which was one action dressed as a checklist.
 *
 * A real form the person clicks, NOT an auto-submit on mount. This creates a
 * GitHub App on their account; they should see what they are about to do
 * before it happens. The `state` is minted server-side and paired with an
 * HttpOnly cookie, so this component never handles the CSRF value itself
 * beyond putting it in the action URL.
 *
 * Owner is asked with radio cards rather than inferred, because it CANNOT be
 * inferred: the manifest flow has no account picker on GitHub's side (the
 * form's target URL decides where the App lands), the person doing this
 * usually has no GitHub identity yet (the App IS the sign-in), and no
 * provider token is stored that could list their organizations.
 */
interface ManifestResponse {
  manifest: unknown
  state: string
}

/**
 * What to say when the manifest request came back refused rather than broken —
 * or `null` when it really did break, which is the only case that earns a red
 * banner.
 *
 * `/api/v1/setup/github/manifest` is operator-only (see `setup-routes.ts`'s
 * `requireOperator`), and this card can mount for people the server will
 * refuse. Three of its answers are the gate working as designed:
 *
 * - **401 — nobody is signed in.** It gets its own sentence instead of
 *   `failureMessage`'s, because `failureMessage` prefers the server's prose
 *   over its own and the server answers a bare `"Unauthorized"` here — one
 *   cold technical word, which was being rendered in a destructive Callout.
 *   Saying what to DO is the whole difference between a dead end and a next
 *   step.
 * - **403 — signed in, but not the operator.** The server's sentence is
 *   already written for a person, so it is used as-is.
 * - **409 — the deployment already has a GitHub App.** Both mount points hide
 *   this card once their own data shows an App, so a 409 means it was
 *   configured in the moment between that render and this fetch. Nothing went
 *   wrong; the surface will say so once it reloads.
 */
function expectedNonFailureMessage(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null
  if (err.status === 401) return "Sign in as an admin of this viewer to create the GitHub App."
  if (err.status === 403 || err.status === 409) return failureMessage(err)
  return null
}

type AppOwner = "personal" | "org"

/**
 * The card's explainer, exported because in a DIALOG it belongs in the
 * header as the `DialogDescription` — sitting in the body it hung 20px
 * under the title while every other modal's description sits 8 (Mo,
 * 2026-08-29). The card renders it itself only in the page context
 * (Settings › GitHub), where there is no dialog header to carry it.
 *
 * Two short sentences (Mo, 2026-08-29: "shorter, more summarized"). "Set up
 * once" stays because this also renders inside a project's own flow,
 * where it would otherwise read as per-project setup.
 */
export const GITHUB_APP_SETUP_INTRO =
  "A GitHub App connects this viewer to GitHub: sign-in, reading repositories, and " +
  "rebuilding on push. It is set up once, with read-only access to only the repositories " +
  "it is granted."

/**
 * The App setup as a dialog STEP of its own (Mo, 2026-08-29: "think of it as
 * another step in the flow" — not content swapped inside the tabbed screen).
 * Card plus footer; the HOST renders its own `DialogTitle` ("Set up GitHub
 * access") for it, the way it titles its other steps.
 *
 * Back returns to the step that offered the setup; Cancel closes the dialog;
 * the submit posts the manifest to github.com. All three land inside the
 * card's `<form>`, hence `type="button"` on the two that must not submit.
 */
export interface GithubAccessSetupStepProps {
  onBack: () => void
  onClose?: () => void
  /** See {@link GithubAppSetupCardProps.returnTo}. */
  returnTo?: string
}

export function GithubAccessSetupStep({ onBack, onClose, returnTo }: GithubAccessSetupStepProps) {
  return (
    <GithubAppSetupCard
      returnTo={returnTo}
      footer={({ submit }) => (
        <DialogFooter className="sm:items-center">
          <Button type="button" size="sm" variant="ghost" className="sm:mr-auto" onClick={onBack}>
            Back
          </Button>
          {onClose ? (
            <Button type="button" variant="outline" size="sm" onClick={onClose}>
              Cancel
            </Button>
          ) : null}
          {submit}
        </DialogFooter>
      )}
    />
  )
}

export interface GithubAppSetupCardProps {
  /**
   * Renders the action row somewhere other than the card's own bottom edge —
   * `GithubAccessSetupStep` uses it to put the submit in its dialog footer,
   * beside Back and Cancel.
   *
   * `submit` is `null` while the card is showing an error or still fetching
   * the manifest: there is nothing to submit, but the host's footer (with
   * its Cancel) should still render, so the callback fires in every state
   * rather than only the happy one.
   *
   * The rendered footer lands INSIDE the card's `<form>`, so any button the
   * host adds must carry `type="button"` or it becomes a second submit.
   */
  footer?: (parts: { submit: ReactNode | null }) => ReactNode
  /**
   * Where the browser lands after the App is created — a same-origin path,
   * carried through the manifest flow's `next` parameter (`setup-routes.ts`).
   * The Add-project wizard passes its own reopen URL so the flow resumes
   * where it started; without it the callback keeps its default destination,
   * the new App's install page (right for Settings › GitHub).
   */
  returnTo?: string
}

export function GithubAppSetupCard({ footer, returnTo }: GithubAppSetupCardProps = {}) {
  const [data, setData] = useState<ManifestResponse | null>(null)
  const [error, setError] = useState<unknown>(null)
  // The manifest flow has no account picker on GitHub's side: the form's
  // TARGET URL decides whether the App lands on the personal account or an
  // organization. Offering only the personal URL would silently exclude
  // every team — which is most real deployments.
  const [owner, setOwner] = useState<AppOwner>("personal")
  const [org, setOrg] = useState("")

  useEffect(() => {
    const url = returnTo
      ? `/api/v1/setup/github/manifest?next=${encodeURIComponent(returnTo)}`
      : "/api/v1/setup/github/manifest"
    fetchJson<ManifestResponse>(url).then(setData).catch(setError)
  }, [returnTo])

  if (error) {
    const expected = expectedNonFailureMessage(error)
    const body = expected ? (
      <p className="text-sm text-muted-foreground">{expected}</p>
    ) : (
      <Callout tone="destructive">{failureMessage(error)}</Callout>
    )
    if (!footer) return body
    return (
      <>
        {body}
        {footer({ submit: null })}
      </>
    )
  }
  if (!data) return footer ? <>{footer({ submit: null })}</> : null

  const trimmedOrg = org.trim()
  const action =
    owner === "org"
      ? `https://github.com/organizations/${encodeURIComponent(trimmedOrg)}/settings/apps/new?state=${encodeURIComponent(data.state)}`
      : `https://github.com/settings/apps/new?state=${encodeURIComponent(data.state)}`

  return (
    // The org Input and the radio group deliberately carry no `name`: the only
    // field this form may submit to github.com is `manifest`.
    //
    // `gap-4`, matching the dialog grid's own section gap: the footer renders
    // INSIDE this form, so the form's gap is what separates it from the
    // content above — at `gap-3` this was the one modal whose footer sat
    // 12px under its body instead of 16 (Mo, 2026-08-29).
    <form method="POST" action={action} className="flex flex-col gap-4">
      <input type="hidden" name="manifest" value={JSON.stringify(data.manifest)} />

      {/* In a dialog (`footer` set) the intro is the host's
          `DialogDescription` instead — see `GITHUB_APP_SETUP_INTRO`. */}
      {!footer ? (
        <p className="text-base text-muted-foreground">{GITHUB_APP_SETUP_INTRO}</p>
      ) : null}

      <OptionCardGroup
        value={owner}
        onValueChange={(next) => setOwner(next as AppOwner)}
        aria-label="Where the App is created"
      >
        <OptionCard
          value="personal"
          title="Personal account"
          hint="The App belongs to your own GitHub account."
        />
        <OptionCard
          value="org"
          title="Organization"
          hint="The App belongs to a GitHub organization you administer."
        />
      </OptionCardGroup>

      {owner === "org" ? (
        <Field
          label="Organization"
          htmlFor="github-app-org"
          /* One line (Mo, 2026-08-29): "e.g." carries the example instead of
             a colon splitting the sentence across two lines. */
          hint={
            <>
              The name in the organization&apos;s GitHub URL, e.g. github.com/
              <span className="font-medium">acme-inc</span>
            </>
          }
        >
          <Input
            id="github-app-org"
            value={org}
            onChange={(e) => setOrg(e.target.value)}
            placeholder="acme-inc"
          />
        </Field>
      ) : null}

      {/* The trailing glyph says the button LEAVES: it navigates this tab to
          github.com, where the App is confirmed (Mo, 2026-08-29 — the caption
          that used to say so in words is gone). Same treatment as Settings'
          "Grant repo access". */}
      {footer ? (
        footer({
          submit: (
            <Button type="submit" size="sm" disabled={owner === "org" && trimmedOrg === ""}>
              Create GitHub App <ExternalLink />
            </Button>
          ),
        })
      ) : (
        <div>
          <Button type="submit" disabled={owner === "org" && trimmedOrg === ""}>
            Create GitHub App <ExternalLink />
          </Button>
        </div>
      )}
    </form>
  )
}
