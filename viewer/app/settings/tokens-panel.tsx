"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { Trash2 } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Callout, CopyButton, EmptyState, Field, FieldGroup, ProjectLoader, SettingsSection } from "@/components/blocks"
import { formatRelativeSpan } from "@/lib/relative-time"
import { cn } from "@/lib/utils"
import { LoadFailure } from "../load-failure"
import { failureMessage } from "../api-client"
import { useCurrentUser } from "../use-current-user"
import {
  isMachineTokenView,
  isTokenExpired,
  validateExpiresInDays,
  validateTokenName,
  validateTokenScopes,
  type MachineTokenScope,
  type MachineTokenView,
} from "./token-utils"

const SCOPE_LABELS: Record<MachineTokenScope, string> = {
  read: "Read: Access projects",
  write: "Write: Create projects and deployments",
}

/** What `POST /api/v1/tokens` returns: the metadata plus the ONE-TIME plaintext. */
interface CreatedToken extends MachineTokenView {
  token: string
}

function isCreatedToken(v: unknown): v is CreatedToken {
  return isMachineTokenView(v) && typeof (v as { token?: unknown }).token === "string"
}

/**
 * Machine token (PAT) management panel — Phase 3b-2 Task 5. Handles all
 * top-level states itself so `page.tsx` can stay a plain Server Component
 * shell. Decision order (viewer-membership Fix wave 4, codex round-4 — see
 * `use-current-user.tsx`'s doc comment on `authEnabled` for the underlying
 * contract):
 *
 * - loading `/api/v1/me` → renders nothing (matches `AccountChip`'s own
 *   "don't flash a wrong state" convention)
 * - `user` present → the list, plus a dialog that creates, regardless of
 *   `authEnabled`. `authEnabled` means ONLY "GitHub sign-in is configured" —
 *   it says nothing about whether THIS caller is signed in. A member who
 *   signed in through an invite link or a magic link on an SMTP-only instance
 *   (no GitHub App at all) is still signed in, and used to see "Sign-in isn't
 *   configured" here instead of their tokens.
 * - signed out, with somewhere to send them (`signInUrl` or
 *   `emailSignInEnabled`) → a "Sign in" prompt, following the same ladder
 *   `AccountMenu` uses: `/signin` when email sign-in is in the mix, straight
 *   to `signInUrl` when GitHub is the only method.
 * - signed out, with NO sign-in method configured at all → "Sign-in isn't
 *   configured", so the panel doesn't look like a broken/empty page
 */
export function TokensPanel() {
  const { user, loading, signInUrl, emailSignInEnabled } = useCurrentUser()

  if (loading) return null

  if (user) return <SignedInTokensPanel />

  if (signInUrl || emailSignInEnabled) {
    const href = emailSignInEnabled ? "/signin" : signInUrl
    return (
      <EmptyState title="Sign in to manage tokens" description="Machine tokens are tied to your account.">
        <Button asChild size="sm">
          {/* `?? undefined`: the guard above already rules out `href` being
              null here (at least one of `signInUrl`/`emailSignInEnabled` is
              truthy), but TypeScript can't see that across the two variables. */}
          <a href={href ?? undefined}>Sign in</a>
        </Button>
      </EmptyState>
    )
  }

  return (
    <EmptyState
      title="Sign-in isn't configured"
      description="This deployment has no GitHub OAuth configured, so machine tokens aren't available here. (Machine tokens authenticate as a signed-in user.)"
    />
  )
}

/**
 * The list, and nothing else.
 *
 * This page used to stack three unrelated things in one column: the one-time
 * plaintext of a token you just made, the form that makes one, and the list of
 * the ones you have. Mo, 2026-08-21: "We should not be mixing creation and
 * listing."
 *
 * So it follows the Editor's settings pattern exactly — a section shows the
 * collection and carries an Add button; the form that adds lives in a dialog.
 * See `src/components/editor/launcher/project-settings-page.tsx`, which does
 * this for design systems and for reference folders, and docs/design.md for
 * the rule.
 */
function SignedInTokensPanel() {
  const [tokens, setTokens] = useState<MachineTokenView[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)

  const [pendingRevokeId, setPendingRevokeId] = useState<string | null>(null)
  const [revoking, setRevoking] = useState(false)
  const [revokeError, setRevokeError] = useState<string | null>(null)
  /**
   * The token was already gone when we tried (HTTP 404).
   *
   * Distinct from `revokeError`, which is a failure worth retrying. There is
   * nothing to retry here: the row is stale, the token stopped working when
   * it was revoked, and offering a Revoke button next to "already revoked"
   * asks the user to do a thing that has happened. See docs/design.md,
   * "A dialog with no options is not a dialog".
   */
  const [revokeGone, setRevokeGone] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/tokens")
      if (!res.ok) throw new Error(`GET tokens ${res.status}`)
      const data = (await res.json()) as { tokens?: unknown }
      const list = Array.isArray(data.tokens) ? data.tokens.filter(isMachineTokenView) : []
      setTokens(list)
      setLoadError(null)
    } catch (err) {
      setLoadError(failureMessage(err))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const handleRevoke = useCallback(async () => {
    if (!pendingRevokeId) return
    setRevoking(true)
    setRevokeError(null)
    setRevokeGone(false)
    try {
      const res = await fetch(`/api/v1/tokens/${encodeURIComponent(pendingRevokeId)}`, { method: "DELETE" })
      // `res.ok` is already true for 204 No Content, so the `res.status !==
      // 204` conjunct that used to sit here could never be the deciding
      // factor: whenever `!res.ok` is true the status isn't 2xx at all, hence
      // isn't 204 either. `!res.ok` alone is the whole condition.
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        if (res.status === 404) {
          // Gone already. Refresh so the stale row leaves the list behind the
          // dialog, and switch the dialog to saying so.
          setRevokeGone(true)
          await load()
          return
        }
        setRevokeError(body?.error ?? "Couldn't revoke that token. Try again.")
        // Leave the confirm dialog open with the error visible — the row stays
        // exactly as it was (never removed optimistically), so a failed revoke
        // can't leave a gap in the list.
        return
      }
      setPendingRevokeId(null)
      await load()
    } finally {
      setRevoking(false)
    }
  }, [pendingRevokeId, load])

  const tokenPendingRevoke = tokens?.find((t) => t.id === pendingRevokeId) ?? null

  return (
    <>
      <SettingsSection
        frame="bare"
        title="Tokens"
        description="A token authenticates as you. Connect the Editor with one so it can read this project and sync comments. Revoking a token stops it working immediately."
        action={
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setCreateOpen(true)}
            data-testid="token-create-open"
          >
            Create token
          </Button>
        }
        data-testid="settings-section-tokens"
      >
        {loadError && tokens === null ? (
          <LoadFailure size="sm" title="Couldn't load tokens" description={loadError} />
        ) : tokens === null ? (
          <ProjectLoader size={80} label="Loading" className="py-6" />
        ) : tokens.length === 0 ? (
          /* The action repeats the section's own button, deliberately (Mo,
             2026-08-29: "for empty states like tokens there should be a
             button underneath to create or add whatever to that list"). An
             empty state is where a reader's eye already is, and sending them
             back up to the header to act is the one avoidable step here. */
          <EmptyState size="sm" title="No tokens" description="Create one to connect the Editor.">
            <Button variant="outline" size="sm" onClick={() => setCreateOpen(true)}>
              Create token
            </Button>
          </EmptyState>
        ) : (
          /*
            One row, five columns, aligned down the list.

            `grid-cols-subgrid` on each `<li>` is what makes the columns line
            up: a grid on the row alone sizes its own tracks, so every row
            would put its dates somewhere different. The `<ul>` owns the
            tracks and each row borrows them.

            Back to one line after a spell at two (Mo, 2026-08-21). Two lines
            were the right answer for SEVEN columns, which truncated the name
            to "C…". At five they fit: the token prefix went, and created and
            last-used collapsed into one column, because only one of them ever
            tells you anything.
          */
          <ul className="flex flex-col rounded-md border">
            {tokens.map((t) => {
              const expired = isTokenExpired(t.expiresAt)
              return (
                <li
                  key={t.id}
                  className="flex items-start gap-3 border-t border-border px-3 py-2 first:border-t-0"
                  data-testid={`token-row-${t.id}`}
                >
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    {/* The name on its own line, everything else under it
                        (Mo, 2026-08-29). It went one-line on 2026-08-21
                        because at five columns the fields fitted; they fit by
                        truncating the NAME, which is the one field a person
                        recognises a token by. Two lines give it the full
                        width and let the metadata sit together as what it is:
                        one row of facts about that name.

                        `text-base`, two steps up from the `text-xs` it held
                        as a column. That size came with a note saying "the
                        name is not a heading, it is the first column of a
                        row, and setting it a step larger made every row look
                        like a title with metadata under it" — which is now
                        exactly what the row IS, so the reason expired with
                        the layout it described. */}
                    <span className="min-w-0 truncate text-base text-foreground">{t.name}</span>
                    {/* The subgrid is gone with the single line. It existed so
                        every row's columns lined up; a metadata row that
                        wraps has no columns to line up, and each row now
                        packs its own facts from the left. */}
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="flex flex-none gap-1">
                        {t.scopes.map((scope) => (
                          <Badge key={scope} variant="outline">
                            {scope}
                          </Badge>
                        ))}
                      </span>
                  {/*
                    Last used, or created when it never was. Both columns said
                    something, but only one of them says anything: "Last used
                    2026-08-18" makes "Created 2026-08-01" redundant, and
                    "Last used Never" is a fact about a date that does not
                    exist, printed where a date goes.
                  */}
                      <span className="flex-none text-xs text-muted-foreground">
                        {t.lastUsedAt
                          ? `Last used ${formatRelativeSpan(t.lastUsedAt)}`
                          : `Created ${formatRelativeSpan(t.createdAt)}`}
                      </span>
                  {/*
                    Spans, not dates (Mo, 2026-08-21). The question this
                    column answers is "is this about to stop working?", and a
                    calendar date makes the reader do the arithmetic.

                    An expired token shows just "Expired". The date it expired
                    on changes nothing anyone does next: it is dead, and the
                    only action left is to remove it.
                  */}
                      <span
                        className={cn(
                          "flex-none text-xs",
                          expired ? "font-medium text-destructive" : "text-muted-foreground",
                        )}
                      >
                        {!t.expiresAt
                          ? "No expiry"
                          : expired
                            ? "Expired"
                            : `Expires ${formatRelativeSpan(t.expiresAt)}`}
                      </span>
                    </div>
                  </div>
                  {/*
                    A plain icon button, not a red word (Mo, 2026-08-21). Every
                    row carries one, so colouring it destructive paints a
                    column of alarm down a list where nothing is wrong. The
                    confirm it opens is where the warning belongs.
                  */}
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Revoke ${t.name}`}
                    className="-mr-1 flex-none"
                    onClick={() => {
                      setRevokeError(null)
                      setPendingRevokeId(t.id)
                    }}
                  >
                    <Trash2 />
                  </Button>
                </li>
              )
            })}
          </ul>
        )}

      </SettingsSection>

      <CreateTokenDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={load} />

      <Dialog
        open={pendingRevokeId !== null}
        onOpenChange={(open) => {
          if (open || revoking) return
          setPendingRevokeId(null)
          setRevokeGone(false)
        }}
      >
        {revokeGone ? (
          /*
            Nothing to decide, so no decision. One Close, and no header `X`
            beside it: both would be named Close, and the second one is the
            control that makes a refusal look like a choice.
          */
          <DialogContent size="md" showCloseButton={false} data-testid="revoke-already-gone">
            <DialogHeader>
              <DialogTitle>This token is already revoked</DialogTitle>
              <DialogDescription>
                It stopped working when it was revoked, and the list has been refreshed.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                size="sm"
                onClick={() => {
                  setPendingRevokeId(null)
                  setRevokeGone(false)
                }}
              >
                Close
              </Button>
            </DialogFooter>
          </DialogContent>
        ) : (
          /* No `X` while the revoke is in flight: dismissing it would not
             cancel the request, so it offers a way out that isn't one
             (docs/design.md, "Don't offer a way out that isn't one").
             Mo, 2026-08-28. Cancel stays, disabled, because it DOES become
             live again if the revoke fails. */
          <DialogContent showCloseButton={!revoking}>
            <DialogHeader>
              <DialogTitle>Revoke this token?</DialogTitle>
              <DialogDescription>
                {tokenPendingRevoke ? (
                  <>
                    <strong className="text-foreground">{tokenPendingRevoke.name}</strong> will stop
                    working immediately. This cannot be undone.
                  </>
                ) : (
                  "This cannot be undone."
                )}
              </DialogDescription>
            </DialogHeader>
            {revokeError ? <Callout tone="destructive">{revokeError}</Callout> : null}
            <DialogFooter>
              <Button
                variant="outline"
                size="sm"
                disabled={revoking}
                onClick={() => setPendingRevokeId(null)}
              >
                Cancel
              </Button>
              <Button variant="destructive" size="sm" busy={revoking} onClick={() => void handleRevoke()}>
                {revoking ? "Revoking" : "Revoke"}
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </>
  )
}

/**
 * Creating a token, in two phases: the form, then the value.
 *
 * They are phases of one dialog rather than two surfaces because they are one
 * errand — you asked for a token, here is the token — and because the value
 * has to be impossible to walk past. On the page it was a box above a form,
 * competing with the form for attention and scrolling away.
 *
 * ## The plaintext
 *
 * `created.token` is the only moment in a token's life that the plaintext
 * exists outside the client that will use it: the server hashes it and the
 * list endpoint never returns it. It lives ONLY in this component's React
 * state — never localStorage, sessionStorage or a URL — and `handleOpenChange`
 * clears it on close. Re-fetching the list can never repopulate it, because
 * the list only ever carries `MachineTokenView`, which has no `token` field.
 *
 * ## Why the value phase refuses to close by accident
 *
 * `onInteractOutside` and `onEscapeKeyDown` are prevented while the value is
 * showing, so the only way out is the Done button. A value that cannot be
 * recovered should not be dismissable by a stray click on the overlay. The
 * form phase keeps both, because nothing is lost by abandoning a form.
 */
function CreateTokenDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Refresh the list. Called as soon as the POST succeeds, so the list behind the dialog is already right. */
  onCreated: () => Promise<void>
}) {
  const [name, setName] = useState("")
  const [scopeRead, setScopeRead] = useState(true)
  const [scopeWrite, setScopeWrite] = useState(false)
  const [expiryEnabled, setExpiryEnabled] = useState(false)
  const [expiresInDaysRaw, setExpiresInDaysRaw] = useState("30")
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [created, setCreated] = useState<CreatedToken | null>(null)

  const scopes: MachineTokenScope[] = useMemo(
    () => [...(scopeRead ? (["read"] as const) : []), ...(scopeWrite ? (["write"] as const) : [])],
    [scopeRead, scopeWrite],
  )
  const expiresInDays = expiryEnabled ? parseExpiryInput(expiresInDaysRaw) : null
  const nameError = validateTokenName(name)
  const scopesError = validateTokenScopes(scopes)
  const expiryError = expiryEnabled ? validateExpiresInDays(expiresInDays) : null
  const canSubmit = !creating && nameError === null && scopesError === null && expiryError === null

  const handleOpenChange = useCallback(
    (next: boolean) => {
      // Closing resets everything, including the plaintext. This is what makes
      // "shown once" true: the dialog is rendered by a parent that stays
      // mounted, so nothing else would clear it.
      if (!next) {
        setCreated(null)
        setName("")
        setScopeRead(true)
        setScopeWrite(false)
        setExpiryEnabled(false)
        setExpiresInDaysRaw("30")
        setCreateError(null)
      }
      onOpenChange(next)
    },
    [onOpenChange],
  )

  const handleCreate = useCallback(async () => {
    if (!canSubmit) return
    setCreating(true)
    setCreateError(null)
    try {
      const res = await fetch("/api/v1/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          scopes,
          ...(expiresInDays !== null ? { expiresInDays } : {}),
        }),
      })
      const body: unknown = await res.json().catch(() => null)
      if (!res.ok) {
        const message =
          body !== null && typeof body === "object" && typeof (body as { error?: unknown }).error === "string"
            ? (body as { error: string }).error
            : `Couldn't create that token (HTTP ${res.status})`
        setCreateError(message)
        return
      }
      if (!isCreatedToken(body)) {
        setCreateError("Server returned an unexpected response.")
        return
      }
      setCreated(body)
      await onCreated()
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err))
    } finally {
      setCreating(false)
    }
  }, [canSubmit, name, scopes, expiresInDays, onCreated])

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        size="lg"
        /* Also closed while the create is in flight, not only once the
           plaintext is showing. Mo, 2026-08-28. */
        showCloseButton={created === null && !creating}
        onInteractOutside={(e) => created && e.preventDefault()}
        onEscapeKeyDown={(e) => created && e.preventDefault()}
        data-testid="token-create-dialog"
      >
        {created ? (
          <>
            <DialogHeader>
              <DialogTitle>Copy this token now</DialogTitle>
              <DialogDescription>
                It will not be shown again. Store it somewhere safe: anyone with this string can act as
                you, within its scopes.
              </DialogDescription>
            </DialogHeader>
            <div className="flex items-center gap-1.5">
              <code className="min-w-0 flex-1 truncate rounded-sm bg-muted px-2 py-1 text-code">
                {created.token}
              </code>
              <CopyButton value={created.token} />
            </div>
            {/*
              Where it goes, said at the only moment the user holds it.
              Otherwise this dialog hands over a secret and leaves the reader
              to work out what to do with it, which is the point at which a
              one-time value gets pasted into a scratch file "for later".

              Deliberately the mirror image of the Editor's own field hint
              ("In the viewer: Settings, then Create token", see
              `src/components/editor/connect-viewer-dialog.tsx`). The two
              halves of one handover should name each other; if either label
              is renamed, both strings move.
            */}
            {/*
              Set exactly like `DialogDescription` above it: `text-base
              text-foreground` (Mo, 2026-08-21). It was `text-sm
              text-muted-foreground`, which made the instruction quieter than
              the warning it follows, and this line is the only thing in the
              dialog that tells you what to DO next. Two prose blocks in one
              dialog reading at two weights is a hierarchy that says the
              second one matters less.
            */}
            <p className="text-base text-foreground" data-testid="token-usage-hint">
              To connect the Editor, open its settings menu, choose{" "}
              <strong className="font-medium">Share for review</strong>, and paste this into{" "}
              <strong className="font-medium">Access token</strong>. It is stored on that machine
              only.
            </p>
            <DialogFooter>
              <Button size="sm" onClick={() => handleOpenChange(false)}>
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Create a token</DialogTitle>
              <DialogDescription>
                Name it for the machine that will use it, and give it only the scopes that machine needs.
              </DialogDescription>
            </DialogHeader>

            <FieldGroup>
              <Field label="Name" htmlFor="token-name" error={name.length > 0 ? nameError : null}>
                <Input
                  id="token-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="editor-macbook"
                />
              </Field>

              <Field label="Scopes" error={scopesError}>
                <div className="flex flex-col gap-1.5">
                  {(["read", "write"] as const).map((scope) => (
                    <label key={scope} className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={scope === "read" ? scopeRead : scopeWrite}
                        onCheckedChange={(checked) =>
                          (scope === "read" ? setScopeRead : setScopeWrite)(checked === true)
                        }
                      />
                      {SCOPE_LABELS[scope]}
                    </label>
                  ))}
                </div>
              </Field>

              <Field
                label="Expiry"
                hint={expiryEnabled ? null : "Expires after one year unless a shorter window is set."}
                error={expiryError}
              >
                <div className="flex items-center gap-2">
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={expiryEnabled}
                      onCheckedChange={(checked) => setExpiryEnabled(checked === true)}
                    />
                    Expires after
                  </label>
                  <Input
                    type="number"
                    min={1}
                    max={365}
                    step={1}
                    size="sm"
                    className="w-20"
                    disabled={!expiryEnabled}
                    value={expiresInDaysRaw}
                    onChange={(e) => setExpiresInDaysRaw(e.target.value)}
                  />
                  <span className="text-xs text-muted-foreground">days</span>
                </div>
              </Field>
            </FieldGroup>

            {createError ? <Callout tone="destructive">{createError}</Callout> : null}

            <DialogFooter>
              <Button variant="outline" size="sm" disabled={creating} onClick={() => handleOpenChange(false)}>
                Cancel
              </Button>
              {/* `data-busy` is the only DOM signal that the POST is in
                  flight. Disabledness is not one: this button is also
                  disabled on an empty form, so anything watching
                  `button:disabled` sees "busy" the moment the dialog opens.
                  The surface gallery watches this attribute. */}
              <Button
                size="sm"
                disabled={!canSubmit}
                busy={creating}
                data-busy={creating || undefined}
                onClick={() => void handleCreate()}
              >
                {creating ? "Creating" : "Create token"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

function parseExpiryInput(raw: string): number {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return NaN
  return Number(trimmed)
}
