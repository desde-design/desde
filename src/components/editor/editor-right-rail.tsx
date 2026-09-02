"use client"

/**
 * Editor right rail — Phase 1c of tasks/cli-viewer-architecture.md.
 *
 * Top-level tabs:
 *
 *   Edit         — Layers tree at the top. With nothing selected the
 *                  Layers tree fills the tab; once an element is
 *                  selected (from the tree or by clicking in the
 *                  prototype in Select mode) the tree shrinks into a
 *                  vertical split and the per-element Inspector
 *                  ("edit panel") mounts beneath it.
 *   Chat         — the agent chat panel. When a worktree session is
 *                  active, a ChatSessionMenu bar mounts above the chat
 *                  header so the user can see the current chat, switch
 *                  sessions via the recents menu, and start new chats.
 *   Comments     — Comments + Notes merged list, backed by the
 *                  iframe bridge. Named "Comments" even though it can
 *                  also list Notes (Mo, 2026-08-14). Notes went dormant
 *                  the same day (`EDITOR_NOTES`), so by default the list
 *                  holds comments only and the name is exact.
 *   Activity     — the working tree's uncommitted changes (branch mode
 *                  edits in place; the list mirrors `git status`).
 *
 * The active tab lives in `editor-surface.tsx` so the surface can
 * react to upstream signals (e.g. Commit/Push badge clicks → switch
 * to Activity, pin click → Comments). This component is pure
 * presentational: it switches what it renders based on the props
 * it's given.
 */

import * as React from "react"
import { useCallback, useMemo, useRef } from "react"
import type { Selection } from "@/editor/core"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ResizableVerticalSplit } from "@/components/editor/resizable-vertical-split"
import { EditorChatPanel } from "@/components/editor/editor-chat-panel"
import { ModelPickerChip } from "@/components/editor/model-picker-chip"
import { InspectorPanel } from "@/components/editor/inspector-panel"
import type { ActiveBreakpoint } from "@/components/editor/tailwind-classes"
import { LayersPanel } from "@/components/editor/layers-panel"
import { CommentsPanel } from "@/components/editor/comments-panel"
import { ActivityPanel } from "@/components/editor/activity-panel"
import { ChatSessionMenu } from "@/components/editor/chat-session-menu"
import { editorFetch } from "@/lib/editor-fetch"
import { EDITOR_LANE_DETACH, EDITOR_LANE_SWAP } from "@/lib/editor-feature-flags"
import { useChatSessionDraftCache } from "@/hooks/useChatSessionDraftCache"
import { useEditorLedger } from "@/hooks/useEditorLedger"
import type { ChatSession } from "@/editor/agent-chat/types"
import type { SessionModelConfig } from "@/editor/core/model-catalog"
import type { ChatSessionSummary } from "@/editor/agent-chat/session-store"
import type { useChatSessions } from "@/hooks/useChatSessions"
import type { useEditorChat } from "@/hooks/useEditorChat"
import type { useEditorEditing } from "@/hooks/useEditorEditing"
import type { BranchesApi } from "@/hooks/useEditorBranches"
import type { EditorCommentStoreResult } from "@/hooks/useEditorCommentStore"
import type { UseEditorCommentBridgeResult } from "@/hooks/useEditorCommentBridge"

type EditingApi = ReturnType<typeof useEditorEditing>
type ChatApi = ReturnType<typeof useEditorChat>
type ChatSessionsApi = ReturnType<typeof useChatSessions>

export type RightRailTab =
  | "edit"
  | "chat"
  | "comments"
  | "activity"

interface EditorRightRailProps {
  activeTab: RightRailTab
  onTabChange: (next: RightRailTab) => void
  editing: EditingApi
  chat: ChatApi
  /**
   * Detached chat sessions state. Provided so the right rail can mount
   * the tab strip in the chat panel header. Only renders it when
   * `chatSessions.enabled` (the `EDITOR_DETACHED_SESSIONS` flag) — when
   * disabled, the panel behaves as a single default chat with no
   * multi-session UI.
   */
  chatSessions: ChatSessionsApi
  /**
   * Invoked when the user switches tabs, or clicks "View in iframe" on
   * the detail panel. Should re-anchor the iframe to the session's
   * pinned page (and pinned selection when present). Owned by the
   * surface because the current-page store sits there. Pass undefined
   * to skip re-anchor — the tab strip still switches the active session.
   */
  onReAnchorToSession?: (summary: import("@/editor/agent-chat/session-store").ChatSessionSummary) => void
  selectionMany: Selection[] | null
  /**
   * Iframe ref for the CLI Comments container's bridge channel.
   * The CLI editor surface always passes this; it is required.
   */
  iframeRef: React.RefObject<HTMLIFrameElement | null>
  /**
   * The comment bridge and the active comment store, both mounted by
   * `EditorSurface` and passed through to the Comments tab. They live up
   * there because the toolbar's Comment button needs the same instances,
   * and mounting either one twice has real costs (a duplicated window
   * message listener; a second `/api/editor/viewer-auth` fetch).
   */
  commentBridge: UseEditorCommentBridgeResult
  commentSync: EditorCommentStoreResult
  /** Toggle comment placement mode; the same handler the toolbar fires. */
  onCommentModeChange: (next: boolean) => void
  /**
   * Fires when a NOTE pin is clicked inside the iframe. The surface uses
   * this to auto-switch the active tab to Comments (context-aware default
   * opening). `kind` disambiguates Comment vs Note for any per-type
   * behavior; v1 surfaces use it identically. The comment half of the
   * signal is wired at the surface, on the lifted bridge.
   */
  onCommentPinClicked?: (id: string, kind: "comment" | "note") => void
  /**
   * Escalate-to-chat seam forwarded to the Comments tab's per-comment
   * "Fix with AI" action. Same handler direct-manipulation edits use.
   */
  onEscalateToChat?: (prompt: string) => boolean
  /**
   * Active responsive breakpoint from the surface's global viewport
   * control. Forwarded to the inspector so its style sections edit the
   * matching `{bp}:` classes. Defaults to `base` when omitted.
   */
  activeBreakpoint?: ActiveBreakpoint
  /**
   * Branch-mode git state from useEditorBranches (owned by the surface,
   * which also feeds the top-bar Commit/Publish controls from it). The
   * Activity tab renders its uncommitted-changes list. Optional so
   * branchless surfaces degrade to the empty-state explainer.
   */
  branches?: BranchesApi
}

export function EditorRightRail({
  activeTab,
  onTabChange,
  editing,
  chat,
  chatSessions,
  onReAnchorToSession,
  selectionMany,
  iframeRef,
  commentBridge,
  commentSync,
  onCommentModeChange,
  onCommentPinClicked,
  onEscalateToChat,
  activeBreakpoint,
  branches,
}: EditorRightRailProps) {
  // Per-session textarea draft cache. Mounted at the rail (not inside
  // EditorChatPanel) so switching the active tab — which causes
  // currentSessionId to change — doesn't unmount/remount the cache.
  const draftCache = useChatSessionDraftCache()

  // The edit ledger backing the Activity tab's merged row list. Polls on
  // its own cadence (matches `useEditorBranches`'s, see that hook's doc
  // comment) — mounted here, not lifted to the surface, since nothing else
  // in the rail needs it.
  const ledger = useEditorLedger()

  /**
   * P2-2 (codex review round 5, 2026-08-20): a successful ledger Undo
   * rewrites the working tree, but `ledger.undo` only refreshes the
   * LEDGER (`useEditorLedger.ts`'s own `refresh()` call inside `undo`) —
   * it has no idea `branches` (a separate hook, owned by the surface)
   * even exists. Passing `ledger.undo` straight through to
   * `<ActivityPanel>` left the toolbar's git state stale until the next
   * 2.5s branch poll: undoing a COMMITTED edit needs `branches.dirty` to
   * flip true (there's now something new to commit) and Commit to
   * re-enable; undoing the FIRST uncommitted edit back to a clean tree
   * needs `dirty` to flip false and Commit to disable again.
   *
   * `branches.refresh()` matches the plain (non-quiet) `refresh()` every
   * OTHER foreground git mutation in `useEditorBranches.ts` already calls
   * on success (`commitWorkingTree`, `discardFile`, `undoEdit`, …) — this
   * is the same kind of action, just triggered from the ledger side. Only
   * a SUCCESSFUL undo refreshes: a refusal (drifted/backup-gone/wrong-
   * branch/…) means nothing on disk changed, so there is nothing for
   * `branches` to learn either — refreshing on refusal would be a
   * pointless request, not a correctness fix.
   *
   * Awaited before this resolves (matching `ledger.undo`'s own internal
   * `await refresh()`) so the ledger and branches halves land TOGETHER
   * by the time the Activity panel's confirm dialog closes, rather than
   * the toolbar catching up a beat later. This doesn't reintroduce round
   * 4's flicker: `useSettledActivityRows` (`activity-panel.tsx`) already
   * settles 150ms after `rows`/`changes` last changed, covering an
   * undo's near-simultaneous pair exactly the way it covers the shared
   * poll tick's pair.
   */
  const handleLedgerUndo = useCallback(
    async (id: string) => {
      const result = await ledger.undo(id)
      if (result.ok) await branches?.refresh()
      return result
    },
    [ledger, branches],
  )

  // Codex round-1 major #1: rapid tab switches (A → B → A → …) used to
  // race the in-flight transcript fetches against each other; a late
  // A fetch could clobber B's just-hydrated state, and a late failure
  // would call clearLocal under whichever session was active *now*.
  // Abort the prior request whenever a new switch starts so resolved
  // bodies/errors against the old controller's signal short-circuit
  // before touching `chat`.
  const hydrationAbortRef = useRef<AbortController | null>(null)

  // ---------------------------------------------------------------
  // Chat tab props, stabilized.
  //
  // `EditorChatPanel` is memoized, but `tabs` and `modelPicker` are
  // React *elements* — rebuilding them inline on every rail render would
  // change props identity and defeat the memo entirely. Both are memoized
  // here, together with the two session handlers they close over, so the
  // chat panel only re-renders when chat/session state actually moved.
  // (During a stream `chat` changes per flush, which the panel must
  // re-render for anyway — the win is every OTHER surface render.)
  // ---------------------------------------------------------------
  const handleSelectSession = useCallback(
    (summary: ChatSessionSummary) => {
      // PR1 multi-session bucketing: messages live in per-session
      // buckets inside useEditorChat, so tab switches no longer race
      // the visible UI against an in-flight stream. Both Select and
      // + New are safe mid-stream — the prior stream keeps writing to
      // its own bucket and surfaces as a streaming dot on its tab.
      chatSessions.selectSession(summary.sessionId)
      // Hydrate only when the bucket is empty — otherwise we'd clobber
      // live streaming state (or messages the user already authored
      // before navigating away).
      if (!chat.hasSessionBucket(summary.sessionId)) {
        hydrationAbortRef.current?.abort()
        const controller = new AbortController()
        hydrationAbortRef.current = controller
        void hydrateChatFromSession(summary.sessionId, chat, controller.signal)
      }
      // Re-anchor the iframe to the session's pinned context if known.
      // Editor surface owns the dispatch (it has the current-page
      // store); we just call through. No-op when the session has no
      // recorded page.
      if (summary.pinnedPage) {
        onReAnchorToSession?.(summary)
      }
    },
    [chat, chatSessions, onReAnchorToSession],
  )

  const handleNewSession = useCallback(() => {
    // `newSession()` mints a UUID + sets it as currentSessionId. The
    // chat hook reads its visible slice from `byId.get(<new-uuid>)`,
    // which is undefined → empty pane. No explicit clearLocal needed.
    chatSessions.newSession()
  }, [chatSessions])

  const chatSessionId = chatSessions.enabled
    ? chatSessions.currentSessionId
    : null

  // ---------------------------------------------------------------
  // Carry the user's last model choice onto a freshly minted session.
  //
  // Opening a project lands in a NEW chat: `useChatSessions` mints a
  // sessionId on mount (it has to — a null id is not "no session", the
  // server reads it as the project's permanent default session). That
  // means the chip's own adopt branch, which fires only on
  // `sessionId === null`, no longer runs on open. Left alone, every
  // open would silently start on the runtime catalog default instead of
  // the model the user last picked.
  //
  // So hand the chip a seeder for exactly the sessions the client
  // minted. `seedModelConfig` writes only into a bucket whose value is
  // still null, so it can never overwrite a choice the user made, and
  // it names the session explicitly rather than whichever one happens
  // to be visible when it runs.
  //
  // Undefined for a session picked from the listing: that one gets its
  // choice from hydration, and a null value there means it genuinely
  // runs on the runtime default. Writing another chat's model onto it
  // would persist a choice its owner never made.
  //
  // `seedModelConfig` is pulled out of `chat` first because the closure
  // below would otherwise capture the whole `chat` object, which changes
  // on every streamed token.
  const { seedModelConfig } = chat
  const seedLastChosenModel = useMemo(() => {
    if (!chatSessions.enabled || !chatSessions.currentSessionIsNew) {
      return undefined
    }
    const id = chatSessions.currentSessionId
    if (id === null) return undefined
    return (config: SessionModelConfig) => seedModelConfig(id, config)
  }, [
    chatSessions.enabled,
    chatSessions.currentSessionIsNew,
    chatSessions.currentSessionId,
    seedModelConfig,
  ])

  const modelPicker = useMemo(
    () => (
      <ModelPickerChip
        value={chat.modelConfig}
        onChange={chat.setModelConfig}
        // Mirrors what `useChatSessions.getChatSessionId()` will hand
        // `useEditorChat` on the next submit: null when the tab strip
        // is off, in which case the server resolves the project-default
        // session, which has no choice of its own either.
        sessionId={chatSessionId}
        onAdoptLastChosenModel={seedLastChosenModel}
      />
    ),
    [chat.modelConfig, chat.setModelConfig, chatSessionId, seedLastChosenModel],
  )

  const chatTabs = useMemo(
    () =>
      chatSessions.enabled ? (
        <ChatSessionMenu
          sessions={chatSessions.sessions}
          currentSessionId={chatSessions.currentSessionId}
          onSelectSession={handleSelectSession}
          onNewSession={handleNewSession}
        />
      ) : null,
    [
      chatSessions.enabled,
      chatSessions.sessions,
      chatSessions.currentSessionId,
      handleSelectSession,
      handleNewSession,
    ],
  )

  // Edit tab — Layers tree at the top, per-element Inspector beneath.
  // The tree is always present; the Inspector only mounts once an
  // element is selected. Both elements are built once here so the
  // "full tree" and "split" branches below share identical wiring.
  //
  // ── Dormant lanes (2026-08-11, tasks/dev-server-hosts.md § 9e) ──────────
  // `detach` and `swap` are gated OFF by default. This is the OFFERING half of
  // the gate; the CLI refuses the same kinds at dispatch on the same config
  // (`editor-cli/src/server/enabled-lanes.ts`).
  //
  // Gated HERE — at the one place the handlers are wired — rather than inside
  // each panel, because both panels already treat an absent handler as "this
  // action does not exist" (`canDetach = !!onDetach && …`,
  // `detachAvailable = !!onDetach && …`) and their own suites already pin that
  // contract. Adding a second copy of the "should this be offered" rule inside
  // each panel would be a second thing to keep in sync with the dispatch gate.
  //
  // `onPickIcon` rides `EDITOR_LANE_SWAP` and not a flag of its own:
  // `handlePickIcon` dispatches `kind: "swap"` through the very same
  // applicator, so it inherits both the Vue-only inconsistency and the
  // dispatch refusal. Offering it while dispatch refuses is a control that
  // fails on click.
  const layersPanel = (
    <LayersPanel
      roots={editing.layersRoots}
      rawRoots={editing.layersRawRoots}
      density={editing.layersDensity}
      onDensityChange={editing.setLayersDensity}
      selectedSelector={editing.editorSelection?.selector ?? null}
      onSelect={editing.handleLayerSelect}
      onHover={editing.handleLayerHover}
      onMove={editing.handleLayerMove}
      onMoveRefused={editing.handleLayerMoveRefused}
      onRefresh={editing.refreshLayers}
      refreshing={editing.layersRefreshing}
      error={editing.layersError}
      onDetach={EDITOR_LANE_DETACH ? editing.handleLayerDetach : undefined}
      onDelete={editing.handleLayerDelete}
      onInsert={editing.handleLayerInsert}
      onUnwrap={editing.handleLayerUnwrap}
      onFlattenConditional={editing.handleLayerFlattenConditional}
    />
  )
  const inspectorPanel = (
    <InspectorPanel
      selection={editing.editorSelection}
      manifest={editing.editorManifest}
      activeBreakpoint={activeBreakpoint}
      iframeRef={iframeRef}
      onPropEdit={editing.handlePropEdit}
      onDetach={EDITOR_LANE_DETACH ? editing.handleDetach : undefined}
      onSwap={EDITOR_LANE_SWAP ? editing.handleSwap : undefined}
      onEditComponent={editing.handleEditComponent}
      onEditTextField={editing.handleEditTextField}
      onClassesEdit={editing.handleClassesEdit}
      onScopedStyleEdit={editing.handleScopedStyleEdit}
      onTokenStyleEdit={editing.handleTokenStyleEdit}
      onEditTextBranch={editing.handleEditTextBranch}
      onPickIcon={EDITOR_LANE_SWAP ? editing.handlePickIcon : undefined}
    />
  )

  return (
    <>
      <Tabs
        value={activeTab}
        onValueChange={(v) => onTabChange(v as RightRailTab)}
        /*
          One card, matching the Viewer's card two exactly — same radius,
          same border token, same `shadow-xs`, same `overflow-hidden` (Mo,
          2026-09-01). The `overflow-hidden` is load-bearing rather than
          decorative: a scrolling panel inside is clipped BY the rounded
          corner instead of painting over it.

          `flex-1`, not `h-full`. The aside around this now has `p-2`, so a
          child claiming the full height would overflow it by the padding.

          The `border-l` this used to carry moved OUT to that aside, where the
          Viewer keeps its own. A rail's edge belongs to the rail, not to
          whichever panel happens to be mounted in it.
        */
        className="flex min-h-0 flex-1 flex-col gap-0 overflow-hidden rounded-lg border border-border bg-background shadow-xs"
        data-testid="editor-right-rail"
      >
        {/* `p-2 pb-1` is the Viewer's own tab-strip wrapper, copied so the two
            rails space their strips identically. The 4px shortfall at the
            bottom is deliberate there and inherited here: the strip is
            NAVIGATION between panels, so it wants a little more air under it
            than the 8px rhythm inside a panel.

            `w-full`, like the Viewer's strip (Mo, 2026-09-02: "the tabs at
            the top should be full width"). The four triggers are `flex-1`,
            so they share the rail's width and re-share it as the rail is
            dragged; the strip sat `w-auto justify-start` before, hugging its
            labels at the left. */}
        <div className="flex-none p-2 pb-1">
        <TabsList variant="default" size="sm" className="w-full">
          <TabsTrigger value="edit" data-testid="right-rail-tab-edit">
            Edit
          </TabsTrigger>
          <TabsTrigger value="chat" data-testid="right-rail-tab-chat">
            Chat
          </TabsTrigger>
          <TabsTrigger
            value="comments"
            data-testid="right-rail-tab-comments"
          >
            Comments
          </TabsTrigger>
          <TabsTrigger value="activity" data-testid="right-rail-tab-activity">
            Activity
          </TabsTrigger>
        </TabsList>
        </div>

        <TabsContent
          value="edit"
          forceMount
          className="min-h-0 flex-1 overflow-hidden data-[state=inactive]:hidden"
        >
          {editing.editorSelection ? (
            <ResizableVerticalSplit
              storageKey="desde.editor.edit-layers-split.v1"
              defaultRatio={0.45}
              top={layersPanel}
              bottom={inspectorPanel}
            />
          ) : (
            layersPanel
          )}
        </TabsContent>

        <TabsContent
          value="chat"
          forceMount
          className="min-h-0 flex-1 overflow-hidden px-3 data-[state=inactive]:hidden"
        >
          <EditorChatPanel
            chat={chat}
            selection={editing.editorSelection}
            selectionMany={selectionMany ?? undefined}
            onClearSelection={editing.handleClearSelection}
            modelPicker={modelPicker}
            currentSessionId={
              chatSessions.enabled ? chatSessions.currentSessionId : undefined
            }
            draftCache={chatSessions.enabled ? draftCache : undefined}
            tabs={chatTabs}
          />
        </TabsContent>

        <TabsContent
          value="comments"
          forceMount
          className="min-h-0 flex-1 overflow-hidden px-3 data-[state=inactive]:hidden"
        >
          <CommentsPanel
            iframeRef={iframeRef}
            commentBridge={commentBridge}
            commentSync={commentSync}
            onCommentModeChange={onCommentModeChange}
            onPinClicked={onCommentPinClicked}
            onEscalateToChat={onEscalateToChat}
            // Keep the container active even when the tab isn't visible
            // so the note bridge can listen for pin clicks (the surface-
            // level auto-switch needs that signal) and so a fresh sync
            // goes through as soon as comments load.
            enabled
          />
        </TabsContent>

        <TabsContent
          value="activity"
          forceMount
          className="min-h-0 flex-1 overflow-hidden px-3 data-[state=inactive]:hidden"
        >
          <ActivityPanel
            changes={branches?.changes}
            rows={ledger.rows}
            ledgerLoading={ledger.loading}
            ledgerError={ledger.error}
            undo={handleLedgerUndo}
          />
        </TabsContent>
      </Tabs>
    </>
  )
}

/**
 * Fetch a session's persisted transcript and hand it to
 * `chat.hydrateFromTranscript`. Fire-and-forget — caller threads in an
 * AbortController so rapid tab switches short-circuit stale responses
 * before they touch `chat`.
 *
 * PR1 multi-session bucketing: writes are scoped to `sessionId`'s
 * bucket via the explicit second arg, so a late response that resolves
 * after the user switched to a different tab can't clobber the wrong
 * bucket. On failure we leave the bucket untouched (empty bucket → the
 * pane renders empty) instead of clearing — clearing was a single-
 * track guard against showing the prior session's messages, no longer
 * needed now that buckets isolate per-session state.
 */
async function hydrateChatFromSession(
  sessionId: string,
  chat: ChatApi,
  signal: AbortSignal,
): Promise<void> {
  try {
    const res = await editorFetch(
      `/api/editor/chat/sessions/${encodeURIComponent(sessionId)}`,
      { method: "GET", signal },
    )
    if (signal.aborted) return
    if (!res.ok) return
    const body = (await res.json()) as
      | { ok: true; session: ChatSession }
      | { ok: false; reason: string }
    if (signal.aborted) return
    if (!body.ok) return
    chat.hydrateFromTranscript(body.session.turns, sessionId)
    chat.seedModelConfig(sessionId, body.session.modelConfig ?? null)
  } catch (err) {
    if (signal.aborted) return
    if (err instanceof DOMException && err.name === "AbortError") return
    // Swallow — empty bucket is a fine fallback; the user can retry
    // by switching away and back.
  }
}
