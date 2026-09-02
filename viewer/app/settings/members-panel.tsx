"use client"

import { useCallback, useEffect, useState } from "react"
import { Plus, Trash2 } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { avatarInitial } from "@/lib/initials"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Callout, CopyButton, EmptyState, Field, ListRow, ProjectLoader, SettingsSection } from "@/components/blocks"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { LoadFailure } from "../load-failure"
import { failureMessage } from "../api-client"
import { useCurrentUser } from "../use-current-user"
import { isInstanceRole, type InstanceRole } from "../instance-role"

/**
 * The fixed-expiry sentence in the admin-issued sign-in link reveal below.
 *
 * The "24 hours" here is a copy of a duration whose single source of truth
 * is `ADMIN_SIGN_IN_LINK_TTL_HOURS` in `viewer/server/auth/auth-constants.ts`
 * (that file's own doc comment tracks this copy alongside the sibling
 * "15 minutes" one on `/signin`'s `SIGN_IN_LINK_SENT`). App code cannot
 * import server code here (`viewer/app` ships to the browser; `viewer/server`
 * pulls in Node-only modules like `better-sqlite3` that cannot be bundled for
 * a client), so this stays a literal rather than a shared constant. Exported
 * so `members-panel.test.ts` can assert it still tracks
 * `ADMIN_SIGN_IN_LINK_TTL_HOURS` — that test is what turns a TTL change into
 * a failing test instead of a silently stale sentence.
 */
export const SIGN_IN_LINK_EXPIRES_COPY = "It expires in 24 hours."

/**
 * Local wire shapes for `/api/v1/instance/members` and
 * `/api/v1/instance/invites` — declared here rather than imported, the same
 * convention `project-access.tsx` and `use-current-user.ts` use: server-only
 * code (`viewer/server/api/instance-routes.ts`) isn't reachable from app code
 * via the `@/*` alias, so this component only ever needs the wire shape the
 * two GETs actually return. `InstanceRole` itself is the one shared app-side
 * copy (`../instance-role.ts`), not a local redeclaration.
 */
interface MemberView {
  userId: string
  email: string
  displayName: string
  avatarUrl: string
  role: InstanceRole
  status: "active" | "removed"
  createdAt: string
}

function isMemberView(v: unknown): v is MemberView {
  if (typeof v !== "object" || v === null) return false
  const m = v as Record<string, unknown>
  return (
    typeof m.userId === "string" &&
    typeof m.email === "string" &&
    typeof m.displayName === "string" &&
    isInstanceRole(m.role) &&
    (m.status === "active" || m.status === "removed")
  )
}

type InviteState = "pending" | "used" | "revoked" | "expired"

interface InviteView {
  id: string
  email: string
  role: InstanceRole
  state: InviteState
}

function isInviteView(v: unknown): v is InviteView {
  if (typeof v !== "object" || v === null) return false
  const i = v as Record<string, unknown>
  return (
    typeof i.id === "string" &&
    typeof i.email === "string" &&
    isInstanceRole(i.role) &&
    (i.state === "pending" || i.state === "used" || i.state === "revoked" || i.state === "expired")
  )
}

const INVITE_STATE_LABEL: Record<InviteState, string> = {
  pending: "Pending",
  used: "Used",
  revoked: "Revoked",
  expired: "Expired",
}

/** What a successful create or regenerate call reveals, once. */
interface RevealedInvite {
  email: string
  url: string
  /**
   * Whether the server actually sent this link by email (SMTP configured
   * and the send didn't fail/throw) — see `POST /instance/invites`'
   * `emailed` field. `false` covers every reason it wasn't sent (no SMTP
   * configured, a failed or throwing send): the recipient never got
   * anything, so the link is the ONLY way they learn about it, and the copy
   * below says so.
   */
  emailed: boolean
}

/**
 * Members panel (viewer-membership Task 8). Two tabs (Mo, 2026-08-31):
 * Members — the ACTIVE accounts on this instance — and Invites. Removed
 * accounts are filtered out client-side and simply disappear on removal;
 * the server keeps its rows (`GET /api/v1/instance/members` still returns
 * them as an audit trail), but the list stopped showing a Removed status
 * with a Restore button — a state Mo judged not worth a control.
 *
 * Admin-only: the server enforces this independently
 * (`requireInstanceAdmin`), so the `role !== "admin"` check here is a UX
 * courtesy that keeps a viewer or editor from seeing a section they have no
 * access to, not the actual gate.
 */
export function MembersPanel() {
  const { user, loading } = useCurrentUser()
  if (loading || !user || user.role !== "admin") return null
  return <SignedInMembersPanel currentUserId={user.id} />
}

function SignedInMembersPanel({ currentUserId }: { currentUserId: string }) {
  // Reads from the SAME `CurrentUserProvider` fetch every other settings
  // panel shares (`use-current-user.tsx`'s doc comment) — this does not add
  // a second `/me` request, only a second reader of the one already in
  // flight/cached. `refresh` is what keeps that shared state from going
  // stale after the caller mutates their OWN row below.
  const { refresh } = useCurrentUser()

  const [members, setMembers] = useState<MemberView[] | null>(null)
  const [invites, setInvites] = useState<InviteView[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [updatingUserId, setUpdatingUserId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const [inviteOpen, setInviteOpen] = useState(false)
  /** Which tab is showing — controlled so the section header's action (the
   * Invite button) can render only where a new invite would land. */
  const [tab, setTab] = useState<"members" | "invites">("members")

  // The one-time invite-link reveal — populated by a successful create OR a
  // successful regenerate, since both mint a fresh plaintext token that is
  // only ever sent back in that one response. Mirrors `tokens-panel.tsx`'s
  // `revealed` state and the same "never repopulated by a re-fetch" property:
  // the list endpoints never carry the plaintext URL.
  const [revealed, setRevealed] = useState<RevealedInvite | null>(null)

  const [regeneratingId, setRegeneratingId] = useState<string | null>(null)
  const [revokingInviteId, setRevokingInviteId] = useState<string | null>(null)
  const [inviteActionError, setInviteActionError] = useState<string | null>(null)

  // The one-time SIGN-IN LINK reveal (viewer-membership X3) — its own state,
  // separate from `revealed` above: an invite creates a NEW account and its
  // copy talks about "becomes EMAIL's account"; this mints a credential for
  // an EXISTING member and its copy has to say so ("signs in as NAME"), plus
  // a different expiry (24 hours, not the invite's 7 days). Same one-time-
  // reveal PATTERN, deliberately not the same state or copy.
  const [signInLinkRevealed, setSignInLinkRevealed] = useState<{ name: string; url: string } | null>(
    null,
  )
  const [mintingSignInLinkUserId, setMintingSignInLinkUserId] = useState<string | null>(null)
  const [signInLinkError, setSignInLinkError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [membersRes, invitesRes] = await Promise.all([
        fetch("/api/v1/instance/members"),
        fetch("/api/v1/instance/invites"),
      ])
      if (!membersRes.ok) throw new Error(`GET members ${membersRes.status}`)
      if (!invitesRes.ok) throw new Error(`GET invites ${invitesRes.status}`)
      const membersData = (await membersRes.json()) as { members?: unknown }
      const invitesData = (await invitesRes.json()) as { invites?: unknown }
      setMembers(Array.isArray(membersData.members) ? membersData.members.filter(isMemberView) : [])
      setInvites(Array.isArray(invitesData.invites) ? invitesData.invites.filter(isInviteView) : [])
      setLoadError(null)
    } catch (err) {
      setLoadError(failureMessage(err))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const handleRoleChange = useCallback(
    async (userId: string, role: InstanceRole) => {
      setUpdatingUserId(userId)
      setActionError(null)
      try {
        const res = await fetch(`/api/v1/instance/members/${encodeURIComponent(userId)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ role }),
        })
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null
          setActionError(body?.error ?? "Couldn't change that role. Try again.")
          return
        }
        await load()
        // The caller just changed their OWN role — the server's session
        // state has moved out from under whatever `/me` returned at page
        // load, and every other settings panel (and the top-bar account
        // menu) reads that same shared state. A DIFFERENT member's row
        // never touches it: this session's own role hasn't changed.
        if (userId === currentUserId) await refresh()
      } catch (err) {
        setActionError(failureMessage(err))
      } finally {
        setUpdatingUserId(null)
      }
    },
    [load, refresh, currentUserId],
  )

  const handleRemove = useCallback(
    async (userId: string) => {
      setUpdatingUserId(userId)
      setActionError(null)
      try {
        const res = await fetch(`/api/v1/instance/members/${encodeURIComponent(userId)}`, { method: "DELETE" })
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null
          setActionError(body?.error ?? "Couldn't remove that member. Try again.")
          // Fix wave 11, item 4: reload even on failure. The partial-
          // revocation 500 still reports the member WAS removed (status
          // flipped, only some credentials could not be swept), so the row
          // must reflect that — without this reload it kept showing the
          // member as active. `load()` writes `loadError`, not `actionError`,
          // so the server's message above stays surfaced. A no-op reload on
          // a 4xx (e.g. a lockout refusal) is harmless.
          await load()
          return
        }
        if (userId === currentUserId) {
          // The caller just removed their OWN account: the session is
          // dead, and there is no member list left to re-render in place
          // (re-fetching it would 403 or, worse, keep showing this whole
          // page as if nothing happened). Confirm the removal against `/me`
          // — it now reports signed-out — then leave for the signed-out
          // home rather than `load()`ing a list this caller can no longer
          // read.
          await refresh()
          window.location.assign("/")
          return
        }
        await load()
      } catch (err) {
        setActionError(failureMessage(err))
      } finally {
        setUpdatingUserId(null)
      }
    },
    [load, refresh, currentUserId],
  )


  const handleMintSignInLink = useCallback(async (userId: string, displayName: string) => {
    setMintingSignInLinkUserId(userId)
    setSignInLinkError(null)
    try {
      const res = await fetch(`/api/v1/instance/members/${encodeURIComponent(userId)}/signin-link`, {
        method: "POST",
      })
      const body = (await res.json().catch(() => null)) as { url?: unknown; error?: string } | null
      if (!res.ok) {
        setSignInLinkError(body?.error ?? "Couldn't mint a sign-in link. Try again.")
        return
      }
      if (!body || typeof body.url !== "string") {
        setSignInLinkError("Server returned an unexpected response.")
        return
      }
      setSignInLinkRevealed({ name: displayName, url: body.url })
      } catch (err) {
      setSignInLinkError(failureMessage(err))
    } finally {
      setMintingSignInLinkUserId(null)
    }
  }, [])

  const dismissSignInLinkReveal = useCallback(() => {
    setSignInLinkRevealed(null)
  }, [])

  const handleRegenerate = useCallback(
    async (id: string, email: string) => {
      setRegeneratingId(id)
      setInviteActionError(null)
      try {
        const res = await fetch(`/api/v1/instance/invites/${encodeURIComponent(id)}/regenerate`, {
          method: "POST",
        })
        const body = (await res.json().catch(() => null)) as
          | { url?: unknown; emailed?: unknown; error?: string }
          | null
        if (!res.ok) {
          setInviteActionError(body?.error ?? "Couldn't resend that invitation. Try again.")
          return
        }
        if (!body || typeof body.url !== "string") {
          setInviteActionError("Server returned an unexpected response.")
          return
        }
        setRevealed({ email, url: body.url, emailed: body.emailed === true })
        await load()
      } catch (err) {
        setInviteActionError(failureMessage(err))
      } finally {
        setRegeneratingId(null)
      }
    },
    [load],
  )

  const handleRevokeInvite = useCallback(
    async (id: string) => {
      setRevokingInviteId(id)
      setInviteActionError(null)
      try {
        const res = await fetch(`/api/v1/instance/invites/${encodeURIComponent(id)}`, { method: "DELETE" })
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null
          setInviteActionError(body?.error ?? "Couldn't delete that invite. Try again.")
          return
        }
        await load()
      } catch (err) {
        setInviteActionError(failureMessage(err))
      } finally {
        setRevokingInviteId(null)
      }
    },
    [load],
  )

  const dismissReveal = useCallback(() => {
    setRevealed(null)
  }, [])

  return (
    <SettingsSection
      frame="bare"
      title="Members"
      description="People who can sign in to this viewer."
      /* Always visible, on both tabs (Mo, 2026-08-31): adding a member is
         the section's one create action, and "Add member" names the OUTCOME
         even though the mechanism is an invite — the new row lands on the
         Invites tab until the link is used. */
      action={
        <Button
          variant="outline"
          size="sm"
          onClick={() => setInviteOpen(true)}
          data-testid="invite-open"
        >
          <Plus data-icon="inline-start" />
          Add member
        </Button>
      }
    >
      {/* Two tabs, full width like the Add-project dialog's (Mo,
          2026-08-31): members and invites are two lists with two different
          row shapes, and stacking them made one long page with a rule in
          the middle. */}
      <Tabs value={tab} onValueChange={(v) => setTab(v as "members" | "invites")}>
        <TabsList>
          <TabsTrigger value="members">Members</TabsTrigger>
          <TabsTrigger value="invites">Invites</TabsTrigger>
        </TabsList>
        <TabsContent value="members" className="flex flex-col gap-3 pt-2">

      {loadError && members === null ? (
        <LoadFailure size="sm" title="Couldn't load members" description={loadError} />
      ) : members === null ? (
        <ProjectLoader size={80} label="Loading" className="py-6" />
      ) : members.filter((m) => m.status === "active").length === 0 ? (
        <EmptyState size="sm" title="No members" description="Invited people show up here once they sign in." />
      ) : (
        /* One grid template shared by every row, with FIXED widths for the
           trailing columns (Mo, 2026-08-31: "align the data vertically") —
           fr columns resolve identically across same-width rows, and fixed
           action columns keep a row whose control is absent (your own row
           has no sign-in link) from shifting its neighbours. */
        <ul className="flex flex-col gap-0.5">
          {members
            /* Removed members simply disappear (Mo, 2026-08-31) — no
               Removed status, no Restore. The server keeps the rows as an
               audit trail; this list is about who can sign in NOW. */
            .filter((m) => m.status === "active")
            .map((m) => {
              const rowBusy = updatingUserId === m.userId
              return (
                <li key={m.userId}>
                  {/* asChild → a div, not ListRow's default <button>: the row
                      contains a Select and a Button, and nesting interactive
                      elements inside a button is a React hydration error — same
                      fix as project-access.tsx and tokens-panel.tsx. */}
                  <ListRow asChild density="dense" className="py-1.5">
                    <div className="group grid w-full grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_6.5rem_5.5rem_1.75rem] items-center gap-2">
                      <span className="flex min-w-0 items-center gap-2">
                        <Avatar size="sm">
                          <AvatarImage src={m.avatarUrl} alt="" />
                          <AvatarFallback>{avatarInitial(m.displayName)}</AvatarFallback>
                        </Avatar>
                        <span className="min-w-0 truncate">{m.displayName}</span>
                      </span>
                      <span className="min-w-0 truncate text-xs text-muted-foreground">{m.email}</span>
                      <Select
                        value={m.role}
                        disabled={rowBusy}
                        onValueChange={(v) => void handleRoleChange(m.userId, v as InstanceRole)}
                      >
                        <SelectTrigger size="sm" variant="ghost" className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="admin">Admin</SelectItem>
                          <SelectItem value="editor">Editor</SelectItem>
                          <SelectItem value="viewer">Viewer</SelectItem>
                        </SelectContent>
                      </Select>
                      {/* X3: a caller can't mint a sign-in link for their OWN
                          row — they're already signed in, and the copy below
                          names a DIFFERENT person to send it to. The column
                          stays (a spacer span) so the row's remaining
                          controls keep their vertical line. */}
                      {m.userId !== currentUserId ? (
                        <Button
                          variant="ghost"
                          size="xs"
                          aria-label={`Sign-in link for ${m.displayName}`}
                          disabled={rowBusy || mintingSignInLinkUserId === m.userId}
                          onClick={() => void handleMintSignInLink(m.userId, m.displayName)}
                        >
                          {mintingSignInLinkUserId === m.userId ? "Minting…" : "Sign-in link"}
                        </Button>
                      ) : (
                        <span />
                      )}
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        className="justify-self-end opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
                        aria-label={`Remove ${m.displayName}`}
                        disabled={rowBusy}
                        onClick={() => void handleRemove(m.userId)}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  </ListRow>
                </li>
              )
            })}
        </ul>
      )}

      {/* Error banners, not bare red text (Mo, 2026-08-31, on the
          last-admin 409): these surface a refused action on a panel that is
          about something else, which is exactly the Callout case. */}
      {actionError ? <Callout tone="destructive">{actionError}</Callout> : null}
      {signInLinkError ? <Callout tone="destructive">{signInLinkError}</Callout> : null}
      {loadError && members !== null ? <Callout tone="destructive">{loadError}</Callout> : null}
        </TabsContent>
        <TabsContent value="invites" className="flex flex-col gap-3 pt-2">
          {invites === null ? (
            <ProjectLoader size={80} label="Loading" className="py-6" />
          ) : invites.length === 0 ? (
            <EmptyState
              size="sm"
              title="No invites"
              /* Not "invite someone above" — the form moved into a dialog, so
                 "above" named a field that is not on screen. */
              description="An invite lets someone join without being added by hand."
            >
              <Button variant="outline" size="sm" onClick={() => setInviteOpen(true)}>
                <Plus data-icon="inline-start" />
                Add member
              </Button>
            </EmptyState>
          ) : (
            /* Same shared-template alignment as the member rows. */
            <ul className="flex flex-col gap-0.5">
              {invites.map((invite) => (
                <li key={invite.id}>
                  <ListRow asChild density="dense" className="py-1.5">
                    <div className="group grid w-full grid-cols-[minmax(0,1fr)_4rem_5rem_auto_1.75rem] items-center gap-2">
                      <span className="min-w-0 truncate">{invite.email}</span>
                      <Badge variant="outline" className="justify-self-start">
                        {invite.role}
                      </Badge>
                      <Badge variant="outline" className="justify-self-start">
                        {INVITE_STATE_LABEL[invite.state]}
                      </Badge>
                      <Button
                        variant="ghost"
                        size="xs"
                        disabled={regeneratingId === invite.id}
                        onClick={() => void handleRegenerate(invite.id, invite.email)}
                      >
                        Resend invitation
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        className="justify-self-end opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
                        aria-label={`Delete invite for ${invite.email}`}
                        disabled={revokingInviteId === invite.id}
                        onClick={() => void handleRevokeInvite(invite.id)}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  </ListRow>
                </li>
              ))}
            </ul>
          )}
          {inviteActionError ? <Callout tone="destructive">{inviteActionError}</Callout> : null}
        </TabsContent>
      </Tabs>

      <InviteDialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        onCreated={(next) => {
          setRevealed(next)
          // The reveal is a modal, but the fresh row lands on the Invites
          // tab — switch there so closing the reveal shows the row it made,
          // whichever tab Add member was clicked from.
          setTab("invites")
        }}
        onReload={load}
      />

      {/* The one-time link reveals, as modals rather than banners (Mo,
          2026-08-31). Both re-mint cheaply (Resend invitation / Sign-in
          link), so an accidental dismiss loses nothing permanent. */}
      {/* Titles name the THING and its recipient, not the action (Mo,
          2026-08-31: "state what it is and who to send it to and why"). */}
      {revealed ? (
        <OneTimeLinkDialog
          title={
            revealed.emailed
              ? `Invite emailed to ${revealed.email}`
              : `Invite link for ${revealed.email}`
          }
          description={
            revealed.emailed
              ? `You can also copy and send the link privately to ${revealed.email}. It will not be shown again.`
              : "Send it to them so they can join this viewer. Anyone who opens it becomes their account, so share it privately. It will not be shown again."
          }
          url={revealed.url}
          onClose={dismissReveal}
        />
      ) : null}
      {signInLinkRevealed ? (
        <OneTimeLinkDialog
          title={`Sign-in link for ${signInLinkRevealed.name}`}
          description={`Send it to them privately: anyone who opens it signs in as ${signInLinkRevealed.name}. ${SIGN_IN_LINK_EXPIRES_COPY} It will not be shown again.`}
          url={signInLinkRevealed.url}
          onClose={dismissSignInLinkReveal}
        />
      ) : null}
    </SettingsSection>
  )
}

/**
 * Creating an invite, on its own.
 *
 * It was a `Field` between the member list and the invites list — an input, a
 * role select and a submit sitting in the middle of a panel whose job is to
 * show who is already here (Mo, 2026-08-28). Same split as the project
 * access list: the panel lists, the dialog acts.
 *
 * The dialog does NOT own the revealed link. Creating an invite returns a URL
 * the admin has to copy, and that has to survive this dialog closing — so the
 * result is handed up and the panel reveals it, where it stays put and can be
 * copied. A link shown inside the surface that created it would vanish with
 * the first Esc.
 */
function InviteDialog({
  open,
  onOpenChange,
  onCreated,
  onReload,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (revealed: RevealedInvite) => void
  onReload: () => Promise<void>
}) {
  const [email, setEmail] = useState("")
  const [role, setRole] = useState<InstanceRole>("viewer")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const close = useCallback(() => {
    onOpenChange(false)
    setEmail("")
    setError(null)
  }, [onOpenChange])

  const handleCreate = useCallback(async () => {
    const value = email.trim().toLowerCase()
    if (!value || busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch("/api/v1/instance/invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: value, role }),
      })
      const body = (await res.json().catch(() => null)) as
        | { url?: unknown; emailed?: unknown; error?: string }
        | null
      if (!res.ok) {
        setError(body?.error ?? "Couldn't create that invite. Try again.")
        return
      }
      if (!body || typeof body.url !== "string") {
        setError("Server returned an unexpected response.")
        return
      }
      onCreated({ email: value, url: body.url, emailed: body.emailed === true })
      await onReload()
      close()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [email, role, busy, onCreated, onReload, close])

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      {/* No `X` while the invite is in flight. Mo, 2026-08-28. */}
      <DialogContent size="md" showCloseButton={!busy} data-testid="invite-dialog">
        <DialogHeader>
          <DialogTitle>Add member</DialogTitle>
          <DialogDescription>
            They get a link that signs them in and joins them to this viewer at the role you pick.
          </DialogDescription>
        </DialogHeader>

        <Field label="Email" htmlFor="invite-email">
          <Input
            id="invite-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                void handleCreate()
              }
            }}
            placeholder="name@example.com"
            autoFocus
          />
          {error ? (
            <span role="status" className="text-xs text-destructive">
              {error}
            </span>
          ) : null}
        </Field>

        <Field label="Role" htmlFor="invite-role">
          <Select value={role} onValueChange={(v) => setRole(v as InstanceRole)}>
            <SelectTrigger id="invite-role" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="admin">Admin</SelectItem>
              <SelectItem value="editor">Editor</SelectItem>
              <SelectItem value="viewer">Viewer</SelectItem>
            </SelectContent>
          </Select>
        </Field>

        <DialogFooter>
          <Button variant="outline" onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={() => void handleCreate()}
            disabled={!email.trim() || busy}
            busy={busy}
            data-testid="invite-submit"
          >
            Create invite
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * A freshly minted one-time URL, shown once, in a modal (Mo, 2026-08-31 —
 * previously an inline banner at the top of the tab, which was easy to miss
 * and pushed the list down). The plaintext exists only in this dialog: the
 * server stores a hash, so closing it means re-minting, not re-reading.
 * Dismissing by overlay/Esc is allowed because every caller can re-mint.
 */
function OneTimeLinkDialog({
  title,
  description,
  url,
  onClose,
}: {
  title: string
  description: string
  url: string
  onClose: () => void
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent size="md" data-testid="one-time-link-dialog">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-1.5">
          <Input readOnly value={url} className="flex-1" onFocus={(e) => e.currentTarget.select()} />
          <CopyButton value={url} />
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
