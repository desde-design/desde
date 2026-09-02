"use client"

import { useEffect, useRef, type ReactNode } from "react"
import { ActivityPanel } from "@/components/editor/activity-panel"
import type { WorkingTreeChange } from "@/hooks/useEditorBranches"
import type { LedgerRow, UndoResult } from "@/hooks/useEditorLedger"
import { useEditorStore } from "@/stores/editor-only"
import type { SurfaceEntry, SurfaceRenderContext } from "../types"
import { clickLikeUser, findByText, runDrivenInteraction, waitForElement } from "./dom-interaction"

/**
 * Task 6 fixture for the rebuilt Activity panel (Plan B, Tasks 3-5): one
 * merged list (`rows` + `changes`), the shared Undo confirm dialog, and the
 * per-row detail dialog Task 5 added. Six states — see `SURFACE_REGISTRY`
 * below. This is a full rewrite of the body; two things carry over from the
 * pre-rewrite fixture unchanged, because both are still true of the panel
 * today:
 *
 * 1. **`RailFrame`.** `ActivityPanel` is a right-rail PANEL, not a `Dialog`
 *    — no scrim, no fixed/portaled positioning of its own. Rendered bare it
 *    becomes another block in the page's normal flow, landing wherever the
 *    picker portal happens to push it (confirmed live: below the fold, at
 *    y=720 in a 720px viewport — invisible without scrolling, even though
 *    its content was correct). `RailFrame` reproduces the fixed, visible
 *    rail container a designer actually needs to look at, without touching
 *    activity-panel.tsx itself.
 * 2. **Frame-scoped queries.** The ambient self-host chrome mounts its own
 *    `ActivityPanel` (branch mode is always live), sharing the same
 *    `[aria-label^="Actions for…"]` shape. An unscoped `document.querySelector`
 *    can match the chrome's row instead of this fixture's — every driven
 *    interaction below that needs to click a TRIGGER queries through
 *    `frame` (this fixture's own `RailFrame` root), never `document`
 *    directly. A dropdown/dialog's PORTAL content is the one exception —
 *    Radix renders `DropdownMenuContent`/`DialogContent` into
 *    `document.body`, outside `frame`'s subtree, so those queries stay
 *    unscoped (only one menu/dialog is ever open at a time regardless).
 *
 * `verifications` still comes from `useEditorStore` (the CLI-only Zustand
 * store, `src/stores/editor-only.ts`) — seeded from an EFFECT, not during
 * render. Calling `useEditorStore.setState(...)` inside a `SurfaceState.render`
 * body runs it during `GalleryOverlay`'s own render, which React reports as
 * "Cannot update a component while rendering a different component." The
 * gallery's bar is that stepping the catalog throws nothing to the console,
 * so this stays an effect.
 *
 * ## The correlationId join (Task 4b)
 *
 * A row's verification pill is looked up by `row.row.correlationId`, the
 * CLIENT's own edit id — NOT `row.row.id`, which is a server-minted
 * `randomUUID()` in a disjoint id space (see `activity-verification-join.ts`
 * and `activity-panel.tsx`'s own module doc comment on the bug this
 * replaced). Every row below that should carry a pill sets `correlationId`
 * on the `LedgerRow` AND the matching `editId` on its `VerificationRecord` —
 * two different-looking strings that name the same edit, exactly as the
 * real client/server split produces. A row with no `correlationId` (the
 * committed row here, made via chat — chat/SDK-tool writes don't go
 * through the correlated dispatch path at all) is the fixture for state 5:
 * proof the Verification section is OMITTED, not rendered empty.
 */
function RailFrame({
  children,
  frameRef,
}: {
  children: ReactNode
  /**
   * Lets a driven fixture scope its queries to THIS panel. The ambient
   * self-host chrome mounts its own `ActivityPanel`, so a bare
   * `document.querySelector('[aria-label^="Actions for"]')` can match
   * the chrome's row instead of the fixture's — the same hazard
   * `branch-menu.tsx` solves with its own-branch label.
   */
  frameRef?: React.RefObject<HTMLDivElement | null>
}) {
  return (
    <div
      ref={frameRef}
      className="fixed left-4 top-4 z-40 h-[640px] w-80 overflow-hidden rounded-lg border border-border bg-background shadow-lg"
    >
      {children}
    </div>
  )
}

// Anchored to render time, not a fixed calendar date — `at` feeds
// `formatRelativeTime` in the detail dialog, and a hardcoded ISO string
// would drift into "5d ago" the first time this gallery is opened on a
// day other than the one it was written on.
const NOW = Date.now()
const minutesAgo = (n: number): string => new Date(NOW - n * 60_000).toISOString()

const FAILED_ROW_FILE = "src/components/PricingCard.vue"
const PASS_ROW_FILE = "src/components/PricingPage.vue"
const COMMITTED_ROW_FILE = "src/components/TestimonialCarousel.vue"
const STALE_ROW_FILE = "src/components/PromoBanner.vue"

const FAILED_CORRELATION_ID = "edit-elevated-01"
const PASS_CORRELATION_ID = "edit-token-primary-01"

/**
 * The long `css-overridden` detail Task 5's review flagged (jsdom-only
 * verification, never actually looked at in a browser): does a real
 * `css-overridden` detail sentence — which names the winning selector AND
 * the package it ships from — wrap acceptably in `DialogContent size="lg"`,
 * or does it overflow? Shaped after the real generator
 * (`describeCascadeFailure` / `describeCascadeWinner` in
 * `src/editor/verification/verify-render.ts` and `cascade-outcome.ts`):
 * "did not take effect, the edit is in source but `<selector>` in
 * `<package>` wins the cascade for `<property>`, re-apply at a broader
 * scope." Written without the real generator's em dash — house copy rule
 * (`docs/design.md` § "No em dashes") applies to what THIS fixture writes,
 * even though the shipped generator itself still uses one (a separate,
 * out-of-scope finding, not fixed here).
 */
const LONG_CSS_OVERRIDDEN_DETAIL =
  "Did not take effect: the edit is in source, but " +
  "`.PricingCard--elevated .PricingCard__surface !important` in " +
  "@acme/design-system wins the cascade for box-shadow. Re-apply at a " +
  "broader scope, either the design token or the stylesheet that " +
  "declares that rule."

const LEDGER_ROWS: LedgerRow[] = [
  {
    // Server-minted id (`brokeredWrite`'s own `randomUUID()`) — deliberately
    // NOT the same string as `correlationId` below. See the module doc
    // comment's "correlationId join" section.
    id: "ldg_9c1f2a7e",
    at: minutesAgo(6),
    kind: "prop",
    lane: "direct",
    files: [FAILED_ROW_FILE],
    backupDir: ".desde/backups/9c1f2a",
    afterHashes: { [FAILED_ROW_FILE]: "9f2a7c1e4b8d3f60" },
    description: 'elevated = "true"',
    committed: false,
    correlationId: FAILED_CORRELATION_ID,
  },
  {
    id: "ldg_2b91e4d0",
    at: minutesAgo(20),
    kind: "token-value",
    lane: "direct",
    files: [PASS_ROW_FILE],
    backupDir: ".desde/backups/2b91e4",
    afterHashes: { [PASS_ROW_FILE]: "4e1a9d7c2f6b8035" },
    description: 'color.brand.primary = "#0EA5A4"',
    committed: false,
    correlationId: PASS_CORRELATION_ID,
  },
  {
    id: "ldg_71fa08c3",
    at: minutesAgo(90),
    kind: "insert_component",
    lane: "chat",
    files: [COMMITTED_ROW_FILE],
    // No `backupDir`: this edit created the file, so there's nothing to
    // back up. `createdFiles` is what actually drives "New file"
    // (`ActivityRow`'s `changeTypeForRow`, fixed F3 codex review round
    // 4, 2026-08-20) — a missing `backupDir` alone no longer means that,
    // since `manage_package` also omits it for an unbacked MODIFICATION.
    createdFiles: [COMMITTED_ROW_FILE],
    afterHashes: { [COMMITTED_ROW_FILE]: "1a2b3c4d5e6f7089" },
    description: "Inserted TestimonialCarousel",
    committed: true,
    sha: "c92f6e1",
    // No `correlationId`: a chat/SDK-tool write, which never sends one.
    // This is the row state 5 opens.
  },
]

const CHANGES: WorkingTreeChange[] = [
  { path: "src/components/Header.vue", from: "src/components/TopBar.vue", status: "renamed" },
]

/** Dedicated row for the undo-unavailable state — see that state's comment. */
const STALE_ROW: LedgerRow = {
  id: "ldg_5a7e1904",
  at: minutesAgo(45),
  kind: "prop",
  lane: "direct",
  files: [STALE_ROW_FILE],
  backupDir: ".desde/backups/5a7e19",
  afterHashes: { [STALE_ROW_FILE]: "7c3d9f2a1b4e6085" },
  description: 'background = "var(--color-surface-alt)"',
  committed: false,
}

/** The server's exact refusal string for a swept backup — surfaced
 *  verbatim by the real panel, never rewritten (`undo-entry.ts`). */
const BACKUP_GONE_REASON = "The backup for this edit is gone, so it can't be undone."

type Verifications = ReturnType<typeof useEditorStore.getState>["verifications"]

function sampleVerifications(): Verifications {
  // Newest LAST, matching `startVerification`'s own push order
  // (`editor-slice.ts`). `ActivityPanel` joins by `correlationId`, not
  // array position, so this array's order is cosmetic here.
  return [
    {
      editId: PASS_CORRELATION_ID,
      label: 'color.brand.primary = "#0EA5A4"',
      phase: "done",
      startedAt: NOW - 20 * 60_000 + 340,
      result: {
        editId: PASS_CORRELATION_ID,
        status: "pass",
        expectedValue: "#0EA5A4",
        observedValue: "#0EA5A4",
        escalatable: false,
        detail: "DOM computed style matched the written value.",
        durationMs: 340,
      },
    },
    {
      editId: FAILED_CORRELATION_ID,
      label: 'elevated = "true"',
      phase: "done",
      startedAt: NOW - 6 * 60_000 + 612,
      result: {
        editId: FAILED_CORRELATION_ID,
        status: "fail",
        failedAt: "L2",
        expectedValue: "0 4px 12px rgba(15, 23, 42, 0.12)",
        observedValue: "none",
        cause: "css-overridden",
        // `css-overridden` is not in `LLM_FIXABLE_CAUSES` — the fix is
        // widening the edit's scope, not something chat's one-shot LLM
        // fallback can plausibly do.
        escalatable: false,
        detail: LONG_CSS_OVERRIDDEN_DETAIL,
        durationMs: 612,
      },
    },
  ]
}

/** Scoped to `frame` — see the module doc comment on frame-scoped queries. */
function triggerFor(frame: HTMLDivElement, path: string): HTMLButtonElement | null {
  return frame.querySelector<HTMLButtonElement>(`[aria-label="Actions for ${path}"]`)
}

/** Scoped to `frame` — the row itself (not its `⋮` trigger) lives inside
 *  this fixture's own subtree, unlike the portaled menu/dialog content. */
function rowFor(frame: HTMLDivElement, pattern: RegExp): HTMLElement | null {
  return findByText<HTMLElement>('[data-testid="activity-row"]', pattern, frame)
}

/**
 * Poll until the element `testid` names is gone OR no longer `data-state="open"`
 * — the undo-unavailable state needs to know the confirm dialog has
 * finished closing (see that state's driver) before it reopens the same
 * row's menu.
 *
 * MEASURED live (`npm run gallery`, real Chromium — this does NOT reproduce
 * in the jsdom-backed `registry.test.tsx` sweep): checking for the element
 * to fully leave the DOM hangs the full timeout every time. Radix's
 * `Dialog.Content` stays mounted with `data-state="closed"` for as long as
 * its `Presence` is waiting on an exit-animation event that never fires in
 * this environment — the dialog is already visually gone (the `open` prop
 * flipped false the instant `confirmUndo` cleared `pending`), but the DOM
 * node itself can outlive that by an unbounded amount. `data-state` is set
 * synchronously with React's own render, so reading THAT is what actually
 * reflects "the panel is done with this dialog" — waiting for the node to
 * disappear was checking an animation-timing detail that has nothing to do
 * with whether it's safe to move on.
 */
async function waitForClosed(
  testid: string,
  { timeoutMs = 2000, intervalMs = 10 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const el = document.querySelector(`[data-testid="${testid}"]`)
    if (!el || el.getAttribute("data-state") !== "open") return true
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  console.warn("[gallery] waitForClosed timed out waiting for", testid)
  return false
}

type Drive = (frame: HTMLDivElement, isCancelled: () => boolean) => Promise<void>

/**
 * Opens the FAILED row's `⋮` menu and picks Undo. `ActivityPanel`'s Undo
 * confirm dialog is internal `useState` (`pending`) reached only this way
 * — no prop forces it open.
 */
const driveUndoConfirm: Drive = async (frame, isCancelled) => {
  const trigger = await waitForElement(() => triggerFor(frame, FAILED_ROW_FILE))
  if (isCancelled() || !trigger) return
  clickLikeUser(trigger)

  // NOT scoped to `frame`: `DropdownMenuContent` renders through a Radix
  // Portal, so the open menu's items are never a descendant of this frame.
  const undoItem = await waitForElement(() => findByText<HTMLElement>('[role="menuitem"]', /^Undo$/))
  if (isCancelled() || !undoItem) return
  clickLikeUser(undoItem)
}

/**
 * The full round trip for "undo unavailable": open the menu, pick Undo
 * (the first attempt is always optimistic — the client has no file to hash
 * ahead of time), confirm, let the panel's `undo` callback below refuse
 * with the server's real "backup is gone" reason, wait for the confirm
 * dialog to close (which happens in the same commit the panel caches the
 * refusal), then reopen the SAME row's menu to show Undo disabled with
 * that reason. This has to be driven for real — there's no prop that
 * hands the panel a pre-cached refusal.
 */
const driveUndoUnavailable: Drive = async (frame, isCancelled) => {
  const trigger = await waitForElement(() => triggerFor(frame, STALE_ROW_FILE))
  if (isCancelled() || !trigger) return
  clickLikeUser(trigger)

  const undoItem = await waitForElement(() => findByText<HTMLElement>('[role="menuitem"]', /^Undo$/))
  if (isCancelled() || !undoItem) return
  clickLikeUser(undoItem)

  const confirmButton = await waitForElement(() =>
    document.querySelector<HTMLButtonElement>('[data-testid="activity-undo-confirm"]'),
  )
  if (isCancelled() || !confirmButton) return
  clickLikeUser(confirmButton)

  const closed = await waitForClosed("activity-undo-dialog")
  if (isCancelled() || !closed) return

  const triggerAgain = await waitForElement(() => triggerFor(frame, STALE_ROW_FILE))
  if (isCancelled() || !triggerAgain) return
  clickLikeUser(triggerAgain)
}

/** Clicks a row (not its `⋮` trigger) to open `ActivityDetailDialog`. */
function driveOpenDetail(pattern: RegExp): Drive {
  return async (frame, isCancelled) => {
    const row = await waitForElement(() => rowFor(frame, pattern))
    if (isCancelled() || !row) return
    clickLikeUser(row)
  }
}

function ActivityFixture({
  ctx,
  rows,
  changes,
  verifications,
  undo,
  drive,
}: {
  ctx: SurfaceRenderContext
  rows: LedgerRow[]
  changes: WorkingTreeChange[]
  verifications: Verifications
  /** Defaults to an always-succeeding undo. The undo-unavailable state
   *  overrides this to return the server-shaped refusal it needs to show. */
  undo?: (id: string) => Promise<UndoResult>
  /** Runs once after mount for a driven state — see each `Drive`'s own
   *  comment for why that state can only be reached by clicking through
   *  the real UI, the same as a designer would. */
  drive?: Drive
}) {
  const frameRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    useEditorStore.setState({ verifications })
  }, [verifications])

  useEffect(() => {
    if (!drive) return
    let cancelled = false
    runDrivenInteraction(async () => {
      const frame = frameRef.current
      if (!frame) return
      await drive(frame, () => cancelled)
    })
    return () => {
      cancelled = true
    }
    // `drive` is a stable per-state literal — this runs the interaction
    // exactly once, matching every other interaction-driven fixture in
    // this catalog (see e.g. branch-menu.tsx's `DialogFixture`).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const defaultUndo = async (id: string): Promise<UndoResult> => {
    ctx.log("undo", id)
    return { ok: true }
  }

  return (
    <RailFrame frameRef={frameRef}>
      <ActivityPanel rows={rows} changes={changes} undo={undo ?? defaultUndo} />
    </RailFrame>
  )
}

export const ACTIVITY_PANEL_SURFACE: SurfaceEntry = {
  id: "activity-panel",
  title: "Activity panel: merged ledger + working-tree list",
  // `inline`, not `modal`: this surface is the right-rail panel itself. Only
  // some of its states are dialogs, reached from within the panel.
  kind: "inline",
  sourceFile: "src/components/editor/activity-panel.tsx",
  states: [
    {
      id: "activity-panel/mixed",
      label: "Mixed list: verified, failed, committed, changed outside the editor",
      render: (ctx) => (
        <ActivityFixture
          ctx={ctx}
          rows={LEDGER_ROWS}
          changes={CHANGES}
          verifications={sampleVerifications()}
        />
      ),
    },
    {
      id: "activity-panel/undo-confirm",
      label: "Undo confirm dialog",
      readyWhen: '[data-testid="activity-undo-dialog"]',
      render: (ctx) => (
        <ActivityFixture
          ctx={ctx}
          rows={LEDGER_ROWS}
          changes={CHANGES}
          verifications={sampleVerifications()}
          drive={driveUndoConfirm}
        />
      ),
    },
    {
      id: "activity-panel/undo-unavailable",
      label: "Undo unavailable: backup was cleaned up",
      readyWhen: '[role="menuitem"][data-disabled]',
      render: (ctx) => (
        <ActivityFixture
          ctx={ctx}
          rows={[STALE_ROW]}
          changes={CHANGES}
          verifications={[]}
          undo={async (id) => {
            ctx.log("undo", id)
            return { ok: false, code: "backup-gone", reason: BACKUP_GONE_REASON }
          }}
          drive={driveUndoUnavailable}
        />
      ),
    },
    {
      id: "activity-panel/detail-verified",
      label: "Detail dialog: with a verification record",
      readyWhen: '[data-testid="activity-detail-verification"]',
      render: (ctx) => (
        <ActivityFixture
          ctx={ctx}
          rows={LEDGER_ROWS}
          changes={CHANGES}
          verifications={sampleVerifications()}
          drive={driveOpenDetail(/elevated/)}
        />
      ),
    },
    {
      id: "activity-panel/detail-no-verification",
      label: "Detail dialog: no verification record",
      readyWhen: '[data-testid="activity-detail-dialog"]',
      render: (ctx) => (
        <ActivityFixture
          ctx={ctx}
          rows={LEDGER_ROWS}
          changes={CHANGES}
          verifications={sampleVerifications()}
          drive={driveOpenDetail(/Inserted TestimonialCarousel/)}
        />
      ),
    },
    {
      id: "activity-panel/clean-tree",
      label: "Clean working tree, empty ledger",
      render: (ctx) => (
        <ActivityFixture ctx={ctx} rows={[]} changes={[]} verifications={[]} />
      ),
    },
  ],
}
