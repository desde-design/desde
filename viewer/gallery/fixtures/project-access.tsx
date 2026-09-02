"use client"

import { useEffect, useState } from "react"
import { ProjectAccess, type ProjectAccessValue } from "../../app/project-access"
import { SAMPLE_MEMBERS, SAMPLE_PROJECT } from "../harness/fixture-data"
import { DialogFrame, Scenario } from "../harness/scenario"
import {
  clickLikeUser,
  runDrivenInteraction,
  setNativeValue,
  waitForElement,
} from "@/components/gallery/dom-interaction"
import { NETWORK_ERROR, PENDING, fail, ok, type FetchOverrideResult } from "@/components/gallery/fetch-override"
import type { SurfaceEntry, SurfaceRenderContext } from "@/components/gallery/types"

/**
 * The access dialog (viewer-membership Task 12, review-fixed) — replaces the
 * old `project-members` surface. Always mounted inside a Dialog by its one
 * real caller (`review-shell.tsx`, `DialogContent size="xl"`, title `Access:
 * {project.name}`) — the component itself renders no dialog chrome, so every
 * state below wraps it in `DialogFrame` to match production.
 *
 * **Select, then commit.** Clicking an `OptionCard` only updates the pending
 * pick — it does NOT `PATCH`. A `DialogFooter` "Save access" button (enabled
 * only once the pick differs from the saved value) performs the write; a
 * failed save keeps the pending pick and shows the server's error, rather
 * than rolling back, so the user can retry or explicitly Cancel. The first
 * version of this dialog wired the picker straight to the `PATCH` (one click
 * = world-readable, no confirmation) — see `project-access.tsx`'s own doc
 * comment for why that was wrong. `pending-change`, `access-change-saving`,
 * `access-change-error` and `access-change-409` below exercise the fixed
 * flow end to end.
 */

const MEMBERS_PATH = `/api/v1/projects/${SAMPLE_PROJECT.id}/members`
const MEMBERS_ROUTE = `GET ${MEMBERS_PATH}`
const POST_MEMBERS_ROUTE = `POST ${MEMBERS_PATH}`
const DELETE_MEMBER_ROUTE = `DELETE ${MEMBERS_PATH}`
const PATCH_PROJECT_ROUTE = `PATCH /api/v1/projects/${SAMPLE_PROJECT.id}`
const DIALOG_TITLE = `Access: ${SAMPLE_PROJECT.name}`
const NEW_MEMBER_EMAIL = "jordan@example.com"

interface PanelProps {
  access: ProjectAccessValue
  publicLinksEnabled?: boolean
  canManage?: boolean
  currentUserLoading?: boolean
  routes?: Record<string, FetchOverrideResult>
}

/** Every state below renders the panel the same way, varying only these inputs. */
function AccessPanel({
  access,
  publicLinksEnabled = true,
  canManage = true,
  currentUserLoading = false,
  routes = {},
}: PanelProps) {
  return (
    <Scenario routes={routes}>
      <ProjectAccess
        projectId={SAMPLE_PROJECT.id}
        access={access}
        publicLinksEnabled={publicLinksEnabled}
        canManage={canManage}
        currentUserLoading={currentUserLoading}
        // Every state's Dialog is pinned open (see `DialogFrame`), so this
        // is always true — it exists on the real component only to reset an
        // abandoned pending pick when the dialog is REOPENED, which no
        // static gallery state does.
        open
      />
    </Scenario>
  )
}

function DialogWrapped({ ctx, ...props }: PanelProps & { ctx: SurfaceRenderContext }) {
  return (
    <DialogFrame title={DIALOG_TITLE} size="xl" onOpenChange={(open) => ctx.log("onOpenChange", open)}>
      <AccessPanel {...props} />
    </DialogFrame>
  )
}

// ---- Access picker / Save-Cancel driving -------------------------------
//
// Every state below whose label starts "Editing" has clicked Edit to OPEN the
// picker. At rest the dialog shows the current value with an Edit button and
// no segmented control at all (2026-08-29) — worth saying here because four
// consecutive states showing the picker reads as "this surface has segmented
// buttons", which is what it looked like to Mo browsing the catalog.

/**
 * The Radix radio control behind one option card.
 *
 * `OptionCard` renders a `<label data-slot="option-card">` wrapping the
 * control, and the `data-testid` rides the LABEL while `disabled` rides the
 * control. Clicking the control directly, rather than the label, is what
 * reaches Radix's own handler reliably in this runtime — the note the
 * original driver carried, restored with the cards themselves on 2026-08-29
 * after a day on a segmented control.
 */
function findAccessSegment(value: ProjectAccessValue): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(
    `[data-slot="radio-group-item"][value="${value}"]`,
  )
}

/**
 * Opens the picker, then picks `value`.
 *
 * The picker is closed at rest since 2026-08-29: the dialog shows the current
 * value with an Edit button, and the segments do not exist until it is
 * pressed. Every state that needs a selection goes through here.
 */
async function selectOption(isCancelled: () => boolean, value: ProjectAccessValue): Promise<void> {
  const edit = await waitForElement(() =>
    document.querySelector<HTMLButtonElement>('[data-testid="access-edit"]'),
  )
  if (isCancelled() || !edit) return
  clickLikeUser(edit)
  const control = await waitForElement(() => findAccessSegment(value))
  if (isCancelled() || !control) return
  clickLikeUser(control)
}

/** Waits for Save to become clickable — it starts disabled until a pick differs from the saved value. */
async function waitForEnabledSave(isCancelled: () => boolean): Promise<HTMLButtonElement | null> {
  return waitForElement(() => {
    if (isCancelled()) return null
    const button = document.querySelector<HTMLButtonElement>('[data-testid="access-save"]')
    return button && !button.disabled ? button : null
  })
}

/** Selects a different option, then clicks "Save access" once it's enabled. */
async function selectThenSave(isCancelled: () => boolean, value: ProjectAccessValue): Promise<void> {
  await selectOption(isCancelled, value)
  if (isCancelled()) return
  const saveButton = await waitForEnabledSave(isCancelled)
  if (isCancelled() || !saveButton) return
  clickLikeUser(saveButton)
}

/**
 * Opens the edit screen and stops there.
 *
 * The access options only exist on that screen since 2026-08-29, so any state
 * ABOUT an option — the disabled Public link, for one — has to click Edit
 * first.
 */
function EditingFixture({
  access,
  publicLinksEnabled,
}: {
  access: ProjectAccessValue
  publicLinksEnabled?: boolean
}) {
  useEffect(() => {
    let cancelled = false
    runDrivenInteraction(async () => {
      const edit = await waitForElement(() =>
        document.querySelector<HTMLButtonElement>('[data-testid="access-edit"]'),
      )
      if (cancelled || !edit) return
      clickLikeUser(edit)
    })
    return () => {
      cancelled = true
    }
  }, [])
  return <AccessPanel access={access} publicLinksEnabled={publicLinksEnabled} />
}

// ---- invite-by-email driving (mirrors the old project-members fixture) ----

/**
 * Adds one draft row and types an address into it.
 *
 * "Add member" appends an EMPTY row since 2026-08-29 — it no longer submits
 * anything, and there is no per-row Add button. The dialog's own Save is what
 * commits every typed row, which is why these drivers now end at
 * `waitForEnabledSave` like the access-change ones do.
 */
async function typeInviteEmail(isCancelled: () => boolean, index = 0): Promise<boolean> {
  const trigger = await waitForElement(() =>
    document.querySelector<HTMLButtonElement>('[data-testid="access-add-open"]'),
  )
  if (isCancelled() || !trigger) return false
  clickLikeUser(trigger)
  const input = await waitForElement(() =>
    document.querySelector<HTMLInputElement>(`[data-testid="access-draft-${index}"]`),
  )
  if (isCancelled() || !input) return false
  setNativeValue(input, index === 0 ? NEW_MEMBER_EMAIL : `second+${index}@example.com`)
  return true
}

function InviteEmailEnteredFixture() {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    let cancelled = false
    runDrivenInteraction(async () => {
      if (!(await typeInviteEmail(() => cancelled))) return
      if (!(await waitForEnabledSave(() => cancelled))) return
      if (!cancelled) setReady(true)
    })
    return () => {
      cancelled = true
    }
  }, [])
  return (
    <>
      <AccessPanel access="invited" routes={{ [MEMBERS_ROUTE]: ok({ members: SAMPLE_MEMBERS }) }} />
      {ready ? <span data-fixture-ready hidden /> : null}
    </>
  )
}

function InviteSubmitFixture({
  postResult,
  markReady = false,
}: {
  postResult: FetchOverrideResult
  markReady?: boolean
}) {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    let cancelled = false
    runDrivenInteraction(async () => {
      if (!(await typeInviteEmail(() => cancelled))) return
      // The dialog's Save commits the typed rows since 2026-08-29; there is
      // no per-row Add button to press any more.
      const saveButton = await waitForEnabledSave(() => cancelled)
      if (cancelled || !saveButton) return
      clickLikeUser(saveButton)
      if (!markReady) return
      const busy = await waitForElement(() => (saveButton.disabled ? saveButton : null))
      if (!cancelled && busy) setReady(true)
    })
    return () => {
      cancelled = true
    }
  }, [markReady])
  return (
    <>
      <AccessPanel
        access="invited"
        routes={{ [MEMBERS_ROUTE]: ok({ members: SAMPLE_MEMBERS }), [POST_MEMBERS_ROUTE]: postResult }}
      />
      {markReady && ready ? <span data-fixture-ready hidden /> : null}
    </>
  )
}

/** Clicks a member's Remove and shows whatever the DELETE answers. */
function RemoveFixture({ deleteResult }: { deleteResult: FetchOverrideResult }) {
  useEffect(() => {
    let cancelled = false
    runDrivenInteraction(async () => {
      const button = await waitForElement(() =>
        document.querySelector<HTMLButtonElement>('button[aria-label="Remove Rin Adeyemi"]'),
      )
      if (cancelled || !button) return
      clickLikeUser(button)
    })
    return () => {
      cancelled = true
    }
  }, [])
  return (
    <AccessPanel
      access="invited"
      routes={{ [MEMBERS_ROUTE]: ok({ members: SAMPLE_MEMBERS }), [DELETE_MEMBER_ROUTE]: deleteResult }}
    />
  )
}

// ---- access-change driving (select, then Save) -------------------------

/** Starts at "All members", selects a different option, and STOPS there — never clicks Save. */
function PendingChangeFixture() {
  useEffect(() => {
    let cancelled = false
    runDrivenInteraction(() => selectOption(() => cancelled, "invited"))
    return () => {
      cancelled = true
    }
  }, [])
  return <AccessPanel access="all-members" routes={{ [MEMBERS_ROUTE]: ok({ members: [] }) }} />
}

/** Starts at "All members", selects `targetValue`, clicks Save, and lets the PATCH answer decide the outcome. */
function AccessChangeFixture({
  targetValue,
  patchResult,
}: {
  targetValue: ProjectAccessValue
  patchResult: FetchOverrideResult
}) {
  useEffect(() => {
    let cancelled = false
    runDrivenInteraction(() => selectThenSave(() => cancelled, targetValue))
    return () => {
      cancelled = true
    }
  }, [targetValue])
  return (
    <AccessPanel
      access="all-members"
      publicLinksEnabled
      routes={{
        [PATCH_PROJECT_ROUTE]: patchResult,
        // "Invited only" mounts the access list as soon as it's PICKED (not
        // only once saved — see `project-access.tsx`'s doc comment), so it
        // needs a route too even in states that target "public-link".
        [MEMBERS_ROUTE]: ok({ members: [] }),
      }}
    />
  )
}

export const PROJECT_ACCESS_SURFACE: SurfaceEntry = {
  id: "project-access",
  title: "Access dialog",
  kind: "modal",
  sourceFile: "viewer/app/project-access.tsx",
  states: [
    {
      id: "project-access/loading",
      label: "Loading — the caller's role hasn't resolved yet",
      render: (ctx) => <DialogWrapped ctx={ctx} access="all-members" currentUserLoading />,
    },
    {
      id: "project-access/viewer-read-only",
      label: "Viewer role — read-only sentence, no picker",
      render: (ctx) => <DialogWrapped ctx={ctx} access="invited" canManage={false} />,
    },
    {
      id: "project-access/all-members",
      label: "All members selected (default) — Save/Cancel disabled, nothing pending",
      render: (ctx) => <DialogWrapped ctx={ctx} access="all-members" />,
    },
    {
      id: "project-access/public-link",
      label: "Public link selected",
      render: (ctx) => <DialogWrapped ctx={ctx} access="public-link" publicLinksEnabled />,
    },
    {
      id: "project-access/public-link-disabled-by-instance",
      label: "Editing — Public link disabled with its reason, instance kill switch is off",
      readyWhen: '[data-slot="radio-group-item"][value="public-link"]:disabled',
      render: (ctx) => (
        <DialogFrame title={DIALOG_TITLE} size="xl" onOpenChange={(open) => ctx.log("onOpenChange", open)}>
          <EditingFixture access="all-members" publicLinksEnabled={false} />
        </DialogFrame>
      ),
    },
    {
      id: "project-access/invited-empty",
      label: "Invited only — no one added yet",
      render: (ctx) => (
        <DialogWrapped ctx={ctx} access="invited" routes={{ [MEMBERS_ROUTE]: ok({ members: [] }) }} />
      ),
    },
    {
      id: "project-access/invited-populated",
      label: "Invited only — access list with Remove buttons + Add-by-email form",
      render: (ctx) => (
        <DialogWrapped ctx={ctx} access="invited" routes={{ [MEMBERS_ROUTE]: ok({ members: SAMPLE_MEMBERS }) }} />
      ),
    },
    {
      id: "project-access/invited-list-load-error",
      label: "Invited only — the access list failed to load",
      render: (ctx) => <DialogWrapped ctx={ctx} access="invited" routes={{ [MEMBERS_ROUTE]: NETWORK_ERROR }} />,
    },
    {
      id: "project-access/invite-email-entered",
      label: "Add-by-email form — email typed, Add enabled",
      readyWhen: "[data-fixture-ready]",
      render: (ctx) => (
        <DialogFrame title={DIALOG_TITLE} size="xl" onOpenChange={(open) => ctx.log("onOpenChange", open)}>
          <InviteEmailEnteredFixture />
        </DialogFrame>
      ),
    },
    {
      id: "project-access/invite-busy",
      label: "Add-by-email form — adding (Add disabled)",
      readyWhen: "[data-fixture-ready]",
      render: (ctx) => (
        <DialogFrame title={DIALOG_TITLE} size="xl" onOpenChange={(open) => ctx.log("onOpenChange", open)}>
          <InviteSubmitFixture postResult={PENDING} markReady />
        </DialogFrame>
      ),
    },
    {
      id: "project-access/invite-error",
      label: "Add-by-email error — server message",
      // The add failure moved into `AddPersonDialog` and is a `<span
      // role="status">` there, not a `<p>` — it has to be announced, since a
      // dialog description is only read on open. The other three error states
      // below still render the panel's own `<p>`.
      readyWhen: '[role="status"].text-destructive',
      render: (ctx) => (
        <DialogFrame title={DIALOG_TITLE} size="xl" onOpenChange={(open) => ctx.log("onOpenChange", open)}>
          <InviteSubmitFixture postResult={fail(422, "That email already has access to this project.")} />
        </DialogFrame>
      ),
    },
    {
      id: "project-access/remove-busy",
      label: "Remove button busy (disabled) mid-request",
      readyWhen: 'button[aria-label="Remove Rin Adeyemi"]:disabled',
      render: (ctx) => (
        <DialogFrame title={DIALOG_TITLE} size="xl" onOpenChange={(open) => ctx.log("onOpenChange", open)}>
          <RemoveFixture deleteResult={PENDING} />
        </DialogFrame>
      ),
    },
    {
      id: "project-access/remove-error",
      label: "Remove error — the server refused",
      readyWhen: "p.text-destructive",
      render: (ctx) => (
        <DialogFrame title={DIALOG_TITLE} size="xl" onOpenChange={(open) => ctx.log("onOpenChange", open)}>
          {/* A server-side failure the route can still produce. It used to
              mock "Cannot remove the last member of an invite-only
              prototype", which stopped being reachable when that guard was
              removed on 2026-08-29 — a gallery state showing a message the
              product cannot send is worse than no state at all. */}
          <RemoveFixture deleteResult={fail(500, "Couldn't remove that person. Try again.")} />
        </DialogFrame>
      ),
    },
    {
      id: "project-access/pending-change",
      label: "Editing — Invited only picked, not saved, Save/Cancel enabled",
      readyWhen: '[data-testid="access-save"]:not(:disabled)',
      render: (ctx) => (
        <DialogFrame title={DIALOG_TITLE} size="xl" onOpenChange={(open) => ctx.log("onOpenChange", open)}>
          <PendingChangeFixture />
        </DialogFrame>
      ),
    },
    {
      id: "project-access/access-change-saving",
      label: "Editing — Save clicked, saving (segments + footer disabled)",
      readyWhen: '[data-slot="radio-group-item"][value="invited"]:disabled',
      render: (ctx) => (
        <DialogFrame title={DIALOG_TITLE} size="xl" onOpenChange={(open) => ctx.log("onOpenChange", open)}>
          <AccessChangeFixture targetValue="invited" patchResult={PENDING} />
        </DialogFrame>
      ),
    },
    {
      id: "project-access/access-change-error",
      label: "Editing — Save fails (403), the pending pick stays so you can retry or cancel",
      readyWhen: "p.text-destructive",
      render: (ctx) => (
        <DialogFrame title={DIALOG_TITLE} size="xl" onOpenChange={(open) => ctx.log("onOpenChange", open)}>
          <AccessChangeFixture targetValue="invited" patchResult={fail(403, "This action requires the editor role")} />
        </DialogFrame>
      ),
    },
    {
      id: "project-access/access-change-409",
      label: "Editing — Save 409s, public links disabled on this viewer",
      readyWhen: "p.text-destructive",
      render: (ctx) => (
        <DialogFrame title={DIALOG_TITLE} size="xl" onOpenChange={(open) => ctx.log("onOpenChange", open)}>
          <AccessChangeFixture
            targetValue="public-link"
            patchResult={fail(409, "Public links are disabled on this viewer")}
          />
        </DialogFrame>
      ),
    },
  ],
}
