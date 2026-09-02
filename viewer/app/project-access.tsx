"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { Plus, Trash2, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DialogFooter } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import {
  EmptyState,
  Field,
  ListRow,
  OptionCard,
  OptionCardGroup,
  ProjectLoader,
} from "@/components/blocks"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { LoadFailure } from "./load-failure"
import { failureMessage } from "./api-client"
import {
  ACCESS_DESCRIPTIONS,
  ACCESS_LABELS,
  PUBLIC_LINKS_DISABLED_REASON,
  accessSummary,
  type ProjectAccessValue,
} from "./project-access-copy"

/**
 * Minimal local shape of the server's member-view (`server/api/members-routes.ts`'s
 * `MemberView`) — declared here rather than imported, same reasoning as
 * `use-participants.ts`'s `ReviewParticipant`: server-only code isn't reachable
 * from app code via the `@/*` alias, so this component only ever needs the
 * wire shape `GET /api/v1/projects/:id/members` returns.
 *
 * `email` is OPTIONAL: the server omits it entirely — never sends `""` — for
 * a caller who isn't themselves a member/admin of the project, since it's a
 * verified account identity, not a self-declared display string. Render
 * gracefully when it's absent rather than assuming every row has one.
 *
 * There is no `role` on a row — an access-list entry decides readability of
 * an `invited` project, nothing else. See `ProjectAccessProps.canManage`.
 */
export interface ProjectMemberView {
  userId: string
  createdAt: string
  email?: string
  displayName: string
  avatarUrl: string
}

function isProjectMemberView(v: unknown): v is ProjectMemberView {
  if (typeof v !== "object" || v === null) return false
  const m = v as Record<string, unknown>
  return (
    typeof m.userId === "string" &&
    (m.email === undefined || typeof m.email === "string") &&
    typeof m.displayName === "string"
  )
}

/**
 * Re-exported so existing importers (`review-shell.tsx`, the gallery fixture)
 * keep working — the type, the labels and the sentences now live in
 * `project-access-copy.ts`, which is plain `.ts` so a badge or a card can use
 * them without importing this dialog. See that file for why the "invited"
 * wording was consolidated to one sentence.
 */
export type { ProjectAccessValue }

export interface ProjectAccessProps {
  projectId: string
  access: ProjectAccessValue
  /** The instance-wide public-link kill switch — omits the "Public link" option entirely when off. */
  publicLinksEnabled: boolean
  /**
   * May this caller change access and manage the invite list — the
   * caller's INSTANCE role (`admin`/`editor`), mirroring the server's
   * `hasProjectManageAuthority` (`server/auth/authorize.ts`). A `viewer`
   * gets a read-only sentence instead of the picker; the server enforces
   * this independently (`PATCH`/`POST`/`DELETE` all route through
   * `requireProjectManage`), so this is a UX courtesy, not the real gate.
   */
  canManage: boolean
  /** True until the caller's role has resolved — avoids flashing the read-only sentence before it's known. */
  currentUserLoading: boolean
  /**
   * Whether the Dialog hosting this panel is currently open. Used only to
   * discard an abandoned pending selection the moment the dialog is
   * reopened (see the effect below) — deliberately not left to depend on
   * whether Radix happens to unmount this component between opens.
   */
  open: boolean
  /** Called after a successful access change, with the new value. */
  onAccessChange?: (access: ProjectAccessValue) => void
  /**
   * Closes the dialog hosting this panel. With nothing pending, the footer's
   * Cancel falls through to this — otherwise a reader who opened the dialog
   * just to look has no way out except the header X (Mo, 2026-08-29: every
   * modal footer carries a working close or cancel).
   */
  onClose?: () => void
  className?: string
}

/**
 * The access dialog (viewer-membership Task 12) — replaces the old
 * membership-only panel. A three-option choice (all members / invited only /
 * public link).
 *
 * **Select, then commit — `OptionCard`'s actual contract**
 * (`src/components/blocks/option-card.tsx`): a card SELECTS into local
 * state, a footer button COMMITS. `ChoiceTile` is the block that commits on
 * click; `OptionCard` deliberately looks different so a click never carries
 * more weight than the user can see. The first version of this dialog wired
 * `OptionCardGroup.onValueChange` straight to the `PATCH` — making a project
 * world-readable was one click away with no confirmation, which is exactly
 * the ambiguity the two blocks exist to keep apart. Fixed: picking a card
 * only updates `pendingAccess`; the `DialogFooter`'s Save button
 * performs the `PATCH`, disabled until `pendingAccess` differs from the
 * saved `access`. A failed save keeps the pending pick on screen (with the
 * server's error) so the user can retry or explicitly Cancel — it does NOT
 * roll back on its own, unlike a live toggle such as `InstanceSettingsPanel`'s
 * switch, because there is no "back" to silently return to here: the whole
 * point is that the choice hasn't taken effect yet.
 *
 * Selecting "Invited only" reveals the access list below (rows + add-by-email
 * field) even before Save is clicked — building the roster ahead of
 * flipping the switch is normal, and the server places no restriction on
 * managing a project's access list regardless of its current `access`. List
 * operations (add/remove a person) commit immediately, unlike the access
 * value itself — they're independent of what's pending in the picker.
 *
 * **The access list's DATA is owned here, not in `AccessList`** (Fix wave M2
 * review). `AccessList` used to hold its own `members` state and fetch on
 * mount — and it is mounted only while `pendingAccess === "invited"`, so
 * clicking between the three cards before saving unmounted and remounted it,
 * re-fetching `GET /members` on every toggle. Lifting the state up means the
 * list is loaded once per dialog opening and survives the picker being moved
 * around; `AccessList` is now a presentational component over what it is
 * given, plus the two mutations, which re-load through the same callback.
 */
export function ProjectAccess({
  projectId,
  access,
  publicLinksEnabled,
  canManage,
  currentUserLoading,
  open,
  onAccessChange,
  onClose,
  className,
}: ProjectAccessProps) {
  // The user's in-progress pick — may differ from `access` (the last SAVED
  // value) until Save commits it. Reset whenever the dialog is
  // (re)opened, or whenever `access` itself changes while open (another tab,
  // another admin) — either way an abandoned pending pick must never survive
  // to be seen again.
  const [pendingAccess, setPendingAccess] = useState<ProjectAccessValue>(access)
  const [savingAccess, setSavingAccess] = useState(false)
  /**
   * Whether the picker is open, as opposed to the current value being read
   * back (Mo, 2026-08-29: "show the value, with description, with an edit
   * button to the right").
   *
   * Access is read far more often than it is changed — the dialog also
   * carries the roster, which is the reason to open it most days — so the
   * resting state answers "what is it" and the picker is what you ask for.
   */
  const [editingAccess, setEditingAccess] = useState(false)
  const [accessError, setAccessError] = useState<string | null>(null)

  useEffect(() => {
    if (open) setPendingAccess(access)
  }, [open, access])

  // ---- the access list's data, owned here (see the doc comment above) ----

  const [members, setMembers] = useState<ProjectMemberView[] | null>(null)
  const [membersError, setMembersError] = useState<string | null>(null)
  /**
   * Email rows typed but not yet committed (Mo, 2026-08-29: "multiple users
   * could be added by clicking the add member button to add a new input, the
   * save button for the modal would add all the users").
   *
   * They live UP HERE, not in `AccessList`, because the footer's Save is what
   * sends them and a button cannot commit state it cannot see. `AccessList`
   * renders and edits them through props.
   *
   * Keyed by a counter rather than by array index: a row removed from the
   * middle would otherwise hand its index to its neighbour, and React would
   * keep the wrong input's DOM node — which is how a half-typed email jumps
   * rows.
   */
  const [drafts, setDrafts] = useState<AccessDraft[]>([])
  const nextDraftId = useRef(0)

  const loadMembers = useCallback(async () => {
    try {
      const res = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/members`)
      if (!res.ok) throw new Error(`GET members ${res.status}`)
      const data = (await res.json()) as { members?: unknown }
      const list = Array.isArray(data.members) ? data.members.filter(isProjectMemberView) : []
      setMembers(list)
      setMembersError(null)
    } catch (err) {
      setMembersError(failureMessage(err))
    }
  }, [projectId])

  /**
   * The project the list has already been requested for during THIS opening of
   * the dialog, or `null`. A ref rather than state because it must not itself
   * cause a render — it only decides whether the effect below has work to do.
   */
  const listRequestedFor = useRef<string | null>(null)

  useEffect(() => {
    if (!open) {
      // Closed: forget that we loaded, so the next opening re-reads the
      // roster instead of trusting a snapshot of unknown age. (In production
      // this is belt-and-braces — Radix unmounts `DialogContent` on close, so
      // the whole component starts over anyway. It matters for any caller
      // that keeps this mounted and merely hides it.)
      listRequestedFor.current = null
      return
    }
    // Deferred until "Invited only" is actually the pending pick — the list is
    // meaningless for the other two values, so a dialog opened on
    // "All members" makes no request at all. Once loaded it STAYS loaded:
    // this is the whole point of owning the state up here, so toggling
    // between the cards never re-fetches.
    if (!canManage || pendingAccess !== "invited") return
    if (listRequestedFor.current === projectId) return
    listRequestedFor.current = projectId
    void loadMembers()
  }, [open, canManage, pendingAccess, projectId, loadMembers])

  const addDraft = useCallback(() => {
    setDrafts((prev) => [...prev, { id: nextDraftId.current++, email: "" }])
  }, [])

  const changeDraft = useCallback((id: number, email: string) => {
    // Editing clears that row's error. A message about the address as it was
    // a moment ago reads as a verdict on the one being typed now.
    setDrafts((prev) =>
      prev.map((d) => (d.id === id ? { id: d.id, email } : d)),
    )
  }, [])

  const removeDraft = useCallback((id: number) => {
    setDrafts((prev) => prev.filter((d) => d.id !== id))
  }, [])

  const handleSelect = useCallback((next: ProjectAccessValue) => {
    setPendingAccess(next)
    // A stale error about a DIFFERENT pending value reads as still applying
    // to this new one — clear it the moment the pick changes again.
    setAccessError(null)
    // Drafts go with the roster. `AccessList` only renders under "invited",
    // so leaving them behind would let Save post addresses that are no
    // longer on screen — work the user cannot see, cancel or correct.
    if (next !== "invited") setDrafts([])
  }, [])

  const handleCancelPending = useCallback(() => {
    setPendingAccess(access)
    setAccessError(null)
    setDrafts([])
    // Cancel closes the picker too: it undoes the whole act of changing
    // access, and leaving the control open over a value it no longer differs
    // from is a form still asking a question that has been answered.
    setEditingAccess(false)
  }, [access])

  /**
   * Commits everything the dialog is holding: the access change, then every
   * typed email row.
   *
   * ## Order matters, and it is access first
   *
   * Adding people to a project that is still "All members" would be adding
   * them to a list nobody reads. The access change is also the one that can
   * be refused for a reason the additions depend on, so if it fails there is
   * nothing sensible to do with the rows and this returns before touching
   * them.
   *
   * ## Partial failure keeps what failed
   *
   * The rows are posted one at a time and the ones that succeed are dropped
   * from the draft list, so a retry never re-adds an address that already
   * landed. Whatever failed stays on screen with its own message, which is
   * the only state a person can act on: clearing everything would lose the
   * typing, and keeping everything would make the retry double-post.
   *
   * `onAccessChange` fires ONLY when the access value actually changed. It
   * reloads the whole review page (the iframe has to be re-minted under the
   * new policy), and doing that for an added member would throw away the
   * roster the user is still looking at.
   */
  const handleSave = useCallback(async () => {
    if (savingAccess) return
    const pendingDrafts = drafts.filter((d) => d.email.trim())
    const accessChanged = pendingAccess !== access
    if (!accessChanged && pendingDrafts.length === 0) return

    setSavingAccess(true)
    setAccessError(null)
    try {
      if (accessChanged) {
        const res = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ access: pendingAccess }),
        })
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null
          setAccessError(body?.error ?? "Couldn't change access. Try again.")
          // Deliberately NOT rolling `pendingAccess` back — the pick is still
          // what the user wants; retrying or cancelling is their call, not
          // something this failure should make for them.
          return
        }
      }

      const failed: { id: number; email: string; reason: string }[] = []
      for (const draft of pendingDrafts) {
        const email = draft.email.trim()
        try {
          const res = await fetch(
            `/api/v1/projects/${encodeURIComponent(projectId)}/members`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ email }),
            },
          )
          if (!res.ok) {
            const body = (await res.json().catch(() => null)) as { error?: string } | null
            failed.push({ ...draft, reason: body?.error ?? "Couldn't add this person." })
          }
        } catch (err) {
          failed.push({ ...draft, reason: failureMessage(err) })
        }
      }

      // Only the rows that failed survive, each carrying its own reason.
      setDrafts((prev) =>
        prev
          .filter((d) => !d.email.trim() || failed.some((f) => f.id === d.id))
          .map((d) => {
            const failure = failed.find((f) => f.id === d.id)
            return failure ? { ...d, error: failure.reason } : d
          }),
      )

      if (pendingDrafts.length > failed.length) await loadMembers()
      if (failed.length > 0) return
      if (accessChanged) onAccessChange?.(pendingAccess)
    } catch (err) {
      setAccessError(failureMessage(err))
    } finally {
      setSavingAccess(false)
    }
  }, [projectId, pendingAccess, access, savingAccess, drafts, onAccessChange, loadMembers])

  if (currentUserLoading) {
    return <ProjectLoader size={80} label="Loading" className={cn("py-6", className)} />
  }


  // Save is live when EITHER the access differs or there is an email typed.
  // An empty row is not pending work: clicking Add and changing your mind
  // should not arm a Save that would do nothing.
  const hasPendingChange =
    pendingAccess !== access || drafts.some((d) => d.email.trim().length > 0)

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      {/*
        Two screens in one dialog, not one screen that rearranges (Mo,
        2026-08-29: "it isn't the same modal content that is changing, it is
        showing different modal content").

        READING is the default, because it is the commoner visit: this dialog
        also carries the roster, and most openings are to see or prune that
        rather than to change the access level. So it shows the value, what it
        means, and an Edit button.

        EDITING replaces the whole body with the three radio cards — the
        roster included. Two reasons it goes:

        - The cards are a decision about what the roster IS FOR. Leaving a
          list of names under "All members" while the reader considers picking
          it shows them a thing that would stop mattering the moment they did.
        - `pendingAccess` drives which options are even coherent, and the
          roster is scoped to `"invited"`. Rendering both meant the list
          appearing and vanishing as the pick moved, which is the "same
          content changing" this replaces.

        The cards are the ones this dialog had before 2026-08-29, restored
        rather than reinvented. A segmented control stood here for part of a
        day and was the wrong reading of "instead of a segmented button": that
        was about the CONTROL, not only about when it shows.
      */}
      {editingAccess ? (
        <OptionCardGroup
          value={pendingAccess}
          onValueChange={(v) => handleSelect(v as ProjectAccessValue)}
          aria-label="Project access"
        >
          {/* Titles and hints come from `project-access-copy.ts`, so the
              picker, the read-only sentence and both badges' tooltips cannot
              describe the same state differently — which they had already
              started to do (see that file's header). */}
          <OptionCard
            value="all-members"
            title={ACCESS_LABELS["all-members"]}
            hint={ACCESS_DESCRIPTIONS["all-members"]}
            disabled={savingAccess}
            data-testid="access-option-all-members"
          />
          <OptionCard
            value="invited"
            title={ACCESS_LABELS.invited}
            hint={ACCESS_DESCRIPTIONS.invited}
            disabled={savingAccess}
            data-testid="access-option-invited"
          />
          {/*
            Shown but DISABLED when the instance-wide kill switch is off, with
            its hint replaced by the reason (Mo, 2026-08-29). It used to be
            omitted entirely, which is the same mistake in a quieter form: the
            reader could not tell whether public links did not exist, were not
            allowed here, or were simply missing from a list.

            The `disabled` hint is what `OptionCard` documents the prop for —
            "also where a disabled option explains itself" — so the reason
            lands on the option, before a click is spent on it, rather than as
            a 409 after Save. docs/design.md, "Disable what cannot be done,
            and say why".

            The 409 path stays as the fallback it should always have been: the
            switch can be turned off between this render and the PATCH, and
            only the server knows that.
          */}
          <OptionCard
            value="public-link"
            title={ACCESS_LABELS["public-link"]}
            hint={publicLinksEnabled ? ACCESS_DESCRIPTIONS["public-link"] : PUBLIC_LINKS_DISABLED_REASON}
            disabled={savingAccess || !publicLinksEnabled}
            data-testid="access-option-public-link"
          />
        </OptionCardGroup>
      ) : (
        /*
          The value and its description as one tight pair, with Edit to the
          right (Mo, 2026-08-29: "make the title and description a lot
          closer", then "remove the border around it, I just wanted the
          description closer").

          They are one statement — a name and what it means — so they stack at
          `gap-0.5` in their own column. No border: the closeness is what
          groups them, and a box around two lines of text in a dialog that is
          itself a box was chrome for its own sake.
        */
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <p className="text-base font-medium" data-testid="access-current">
              {ACCESS_LABELS[pendingAccess]}
            </p>
            <p className="text-sm text-muted-foreground">{ACCESS_DESCRIPTIONS[pendingAccess]}</p>
          </div>
          {/*
            Disabled with the reason on hover, rather than absent (Mo,
            2026-08-29: "are we disabling the edit button... if not, we should
            with a hover message as to why").

            A `viewer` used to get a different screen entirely — one sentence
            from `accessSummary` and no roster, no control, no explanation.
            That hid the capability instead of refusing it: the reader could
            not tell whether access was unchangeable, changed elsewhere, or
            theirs to change and simply missing. docs/design.md prefers the
            disabled control with its reason in a tooltip for exactly this,
            and the server refuses independently
            (`requireProjectManage`), so nothing here is the real gate.

            The `<span>` wrapper is what makes the tooltip fire at all: a
            disabled button swallows pointer events, so the trigger has to sit
            on something enabled around it. Same construction as the Editor's
            `undo-redo-controls.tsx`.
          */}
          {/*
            Its own `TooltipProvider`, not one at the app root.

            `Tooltip` is a bare Radix `Root` and throws without a provider
            ancestor. A root-level one covers the app and NOTHING else: this
            component is also rendered by the surface gallery, which has its
            own shell, and directly by three test files. All of those threw.
            Wrapping here makes the component work wherever it is mounted,
            which is the property that matters for something the gallery
            renders in isolation.

            Nesting inside a future root provider is harmless, and the delay
            tuning survives because this is the repo's own `TooltipProvider`
            (500ms, see its doc) rather than Radix's.
          */}
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="flex-none">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!canManage}
                    onClick={() => setEditingAccess(true)}
                    data-testid="access-edit"
                  >
                    Edit
                  </Button>
                </span>
              </TooltipTrigger>
              {!canManage ? (
                <TooltipContent>Changing access needs the Editor or Admin role.</TooltipContent>
              ) : null}
            </Tooltip>
          </TooltipProvider>
        </div>
      )}

      {!publicLinksEnabled && access === "public-link" ? (
        <p className="text-xs text-muted-foreground">{accessSummary(access, publicLinksEnabled)}</p>
      ) : null}

      {accessError ? <p className="text-xs text-destructive">{accessError}</p> : null}

      {/*
        Reading screen only (see the two-screens note above), and managers
        only.

        `canManage` gates the roster because every control in it is a
        management action: Remove on each row, and Add member under them.
        Before the disabled-Edit change a `viewer` never reached this code at
        all — the whole panel returned a sentence early — and dropping that
        early return without this gate handed them a list of Remove buttons
        and an Add form the server would refuse. The reason lives on the Edit
        button's tooltip; it does not need repeating on eight controls.
      */}
      {canManage && !editingAccess && pendingAccess === "invited" ? (
        <AccessList
          projectId={projectId}
          members={members}
          loadError={membersError}
          onLoadError={setMembersError}
          onReload={loadMembers}
          drafts={drafts}
          onAddDraft={addDraft}
          onChangeDraft={changeDraft}
          onRemoveDraft={removeDraft}
          saving={savingAccess}
          /* No rule above the roster (Mo, 2026-08-29). The panel's own
             `gap-3` already separates it from the access statement, and the
             line was a second answer to the same question. */
          className="pt-1"
        />
      ) : null}

      <DialogFooter>
        {/*
          Two jobs, one way out. With something to back out of (a pending
          change, or the editor being open), Cancel backs out of it and stays.
          With nothing pending it closes the dialog — gating it on
          `hasPendingChange` alone was a dead end once: open Edit, change your
          mind, and the only control that returns to the reading screen was
          disabled. Caught driving it in the gallery. And a reader who opened
          the dialog just to look must not be left with only the header X
          (Mo, 2026-08-29).
        */}
        <Button
          variant="outline"
          onClick={() => {
            if (hasPendingChange || editingAccess) handleCancelPending()
            else onClose?.()
          }}
          disabled={savingAccess || (!hasPendingChange && !editingAccess && !onClose)}
          data-testid="access-cancel"
        >
          Cancel
        </Button>
        <Button
          onClick={() => void handleSave()}
          disabled={savingAccess || !hasPendingChange}
          data-testid="access-save"
        >
          {/* "Save", not "Save access" (Mo, 2026-08-29). The dialog is
              titled "Access: <name>" and the control it commits is directly
              above; repeating the noun on the button says nothing the surface
              has not already said. See docs/design.md, "Don't repeat the
              noun the surface already carries". */}
          {savingAccess ? "Saving" : "Save"}
        </Button>
      </DialogFooter>
    </div>
  )
}

/** One not-yet-committed email row in the access dialog. */
export interface AccessDraft {
  id: number
  email: string
  /** Why this row failed on the last Save. Cleared when the row is edited. */
  error?: string
}

interface AccessListProps {
  projectId: string
  /** `null` while the list is still loading — the parent owns the fetch. */
  members: ProjectMemberView[] | null
  /** A load OR removal failure, owned by the parent so it survives a picker toggle. */
  loadError: string | null
  /** Reports a removal failure back up. */
  onLoadError: (message: string | null) => void
  /** Re-reads the list after a successful add or remove. */
  onReload: () => Promise<void>
  /**
   * Email rows typed but not committed. Owned by the parent because the
   * dialog's Save is what sends them — see its `drafts` state.
   */
  drafts: AccessDraft[]
  onAddDraft: () => void
  onChangeDraft: (id: number, email: string) => void
  onRemoveDraft: (id: number) => void
  /** True while the dialog's Save is in flight, which freezes the rows. */
  saving: boolean
  className?: string
}

/**
 * The invite-by-email access list, shown only while the pending pick is
 * `"invited"`. Readable by anyone who can read the project (same gate as `GET
 * /api/v1/projects/:id/members`), but this component is only ever mounted from
 * the `canManage` branch above — a `viewer` sees the plain summary sentence
 * instead, never this list.
 *
 * Holds no list DATA of its own (Fix wave M2 review): `members`, its load
 * error, and the reload callback all come from `ProjectAccess`, because this
 * component unmounts every time the user clicks a different card and a
 * fetch-on-mount here meant one `GET /members` per click. What it does still
 * own is the transient state of its own two controls — the invite draft, and
 * which row is mid-removal — which are meaningless once it is off screen.
 */
function AccessList({
  projectId,
  members,
  loadError,
  onLoadError,
  onReload,
  drafts,
  onAddDraft,
  onChangeDraft,
  onRemoveDraft,
  saving,
  className,
}: AccessListProps) {
  const [removingUserId, setRemovingUserId] = useState<string | null>(null)

  const handleRemove = useCallback(
    async (userId: string) => {
      setRemovingUserId(userId)
      onLoadError(null)
      try {
        const res = await fetch(
          `/api/v1/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(userId)}`,
          { method: "DELETE" },
        )
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null
          onLoadError(body?.error ?? "Couldn't remove that person. Try again.")
          return
        }
        await onReload()
      } catch (err) {
        onLoadError(failureMessage(err))
      } finally {
        setRemovingUserId(null)
      }
    },
    [projectId, onReload, onLoadError],
  )

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      {loadError && members === null ? (
        <LoadFailure size="sm" title="Couldn't load the access list" description={loadError} />
      ) : members === null ? (
        <ProjectLoader size={80} label="Loading" className="py-6" />
      ) : members.length === 0 ? (
        <EmptyState
          size="sm"
          title="No one added"
          /* Not "add someone below" any more — adding moved into its own
             dialog, so "below" named a field that is not there. */
          description="Only people added here can open this project."
        />
      ) : (
        <ul className="flex flex-col gap-0.5">
          {members.map((m) => (
            <li key={m.userId}>
              {/* asChild → a div, not ListRow's default <button>: a row
                  contains a Remove button, and a button inside a button is a
                  React hydration error that also collapses the row into one
                  control in the accessibility tree. */}
              <ListRow asChild density="dense">
                <div className="group flex items-center justify-between gap-2">
                  <span className="min-w-0 flex-1 truncate">{m.displayName}</span>
                  {m.email ? (
                    <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{m.email}</span>
                  ) : null}
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
                    aria-label={`Remove ${m.displayName}`}
                    disabled={removingUserId === m.userId}
                    onClick={() => void handleRemove(m.userId)}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              </ListRow>
            </li>
          ))}
        </ul>
      )}

      {loadError && members !== null ? <p className="text-xs text-destructive">{loadError}</p> : null}

      {/*
        Draft rows, and a button that adds another (Mo, 2026-08-29: "multiple
        users could be added by clicking the add member button to add a new
        input, the save button for the modal would add all the users").

        Two reversals landed here in two days, and both were right at the
        time. 2026-08-28 moved adding into its own `AddPersonDialog` because
        "the list LISTS" and a live compose box made this panel read as a
        form; 2026-08-29 brought it back in place, because a whole dialog on
        top of a dialog to type one email cost more than it saved. This is
        the third shape and the first that matches how the work actually
        happens: you invite a handful of people at once, and one Save commits
        them along with the access change.

        The rows own nothing. `drafts` and every mutation live in the parent,
        because the footer's Save is what sends them, and a button cannot
        commit state it cannot see.

        Each row keeps its own `error` from the last Save, under its own
        field: a failure belongs to the address that caused it, and a shared
        banner would leave the reader matching messages to rows by hand. See
        docs/design.md on where an error goes.
      */}
      {drafts.map((draft, i) => {
        /*
          Only the FIRST row is labelled (Mo, 2026-08-29: "there is no need to
          repeat the email label below the first input"). One "Email" heads
          the group; repeating it down a stack of identical fields labels the
          obvious three times.

          The later rows keep the name for assistive tech through
          `aria-label`, because dropping the visible label must not drop the
          accessible one — a screen reader arriving at the third input would
          otherwise hear an unnamed text box.

          `Field` requires a `label`, so the unlabelled rows render the input
          directly rather than passing an empty string, which would have put a
          blank `<label>` in the tree and re-introduced the gap the label was
          taking up.
        */
        const labelled = i === 0
        const inputId = `access-invite-email-${draft.id}`
        const input = (
          <>
            <Input
              id={inputId}
              type="email"
              value={draft.email}
              onChange={(e) => onChangeDraft(draft.id, e.target.value)}
              placeholder="name@example.com"
              aria-label={labelled ? undefined : "Email"}
              /* Focus the row that was just added, not the first one: adding
                 a fourth row should put the cursor in the fourth. The initial
                 render has no rows at all, so this only ever fires on a row
                 the user asked for. */
              autoFocus={i === drafts.length - 1}
              disabled={saving}
              data-testid={`access-draft-${i}`}
            />
            {draft.error ? (
              <span role="status" className="text-xs text-destructive">
                {draft.error}
              </span>
            ) : null}
          </>
        )
        return (
          <div key={draft.id} className="flex items-start gap-2">
            {labelled ? (
              <Field label="Email" htmlFor={inputId} className="min-w-0 flex-1">
                {input}
              </Field>
            ) : (
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">{input}</div>
            )}
            {/* `mt-6` clears the `Field`'s label on the first row only; the
                unlabelled rows have nothing above the input to clear. */}
            <Button
              variant="ghost"
              size="icon-sm"
              className={cn("flex-none", labelled && "mt-6")}
              aria-label="Remove"
              title="Remove"
              onClick={() => onRemoveDraft(draft.id)}
              disabled={saving}
              data-testid={`access-draft-remove-${i}`}
            >
              <X />
            </Button>
          </div>
        )
      })}

      <Button
        variant="outline"
        size="sm"
        className="w-fit"
        onClick={onAddDraft}
        disabled={saving}
        data-testid="access-add-open"
      >
        <Plus data-icon="inline-start" />
        Add member
      </Button>
    </div>
  )
}
