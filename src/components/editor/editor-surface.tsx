"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { RefObject } from "react"
import { toast } from "sonner"
import type { Selection } from "@/editor/core"
import { RemoteManifestSource } from "@/editor/adapters/remote"
import { BannerToasts } from "@/components/editor/banner-toasts"
import { EditorNavBar } from "@/components/editor/editor-nav-bar"
import {
  EditorToolbar,
  type EditorView,
  type CanvasMode,
} from "@/components/editor/editor-toolbar"
import type { SegmentedToggleOption } from "@/components/editor/segmented-toggle"
import type { ActiveBreakpoint } from "@/components/editor/tailwind-classes"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { Minimize2 } from "lucide-react"
import {
  EditorRightRail,
  type RightRailTab,
} from "@/components/editor/editor-right-rail"
import { ResizableRail } from "@/components/editor/resizable-rail"
import { EditorCanvasSurface } from "@/components/editor/editor-canvas-surface"
import { useLocalCanvases } from "@/hooks/useLocalCanvases"
import { createHttpScreenshotPlanStore } from "@/services/artifact-stores"
import { LivePrototypePane } from "@/components/editor/live-prototype-pane"
import { FileEditorPane } from "@/components/editor/file-editor-pane"
import { useElementContextMenu } from "@/hooks/useElementContextMenu"
import { ElementContextMenu } from "@/components/editor/element-context-menu"
import { SaveProgressDialog } from "@/components/editor/save-progress-dialog"
import { SwapDialog } from "@/components/editor/swap-dialog"
import { DeleteScopeDialog } from "@/components/editor/delete-scope-dialog"
import {
  IterationScopeDialog,
} from "@/components/editor/iteration-scope-dialog"
import { MutationDisambiguationDialog } from "@/components/editor/mutation-disambiguation-dialog"
import { useEditorEditing } from "@/hooks/useEditorEditing"
import { useEditorChat } from "@/hooks/useEditorChat"
import { useChatSessions } from "@/hooks/useChatSessions"
import { useShellBridgePoll } from "@/hooks/useShellBridgePoll"
import { useIframeScreenshotCapture } from "@/hooks/useIframeScreenshotCapture"
import { useIframeSemanticTarget } from "@/hooks/useIframeSemanticTarget"
import {
  runScreenshotPlanReplay,
  type ScreenshotPlanReplayResult,
} from "@/editor/replay/screenshot-plan-replay"
import type { ScreenshotPlan } from "@/editor/core"
import { useIframeReadRenderedValue } from "@/hooks/useIframeReadRenderedValue"
import { useIframeReadMeasurements } from "@/hooks/useIframeReadMeasurements"
import { useEditorBridgeHandlers } from "@/hooks/useEditorBridgeHandlers"
import { useEditorPinnedSelection } from "@/hooks/useEditorPinnedSelection"
import { useEditorBranches } from "@/hooks/useEditorBranches"
import { useEditorCommentStore } from "@/hooks/useEditorCommentStore"
import { useEditorCommentBridge } from "@/hooks/useEditorCommentBridge"
import { changeToolMode } from "@/components/editor/change-tool-mode"
import { useEditorToolMode } from "@/hooks/useEditorToolMode"
import { useStickyCommentPlacement } from "@/hooks/useStickyCommentPlacement"
import type { EditorToolMode } from "@/stores/tool-mode-slice"
import { useTableEdgeMenu } from "@/hooks/useTableEdgeMenu"
import { TableEdgeMenu } from "@/components/editor/table-edge-menu"
import { ChatPendingQuestion } from "@/components/editor/chat-pending-question"
import { buildSessionCompletionToasts } from "@/components/editor/session-completion-toasts"
import { useEditorStore } from "@/stores/editor-only"
import { useAppStore } from "@/stores"
import {
  EDITOR_CANVAS,
  EDITOR_CODE_VIEW,
  EDITOR_VSCODE_LINK,
  EDITOR_DETACHED_SESSIONS,
  EDITOR_FRAMEWORK,
  EDITOR_LANE_SWAP,
} from "@/lib/editor-feature-flags"

/**
 * Preview widths (px) the global breakpoint control enforces. Each is the
 * Tailwind default min-width for that breakpoint, so constraining the
 * preview to it renders the prototype's own `{bp}:` responsive CSS. `base`
 * = unconstrained (full width).
 */
const BREAKPOINT_WIDTHS: Record<Exclude<ActiveBreakpoint, "base">, number> = {
  sm: 640,
  md: 768,
  lg: 1024,
  xl: 1280,
  "2xl": 1536,
}

const BREAKPOINT_OPTIONS: ReadonlyArray<SegmentedToggleOption<ActiveBreakpoint>> = [
  { value: "base", label: "Auto" },
  { value: "sm", label: "sm" },
  { value: "md", label: "md" },
  { value: "lg", label: "lg" },
  { value: "xl", label: "xl" },
  { value: "2xl", label: "2xl" },
]

interface EditorSurfaceProps {
  prototypeUrl: string
  /**
   * If provided, the surface attaches to this externally-owned iframe
   * instead of rendering its own `<LivePrototypePane>`. The project
   * route uses this to share a single iframe between browse and
   * compose modes (no reload on toggle). When omitted, the surface
   * renders its own iframe via LivePrototypePane and works as a
   * standalone page (used by `/compose?url=…`).
   */
  externalIframeRef?: RefObject<HTMLIFrameElement | null>
  /**
   * Phase 1c: when provided, the toolbar renders an exit-compose
   * X button. The project route uses this so the user can drop
   * out of compose mode back into browse mode; the standalone
   * `/compose?url=…` page omits it (nothing to exit back to).
   */
  onExitCompose?: () => void
}

/**
 * The editor's editing chrome: layers tree (left), prototype iframe
 * (center), inspector / pending-changes (right). Hosts the adapter
 * wiring (via `useEditorEditing`), edit dispatch, and DOM-edit
 * mutation log.
 */
export function EditorSurface({
  prototypeUrl,
  externalIframeRef,
  onExitCompose,
}: EditorSurfaceProps) {
  const internalIframeRef = useRef<HTMLIFrameElement | null>(null)
  const iframeRef = externalIframeRef ?? internalIframeRef

  // Branch-mode branch management. Switching/creating a branch changes the
  // working-tree files under the same URL, so reload the iframe to render
  // the new branch.
  const branches = useEditorBranches(
    useCallback(() => {
      const el = iframeRef.current
      if (el) el.src = el.src
    }, [iframeRef]),
  )
  // Production manifest pipeline: RemoteManifestSource proxies to the
  // server-side composite (LocalVue + Storybook + Acme DS).
  const manifestSource = useMemo(
    () => new RemoteManifestSource({ endpoint: "/api/editor/manifest" }),
    [],
  )

  // Declared here (ahead of `editing`) so the escalate-to-chat callback
  // below can flip the view back to the editor before submitting.
  const [view, setView] = useState<EditorView>("editor")
  // Canvas + screenshot-plan surface — dormant by product decision
  // 2026-08-04 (undertested; flip `editor.canvas: true` in
  // .desde/config.json, or EDITOR_CANVAS=1, to restore).
  // Guard every path that could set `view` to "canvas" — including a
  // future persisted/initial value — so a disabled flag can never leave
  // the workspace on an unreachable blank canvas view.
  const setViewGuarded = useCallback((next: EditorView) => {
    setView(next === "canvas" && !EDITOR_CANVAS ? "editor" : next)
  }, [])
  // Focus mode: when true, all editor chrome (workspace header, floating
  // tool cluster, right rail) is hidden so the prototype container fills the
  // viewport. A single floating button in the top-right corner restores it.
  const [chromeHidden, setChromeHidden] = useState(false)
  // In-app code editor — set when the user picks "Open in editor" from
  // the element context menu. Cleared on exit. The view machine routes
  // off this: when non-null, `view` is set to "file-editor".
  const [openFile, setOpenFile] = useState<{
    filePath: string
    line?: number
    column?: number
  } | null>(null)
  // In-app code view — dormant by product decision 2026-08-14 (flip
  // `editor.codeView: true` in .desde/config.json, or
  // EDITOR_CODE_VIEW=1, to restore). This early return is the same
  // defence `setViewGuarded` gives the canvas: the offering below is
  // already withheld, so nothing should reach here, and if anything ever
  // does the view must not land on a pane the CLI refuses to feed.
  const handleOpenFileEditor = useCallback(
    (target: { filePath: string; line?: number; column?: number }) => {
      if (!EDITOR_CODE_VIEW) return
      setOpenFile(target)
      setView("file-editor")
    },
    [],
  )
  const handleCloseFileEditor = useCallback(() => {
    setOpenFile(null)
    setView("editor")
  }, [])
  // Wire the bridge's ELEMENT_CONTEXT_MENU → open the menu. Mounted at
  // the surface level so the menu's anchor coordinates translate
  // through the iframe's bounding rect (same pattern as table-edge).
  const elementContextMenu = useElementContextMenu({
    iframeRef,
    // Only listen when the prototype is the foreground view — in
    // file-editor mode the iframe is hidden and CM6 has its own
    // contextmenu inside the editor area.
    active: view === "editor",
  })

  // Escalate-to-chat bridge. A direct-manipulation edit the deterministic
  // lane can't apply (`'chat'` fallback mode → `needsChat`) is handed to
  // the chat agent instead of the in-modal LLM lane. `editing` is created
  // before `chat`, so the submit fn is reached through a ref populated once
  // `chat` exists (below).
  const chatSubmitRef = useRef<((message: string) => Promise<void>) | null>(
    null,
  )
  // Right-rail active tab. Declared here (ahead of `editing`) so the
  // escalate-to-chat callback below can flip the rail to the Chat
  // tab — the escape hatch is initiated from the Activity tab, so without
  // this the prompt would submit while the chat panel stays hidden. Phase
  // 1c has no automatic background switches otherwise; every other tab
  // change is user-initiated (clicking the tab, or a Commit/Push count
  // badge that routes to Activity).
  const [activeTab, setActiveTab] = useState<RightRailTab>("edit")
  const handleEditEscalation = useCallback(
    (prompt: string): boolean => {
      const submit = chatSubmitRef.current
      if (!submit) return false
      setView("editor")
      // Reveal the chat rail — the escape hatch can be fired from the
      // Activity tab, where the chat panel is hidden.
      setActiveTab("chat")
      void submit(prompt)
      toast.message("Sent this edit to chat", {
        description: "The assistant will read the file and apply it.",
      })
      return true
    },
    [],
  )

  const editing = useEditorEditing({
    iframeRef,
    prototypeUrl,
    enabled: true,
    manifestSource,
    escalateToChat: handleEditEscalation,
  })
  // Subscribe directly to the multi-select slice so the chat header
  // updates live; `useEditorEditing` only tracks the primary
  // selection.
  const editorSelectionMany = useEditorStore((s) => s.editorSelectionMany)

  // Phase 1c shell state. The CLI lands users in Editor view + Navigate
  // mode (clicks navigate the prototype, the inspector overlay is off).
  // Navigate/Select/Comment is ONE value on the store now, not a local
  // `iframeMode` state beside a `commentMode` flag; see
  // `src/stores/tool-mode-slice.ts` for why. The hook that owns it is
  // mounted further down, after the comment bridge it drives.
  const [canvasMode, setCanvasMode] = useState<CanvasMode>("read")
  // Global responsive breakpoint. `base` = full-width preview (current
  // behavior); a named breakpoint constrains the preview to that width so
  // the prototype's own responsive CSS renders there, and the inspector
  // reads & writes that breakpoint's classes.
  const [activeBreakpoint, setActiveBreakpoint] =
    useState<ActiveBreakpoint>("base")

  // Pulled out of `editing` rather than read through it: `useEditorEditing`
  // returns a fresh object on every render, and this member is now upstream
  // of the Comments tab's memo (through `handleCommentModeChange` below).
  // Inside that hook `setEditorActive` is a `useCallback(…, [])`, so the
  // extracted reference is stable and everything downstream of it stays
  // stable too. Also consumed by the handshake effect further down.
  const setEditorActive = editing.setEditorActive

  // Right-rail tab change (user click on a TabsTrigger or upstream
  // signal). Phase 1c is a thin pass-through; Phase 2 will branch
  // on "user click vs auto-switch" once context-aware opening
  // arrives.
  const handleTabChange = useCallback((next: RightRailTab) => {
    setActiveTab(next)
  }, [])

  // Phase 2: a comment pin click inside the iframe auto-opens the
  // Comments tab so the user's thread surfaces alongside the
  // popup (which the bridge already places at the pin via slice
  // state). Context-aware default opening per the architecture doc.
  const handleCommentPinClicked = useCallback(() => {
    // Comment or note — both flip the right rail to Comments.
    // `id` and `kind` are intentionally unused at v1; the merged
    // panel + slice mutual exclusivity handle the per-kind activation.
    setActiveTab("comments")
  }, [])

  // ── Comment mode, owned here ─────────────────────────────────────
  // The comment store and the comment bridge are mounted at the surface
  // rather than inside the Comments tab, because the toolbar's Comment
  // button and the panel's Comment button must drive the SAME instances.
  // A second `useEditorCommentBridge` would register a second window
  // message listener and double-handle every COMMENT_PIN_CLICKED and
  // NEW_COMMENT_POSITION; a second `useEditorCommentStore` would mount a
  // second `useViewerAuthStatus` and refetch `/api/editor/viewer-auth`.
  // Both results are memoized at their source, which keeps the memo on
  // `CommentsPanel` doing its job.
  //
  // Consequence worth knowing: the comment bridge now outlives the right
  // rail, so pin clicks and comment syncing keep working in Canvas view
  // and focus mode, where the rail unmounts.
  const commentSync = useEditorCommentStore()
  const commentBridge = useEditorCommentBridge(iframeRef, {
    enabled: true,
    onPinClicked: handleCommentPinClicked,
  })
  // Destructured so the two callbacks below depend on the individual
  // functions rather than on the whole bridge object. `bridgeReadyEpoch` and
  // `offTargetCommentIds` move on bridge events; rebuilding these handlers
  // for those would re-render the memoized Comments tab for no reason.
  const { enterCommentMode, exitCommentMode } = commentBridge
  const { resolving: commentSyncResolving, resolveFailed: commentSyncResolveFailed } =
    commentSync

  // ── The prototype's one active tool ──────────────────────────────
  // Navigate, Select and Comment are three values of one mode, so the
  // toolbar's tool picker and the Comments panel's button are reading and
  // writing the same thing. `requestToolMode` is what posts the bridge
  // messages the new mode implies.
  const { toolMode, requestToolMode, syncToolModeToBridge } = useEditorToolMode({
    setEditorActive,
    enterCommentMode,
    exitCommentMode,
  })
  // The CLI lands users in Navigate mode. That used to be free, because the
  // mode was local state that died with the surface; on the store it would
  // otherwise survive a remount and open the workspace mid-placement.
  // Store write only: the freshly mounted iframe has no bridge yet, and the
  // handshake effect below states the mode once there is one.
  useEffect(() => {
    useAppStore.getState().setToolMode("navigate")
  }, [])
  // Every tool change in the workspace lands here, from the toolbar's picker,
  // from the Comments panel's button and from entering focus mode alike, so
  // neither the refusal nor the composer close can apply to one and not the
  // others. The policy itself lives in `changeToolMode` so it is testable
  // without mounting this component.
  const handleToolModeChange = useCallback(
    (next: EditorToolMode) => {
      changeToolMode(next, {
        resolving: commentSyncResolving,
        resolveFailed: commentSyncResolveFailed,
        setToolMode: requestToolMode,
        closeNewCommentComposer: () =>
          useAppStore.getState().setPendingPosition(null),
      })
    },
    [commentSyncResolving, commentSyncResolveFailed, requestToolMode],
  )
  // The Comments panel's button is a two-state toggle rather than a picker,
  // so it gets a boolean adapter over the same handler. Turning it off returns
  // the prototype to Navigate, which is what "stop commenting" means.
  const handleCommentModeChange = useCallback(
    (next: boolean) => {
      handleToolModeChange(next ? "comment" : "navigate")
    },
    [handleToolModeChange],
  )
  // Focus mode puts the tool down, for both Select and Comment.
  //
  // Every tool needs the chrome to finish what it starts: the picker that
  // chooses it is in the toolbar, Select's readout is the right rail's
  // inspector, and Comment's is the composer that `CommentThreadPopup` mounts
  // inside that same rail. Focus mode unmounts all of it, so a tool left armed
  // there is a control with no output. Comment was the harmful case: the
  // bridge un-arms itself on a pin and the shell re-arms it when the composer
  // closes, so a pin landing with no composer mounted stranded `toolMode` on
  // `comment` against an un-armed bridge with nothing able to close it. That
  // window is what `tool-mode-slice.ts` claims is bounded by the composer's
  // lifetime, and it was not.
  //
  // The fix makes the precondition true rather than the claim weaker: hiding
  // the chrome drops to Navigate through the normal path, so the bridge is
  // disarmed as well as the flag cleared, and no pin can land while there is
  // nothing to receive it. Select goes with it, for the same reason and to
  // keep one rule for the whole picker. The tool is NOT restored when the
  // chrome comes back: remembering it would be a second, invisible copy of
  // the mode, and picking a tool again is one click.
  const handleHideChrome = useCallback(() => {
    handleToolModeChange("navigate")
    setChromeHidden(true)
  }, [handleToolModeChange])

  // Leaving the editor view puts the tool down for the same reason focus mode
  // does, and it is the same hazard: `showRightRail` is
  // `view === "editor" && !chromeHidden`, so a view switch unmounts the rail
  // exactly as hiding the chrome does. A tool left armed with no rail is a
  // control with no output, and for Comment specifically it strands the
  // sticky window: a pin could land with no composer mounted to close, so
  // nothing would ever re-arm the bridge.
  //
  // Unreachable today, because both other views are behind default-off flags
  // (EDITOR_CANVAS, EDITOR_CODE_VIEW). Written now anyway: the fix for focus
  // mode would otherwise have to be rediscovered the day either flag flips,
  // and the person flipping it will be thinking about that surface, not about
  // comment placement.
  const handleViewChange = useCallback(
    (next: EditorView) => {
      if (next !== "editor") handleToolModeChange("navigate")
      setViewGuarded(next)
    },
    [handleToolModeChange, setViewGuarded],
  )

  // Keep the bridge in the mode the shell is showing. A reloaded iframe
  // brings up a fresh bridge with no inspector overlay and no placement
  // overlay, so the handshake is where the current mode has to be stated
  // again. Re-running on a mode change as well is harmless: every message
  // `applyToolMode` sends is idempotent.
  //
  // `bridgeReadyEpoch` is in the deps, not just the status kind. The status
  // does not necessarily leave "ready" across a reload, and a mode that is
  // never re-stated is a shell claiming a mode the new bridge never entered.
  // The epoch counts BRIDGE_READY messages, so it moves on every handshake.
  //
  // The ONE thing it must not re-state is comment placement underneath an
  // open new-comment composer. `pendingPosition` non-null means the user is
  // typing, and the sticky design's safety claim is that placement is not
  // armed for that whole window (see `useStickyCommentPlacement`). An iframe
  // reload mid-compose — the agent edits a file, Vite reloads — is a
  // handshake, so without this guard the claim would be false exactly when a
  // stray click is most likely. Skipping is safe rather than lossy: the
  // composer closing is itself the re-arm edge, so the mode converges one
  // event later.
  const bridgeStatusKind = editing.status?.kind
  const bridgeReadyEpoch = commentBridge.bridgeReadyEpoch
  useEffect(() => {
    if (bridgeStatusKind !== "ready") return
    if (toolMode === "comment" && useAppStore.getState().pendingPosition !== null) {
      return
    }
    syncToolModeToBridge()
  }, [bridgeStatusKind, bridgeReadyEpoch, syncToolModeToBridge, toolMode])

  // Sticky comment placement: the Comment tool survives a placed pin, and the
  // bridge is re-armed when that pin's composer closes. See the hook for why
  // the re-arm hangs off the composer closing rather than off the pin landing.
  useStickyCommentPlacement(syncToolModeToBridge)

  // Live-route mirroring (current-page slice + shell address bar) and the
  // pinned-selection re-anchor machinery both hang off the bridge's
  // ROUTE_CHANGED — extracted together into their own hook (Task 21).
  // `onReAnchorToSession` is handed to the right rail's session detail panel.
  const { onReAnchorToSession } = useEditorPinnedSelection({
    iframeRef,
    prototypeUrl,
    selectBySelector: editing.handleLayerSelect,
  })

  // Screenshot capture over the prototype iframe (Phase 2 visualizer) —
  // drives the bridge's existing CAPTURE_ELEMENT_SCREENSHOT round-trip.
  const captureScreenshot = useIframeScreenshotCapture(iframeRef)
  const semanticTarget = useIframeSemanticTarget(iframeRef)

  // Rendered-value read over the prototype iframe (self-correct loop, Phase 1)
  // — drives the bridge's existing READ_RENDERED_VALUE round-trip so the
  // agent's `verify_edit` tool can confirm an edit took effect in the live DOM.
  const readRenderedValue = useIframeReadRenderedValue(iframeRef)

  // Measurement read over the prototype iframe (verify_goal / L3a) — drives the
  // bridge's READ_MEASUREMENTS round-trip so the agent's `verify_goal` tool can
  // judge a fuzzy layout goal against deterministic predicates.
  const readMeasurements = useIframeReadMeasurements(iframeRef)

  // Chat bridge handlers — each `chat:*` messageType the orchestrator
  // can ask for is resolved here, shell-side (`get_selection` reads the
  // Zustand store, `get_page_info` synthesizes from the live route slice,
  // `capture_screenshot` round-trips to the iframe bridge, `navigate` drives
  // the iframe, `ask_user_question` parks a promise for the inline choice UI
  // rendered below). Extracted to its own hook in Task 21 — see
  // useEditorBridgeHandlers for the per-handler dependency rationale and
  // why `chat:navigate` keeps its own load-gate machinery.
  const { bridgeHandlers, pendingQuestion } = useEditorBridgeHandlers({
    iframeRef,
    prototypeUrl,
    editorSelection: editing.editorSelection,
    supportsRenderedValueRead: editing.supportsRenderedValueRead,
    supportsMeasurementsRead: editing.supportsMeasurementsRead,
    selectMany: editing.handleSelectMany,
    captureScreenshot,
    semanticTarget,
    readRenderedValue,
    readMeasurements,
  })
  // Deterministic screenshot-plan replay (editor-screenshot-flows.md
  // Phase 1b). Reuses the SAME shell bridge primitives the agent's
  // navigate + capture_screenshot tools use — but driven from a plain
  // loop, no agent, no LLM. Consumed by the on-canvas "generate a flow"
  // orchestration below (`onCanvasFlowTurnComplete`).
  const replayScreenshotPlan = useCallback(
    async (
      plan: ScreenshotPlan,
      replayOpts?: {
        onProgress?: (done: number, total: number) => void
        signal?: AbortSignal
      },
    ): Promise<ScreenshotPlanReplayResult> => {
      const signal = replayOpts?.signal ?? new AbortController().signal
      // Remember where the user was, to restore after the snapshot run
      // (the iframe visibly flips through every page during replay).
      const startUrl = useAppStore.getState().currentPageUrl ?? iframeRef.current?.src ?? null
      const result = await runScreenshotPlanReplay(plan, {
        signal,
        onProgress: replayOpts?.onProgress,
        navigate: async (route, sig) => {
          const res = await bridgeHandlers["chat:navigate"]({ route }, sig)
          return res.ok ? { ok: true } : { ok: false, error: res.error }
        },
        capture: async (spec, sig) => {
          // Honor selector-scoped capture steps — a `scope:'selector'` step
          // must screenshot that element, not silently fall back to viewport.
          const scopeArg =
            spec.scope === "selector" && spec.selector
              ? { scope: "selector" as const, selector: spec.selector }
              : { scope: "viewport" as const }
          const res = await bridgeHandlers["chat:capture_screenshot"](scopeArg, sig)
          return res.ok
            ? (res.output as { dataUrl: string; width: number; height: number })
            : null
        },
        interact: async (step, sig) => {
          // Resolve the step's semantic target (the cheap validity gate), then
          // act. A miss → needsHeal so replay stops for the Phase-4 healer.
          const t = step.target
          if (!t) return { ok: false, error: "interact step has no target" }
          const resolved = await semanticTarget.resolveTarget(
            { role: t.role, name: t.name, text: t.text, selector: t.resolvedSelector },
            sig,
          )
          if (!resolved?.found || !resolved.selector) {
            return { ok: false, needsHeal: true }
          }
          const outcome = await semanticTarget.performInteract(
            {
              selector: resolved.selector,
              action: step.action ?? "click",
              value: step.value,
            },
            sig,
          )
          return {
            ok: outcome?.ok === true,
            resolvedSelector: resolved.selector,
            error: outcome?.error,
          }
        },
      })
      // Best-effort restore of the user's original page.
      if (startUrl && !signal.aborted) {
        await bridgeHandlers["chat:navigate"]({ route: startUrl }, signal).catch(
          () => {},
        )
      }
      return result
    },
    [bridgeHandlers, semanticTarget, iframeRef],
  )

  // ── On-canvas "generate a flow" orchestration (editor-screenshot-flows.md
  // canvas integration). A prompt typed on the canvas → the agent generates a
  // screenshot PLAN (it decides which screens; Phase 3) → the shell replays the
  // plan deterministically to capture real screenshots (Phase 1b/2) → those
  // land on the prompting canvas as frames + auto-arrows (canvas foundation).
  const setActiveCanvasId = useAppStore((s) => s.setActiveCanvasId)
  const planStore = useMemo(() => createHttpScreenshotPlanStore(), [])
  const canvases = useLocalCanvases({ enabled: EDITOR_CANVAS })
  const [generatingCanvasFlow, setGeneratingCanvasFlow] = useState(false)
  const pendingCanvasFlowRef = useRef<{
    canvasId: string
    planIdsBefore: Set<string>
  } | null>(null)

  const generateFlowOntoCanvas = useCallback(
    async (prompt: string, canvasId: string): Promise<void> => {
      // Dormant by default (2026-08-04) — see EDITOR_CANVAS. The canvas
      // surface that invokes this is itself gated behind the flag, but
      // guard here too so the orchestration never does real work when off.
      if (!EDITOR_CANVAS) return
      const submit = chatSubmitRef.current
      if (!submit) {
        toast.error("Chat isn't ready yet.")
        return
      }
      try {
        const before = await planStore.list()
        pendingCanvasFlowRef.current = {
          canvasId,
          planIdsBefore: new Set(before.map((p) => p.id)),
        }
        setGeneratingCanvasFlow(true)
        await submit(
          `Build a screenshot flow for this request, then save it with save_screenshot_plan: ${prompt}\n\n` +
            `Walk the flow live: decide which screens matter, navigate/interact to reach each, and add a capture step per screen. Don't add it to a canvas yourself; just save the plan.`,
        )
      } catch (err) {
        pendingCanvasFlowRef.current = null
        setGeneratingCanvasFlow(false)
        toast.error(`Couldn't start the flow: ${(err as Error).message}`)
      }
    },
    [planStore],
  )

  const onCanvasFlowTurnComplete = useCallback(async () => {
    // Dormant by default (2026-08-04) — see EDITOR_CANVAS. This runs on
    // every chat turn completion regardless of view, so guard explicitly
    // rather than relying on `pendingCanvasFlowRef` staying empty.
    if (!EDITOR_CANVAS) return
    const pending = pendingCanvasFlowRef.current
    if (!pending) return
    pendingCanvasFlowRef.current = null
    try {
      // The plan the agent just saved = the one that wasn't there before.
      const after = await planStore.list()
      const fresh = after.find((p) => !pending.planIdsBefore.has(p.id))
      if (!fresh) {
        toast.message("No screenshot flow was generated for that prompt.")
        return
      }
      const plan = await planStore.get(fresh.id)
      if (!plan) return
      // Deterministically replay the plan to capture real screenshots.
      const result = await replayScreenshotPlan(plan)
      // Replay stops at the first interact step whose target no longer
      // resolves, leaving `needsHeal` set even when earlier steps DID capture
      // screenshots. Don't persist that partial run as a finished flow — a
      // truncated canvas mislabeled "done" hides the break. Surface the broken
      // step so the user can heal it (the agent's heal_plan_step tool) and
      // re-run. Checked BEFORE the zero-screenshots guard so a partial run with
      // some captures still routes here.
      if (result.needsHeal) {
        toast.warning(
          `Flow stopped at "${result.needsHeal.intent}": that step needs healing before the screenshots are complete.`,
        )
        return
      }
      if (result.screenshots.length === 0) {
        toast.error("The flow produced no screenshots (the steps may not resolve).")
        return
      }
      await planStore.saveScreenshots(plan.id, result.screenshots)
      const targetId = await canvases.addScreenshotPlanToCanvas(
        plan,
        result.screenshots,
        { canvasId: pending.canvasId },
      )
      if (targetId) {
        setActiveCanvasId(targetId)
        await canvases.loadCanvas(targetId)
        setViewGuarded("canvas")
        // A replay can finish with some screenshots AND non-fatal step errors
        // (a navigate with no route, a capture timeout) without tripping
        // `needsHeal` — those steps are skipped and the run continues. Don't
        // report that as an unqualified success: surface the error count so a
        // partial/incomplete canvas isn't mistaken for a finished one.
        if (result.errors.length > 0) {
          toast.warning(
            `Added ${result.screenshots.length} screens, but ${result.errors.length} step(s) had problems (e.g. ${result.errors[0].message}). The canvas may be incomplete.`,
          )
        } else {
          toast.success(`Added ${result.screenshots.length} screens to the canvas.`)
        }
      }
    } catch (err) {
      toast.error(`Flow → canvas failed: ${(err as Error).message}`)
    } finally {
      setGeneratingCanvasFlow(false)
    }
  }, [planStore, replayScreenshotPlan, canvases, setActiveCanvasId, setViewGuarded])

  // Computed once per render for the chip + the snapshot. Kept here
  // (not memoized) so a navigation outside React's state still re-runs
  // the chip; useEditorChat captures the latest snapshot ref at
  // submit time.
  const pageRoute = useMemo(() => {
    try {
      const u = new URL(prototypeUrl)
      return u.pathname + u.hash
    } catch {
      return prototypeUrl
    }
  }, [prototypeUrl])
  // Live route (pathname + hash) for capture-time consumers like the
  // "Screenshot → canvas" button. `pageRoute` is derived from the iframe's
  // INITIAL `prototypeUrl`, so after in-iframe navigation it points at the
  // wrong page; prefer the bridge's last-reported URL, falling back to
  // `pageRoute` before any ROUTE_CHANGED has landed.
  const liveCurrentPageUrl = useAppStore((s) => s.currentPageUrl)
  const liveCaptureRoute = useMemo(() => {
    if (!liveCurrentPageUrl) return pageRoute
    try {
      const u = new URL(liveCurrentPageUrl)
      // Include the query string: a query-dependent route (`/search?q=abc`)
      // is a distinct page state, so dropping it would mislabel the frame and
      // point a later navigation/replay at the wrong page.
      return u.pathname + u.search + u.hash
    } catch {
      return pageRoute
    }
  }, [liveCurrentPageUrl, pageRoute])
  // Stable ref so the chat hook's gate closure always sees the live
  // session state without re-creating the hook on every status change.
  // Sync via effect (not during render) so concurrent renders that
  // get discarded don't write a stale value into the ref.
  // Always-on long-poll bridge so the `desde-mcp` proxy
  // can hit `get_selection` / `get_page_info` / `pin_selections` from
  // a `claude` CLI session even when no chat turn is in flight. Same
  // handler map as the chat-turn bridge — no duplication.
  useShellBridgePoll(bridgeHandlers)

  // Multi-session chat tracking (tab strip, + New, per-session drafts,
  // completion toasts). Branch mode edits are always live, so this is on
  // as soon as the `EDITOR_DETACHED_SESSIONS` flag allows. This also
  // drives the chat hook's bucket re-key (`getSessionReKeyEnabled` below):
  // when tracking is on, `onSessionEvent` moves the visible pointer to the
  // server-minted id, so the re-key is safe; when off, it would orphan the
  // SOLO_BUCKET and blank the chat.
  const detachedSessionsActive = EDITOR_DETACHED_SESSIONS
  const chatSessions = useChatSessions({
    // Phase 5 of tasks/editor-detached-sessions.md — gate the tab
    // strip UI + toast-on-completion behind the
    // `EDITOR_DETACHED_SESSIONS` flag. The CLI bootstrap sets it
    // from `chat.detachedSessions` in
    // `desde.config.json` (default true). Disabling
    // hides the tab strip; the panel behaves as a single default
    // chat (the SOLO_BUCKET) instead.
    enabled: detachedSessionsActive,
    // Phase 5 of tasks/editor-detached-sessions.md — surface
    // background-session completions as sonner toasts. The hook
    // debounces a 1s window; `buildSessionCompletionToasts` owns the
    // copy and the collapse rule (see session-completion-toasts.ts).
    // Sonner renders title/description as React children (text, not
    // HTML), so there is no XSS surface in the reason text.
    onSessionTransition: (transitions) => {
      for (const t of buildSessionCompletionToasts(transitions)) {
        toast[t.level](t.title, { description: t.description })
      }
    },
  })

  const chat = useEditorChat({
    bridgeHandlers,
    onEditProposed: editing.applyAgentProposal,
    onTurnComplete: () => {
      editing.handleChatTurnComplete()
      void onCanvasFlowTurnComplete()
    },
    // Codex round-1 #4: refresh the sessions listing AFTER the stream
    // closes — by then the route handler's `saveSession` has run.
    // Refreshing on `onTurnComplete` would race that and could miss
    // the just-completed turn.
    onStreamComplete: chatSessions.onStreamComplete,
    getChatSessionId: chatSessions.getChatSessionId,
    // PR1 multi-session bucketing — exposes the visible session so the
    // chat hook's `messages`/`submitting` getters slice the right
    // per-session bucket while SSE events from background streams keep
    // landing in their own buckets.
    getVisibleSessionId: chatSessions.getChatSessionId,
    onSessionEvent: chatSessions.onSessionEvent,
    // Only re-key the active bucket to the server-minted sessionId when
    // multi-session tracking is live — otherwise `onSessionEvent` never
    // moves the visible pointer and the re-key would blank the chat
    // (solo/branch mode). See useEditorChat's `getSessionReKeyEnabled`.
    getSessionReKeyEnabled: () => detachedSessionsActive,
    getCurrentSnapshot: () => {
      const sel = editing.editorSelection
      // Pull the live route + source file the bridge last reported via
      // ROUTE_CHANGED. The `prototypeUrl` prop is the iframe's initial
      // load only; cross-origin SPA navs aren't visible to the shell,
      // so reading the prop would send a stale URL to the agent on
      // every no-selection prompt issued after the user navigated.
      const live = useAppStore.getState()
      return {
        selection: sel
          ? {
              selector: sel.selector,
              componentName: sel.componentName,
              componentFile: sel.componentFile,
              editTarget: sel.editTarget,
              packageName: sel.packageName,
              classes: sel.classes,
            }
          : undefined,
        page: {
          url: live.currentPageUrl ?? prototypeUrl,
          route: live.currentDisplayRoute ?? pageRoute,
          framework: EDITOR_FRAMEWORK,
          title: typeof document !== "undefined" ? document.title : undefined,
          sourceFile: live.currentSourceFile ?? undefined,
        },
      }
    },
  })

  // Programmatic chat submits (table-edge actions, escalate-to-chat) auto-
  // fork into a fresh session when the current one is mid-stream. The
  // server enforces a per-session in-flight lock and would otherwise
  // return 409; forking lets the prior chat keep running in its own tab
  // while the new action gets a dedicated one. The typed-input path
  // doesn't go through this wrapper — it's already disabled while
  // submitting.
  // No-op in legacy mode (chatSessions.currentSessionId stays null when
  // detached-sessions are off, so newSession is a no-op too).
  const submitChatAutoFork = useCallback(
    async (message: string) => {
      if (chat.submitting && chatSessions.currentSessionId !== null) {
        chatSessions.newSession()
        toast.message("Started a new chat for this action", {
          description: "Your previous chat keeps running in its own tab.",
        })
      }
      await chat.submit(message)
    },
    // Member-level deps are deliberate. exhaustive-deps wants the whole
    // `chat` / `chatSessions` objects because it cannot prove the members are
    // stable; depending on `chat` would re-create this callback on every
    // streaming token, since `chat` carries the live turn state. The four
    // members listed ARE the reactive inputs this callback reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      chat.submit,
      chat.submitting,
      chatSessions.currentSessionId,
      chatSessions.newSession,
    ],
  )

  // Keep the escalate-to-chat bridge pointed at the live submit fn so a
  // direct-manipulation edit that needs interpretation lands as a chat
  // turn (see handleEditEscalation above).
  chatSubmitRef.current = submitChatAutoFork

  // Right-click context-menu → "start a chat about this element". Always
  // opens a FRESH session (the entry point's intent is "begin a new chat
  // about this thing"), reveals the chat panel, and submits the prompt.
  // The right-clicked element is already the editor selection — the
  // bridge's contextmenu handler emits ELEMENT_INSPECTED alongside
  // ELEMENT_CONTEXT_MENU — so getCurrentSnapshot() carries it to the
  // agent as selection context.
  const handleStartChatFromElement = useCallback(
    (prompt: string) => {
      const trimmed = prompt.trim()
      if (trimmed.length === 0) return
      // Detached chat sessions off (legacy single-chat mode): newSession()
      // is a no-op, so this would submit into the one shared bucket and
      // `chat.submit` aborts the in-flight controller — silently cancelling
      // a running chat instead of starting a new one. Refuse rather than
      // clobber. `currentSessionId !== null` is the same "detached on"
      // proxy submitChatAutoFork uses; when detached sessions ARE on,
      // newSession() mints a fresh bucket so a concurrent stream is safe.
      if (chatSessions.currentSessionId === null && chat.submitting) {
        toast.error(
          "A chat is already running. Wait for it to finish before starting a new one.",
        )
        return
      }
      setView("editor")
      setActiveTab("chat")
      chatSessions.newSession()
      void chat.submit(trimmed)
    },
    // Same rationale as above: `chat.submit` / `chat.submitting` are the
    // reactive inputs, and depending on the whole `chat` object would rebuild
    // this callback on every streaming token.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [chatSessions, chat.submit, chat.submitting],
  )

  // Google-Docs-style row/column edge actions. Right-clicking the band
  // emitted by the bridge opens a shell context menu whose items submit
  // a structured chat instruction; the agent decides template-vs-data
  // and proposes an overwrite via the existing edit pipeline.
  const tableEdgeMenu = useTableEdgeMenu({
    iframeRef,
    submitChat: submitChatAutoFork,
    // Row/column bands are a Select-mode affordance — never draw them
    // while the user is navigating the prototype or placing comments.
    active: toolMode === "select",
  })

  const showRightRail = view === "editor" && !chromeHidden
  const showIframe = view === "editor"

  return (
    <div className="flex h-screen flex-col bg-background">
      {/* Headless — surfaces component-edit mode + save-status toasts. */}
      <BannerToasts editing={editing} />
      {/* Nav bar — spans the full viewport width, above the split, so the
          prototype container and the right rail both begin at the same y. It
          hosts the breadcrumb, undo/redo, commit/push and the settings "more"
          (⋮) menu, and it is the positioning context for the floating
          toolbar passed in as its child. Hidden entirely in focus mode
          (chromeHidden) so the prototype fills the viewport. */}
      {chromeHidden ? null : (
        <EditorNavBar
          editing={editing}
          branches={branches}
          chatSubmitting={chat.submitting}
        >
          <EditorToolbar
            onHideChrome={handleHideChrome}
            view={view}
            onViewChange={handleViewChange}
            canvasMode={canvasMode}
            onCanvasModeChange={setCanvasMode}
            toolMode={toolMode}
            onToolModeChange={handleToolModeChange}
            branches={branches}
            onPinsHiddenChange={commentBridge.setPinsHidden}
            showIframe={showIframe}
            activeBreakpoint={activeBreakpoint}
            breakpointOptions={BREAKPOINT_OPTIONS}
            onBreakpointChange={setActiveBreakpoint}
            captureScreenshot={() => captureScreenshot(undefined)}
            captureRoute={liveCaptureRoute}
            prototypeUrl={prototypeUrl}
            captureEnabled={bridgeStatusKind === "ready"}
            onExitCompose={onExitCompose}
          />
        </EditorNavBar>
      )}
      {/* Focus-mode restore: a single floating icon button in the top-right
          corner that brings the chrome back. Only rendered while chrome is
          hidden, layered above the prototype container. */}
      {chromeHidden ? (
        <Button
          variant="outline"
          size="icon-lg"
          onClick={() => setChromeHidden(false)}
          title="Show chrome"
          data-testid="editor-show-chrome"
          className="fixed right-3 top-3 z-50 bg-background/90 shadow-md backdrop-blur"
        >
          <Minimize2 className="h-4 w-4" />
        </Button>
      ) : null}
      <main className="flex flex-1 overflow-hidden">
        {/* Keep the iframe mounted across Editor↔Canvas toggles so
            the adapter / `editing` hook stays bound to a live frame.
            Canvas view layers the stub on top via absolute positioning;
            switching back to Editor un-hides the iframe without a
            re-mount → no SPA-route loss, no bridge re-handshake. */}
        {/* No top padding (Mo, 2026-09-02, later the same day): the card sits
            flush under the nav bar, which lost its bottom border, and the
            toolbar floats over the card from 50px of its own margin. The rail's
            aside matches, so the two cards still start on one line. */}
        <div className="relative flex flex-1 flex-col overflow-hidden">
          <section
            className={cn(
              "flex flex-col flex-1 overflow-hidden",
              chromeHidden
                ? ""
                : "ml-3 mr-2 rounded-t-md border-x border-t border-border/60 shadow-sm",
            )}
          >
          <div className="relative flex flex-1 overflow-hidden">
          <div
            className={cn(
              "h-full w-full",
              !showIframe && "invisible",
              // base: the preview fills the pane. A named breakpoint FORCES
              // the preview to that exact width (not just a cap) so the
              // prototype's own `{bp}:` media queries actually fire; the
              // container scrolls horizontally when the breakpoint is wider
              // than the available pane.
              activeBreakpoint === "base" ? "flex" : "overflow-x-auto",
            )}
            aria-hidden={!showIframe}
          >
          <div
            className={cn(
              "h-full",
              activeBreakpoint === "base"
                ? "w-full"
                : "mx-auto transition-[width]",
            )}
            style={
              activeBreakpoint === "base"
                ? undefined
                : { width: BREAKPOINT_WIDTHS[activeBreakpoint] }
            }
          >
            {externalIframeRef ? null : (
              <LivePrototypePane
                prototypeUrl={prototypeUrl}
                iframeRef={iframeRef}
                status={editing.status}
              />
            )}
          </div>
          </div>
          {view === "canvas" ? (
            <div className="absolute inset-0">
              <EditorCanvasSurface
                editable={canvasMode === "edit"}
                onGenerateFlow={generateFlowOntoCanvas}
                generatingFlow={generatingCanvasFlow}
              />
            </div>
          ) : null}
          {/* Dormant (2026-08-14) — see EDITOR_CODE_VIEW. The `FileEditorPane`
              import above stays STATIC on purpose: it is the only importer of
              six CodeMirror packages in the repo, and dropping it fails knip.
              Gate the render, not the import. */}
          {EDITOR_CODE_VIEW && view === "file-editor" && openFile ? (
            <div className="absolute inset-0">
              <FileEditorPane
                filePath={openFile.filePath}
                initialLine={openFile.line}
                initialColumn={openFile.column}
                onExit={handleCloseFileEditor}
              />
            </div>
          ) : null}
          </div>
          </section>
        </div>
        {showRightRail ? (
          /* The padding mirrors the Viewer's rail aside (Mo, 2026-09-01:
             "make this panel have the same visual treatment as the viewer
             panel"), with two departures asked for on 2026-09-02. `pt-0`
             matches the prototype wrapper, which has no top padding either,
             so the two cards start on one line, flush under the nav bar.
             `pl-0`, with the prototype's `mr-2`
             beside it, closes the gap between the two cards to 9px (8px of
             margin plus the 1px drag handle); it was 21px, which read as a
             gutter. The aside carried a `border-l` too until 2026-09-02,
             when Mo asked for it to go: the card's own border already draws
             the rail's edge, so the line beside it was a second edge. Passed
             from here rather than baked into `ResizableRail`, which is a
             generic width-drag container with no opinion about chrome.

             A plain JS comment rather than a braced JSX one: this sits in a
             ternary BRANCH, which takes exactly one expression, and a braced
             comment beside the element is a second one. */
          <ResizableRail
            storageKey="desde.editor.right-rail-width.v1"
            className="gap-2 pt-0 pr-2 pb-2 pl-0"
          >
            <EditorRightRail
              activeTab={activeTab}
              onTabChange={handleTabChange}
              editing={editing}
              chat={chat}
              chatSessions={chatSessions}
              onReAnchorToSession={onReAnchorToSession}
              selectionMany={editorSelectionMany}
              iframeRef={iframeRef}
              commentBridge={commentBridge}
              commentSync={commentSync}
              onCommentModeChange={handleCommentModeChange}
              onCommentPinClicked={handleCommentPinClicked}
              onEscalateToChat={handleEditEscalation}
              activeBreakpoint={activeBreakpoint}
              branches={branches}
            />
            {/* Phase 3 — ask_user_question inline choice UI. Pinned to
                the bottom of the right rail (below EditorRightRail so
                it visually sits near the chat input area). Rendered at
                the surface level — outside EditorRightRail — so it
                appears regardless of which chat panel variant (V1 or V2)
                is active without adding any props to either panel.
                Null-renders when no question is pending. */}
            <ChatPendingQuestion
              pending={pendingQuestion}
              onAnswer={(selected) => {
                pendingQuestion?.resolve({ ok: true, output: { selected } })
              }}
              onDismiss={() => {
                pendingQuestion?.resolve({
                  ok: false,
                  error: "user dismissed the question",
                })
              }}
            />
          </ResizableRail>
        ) : null}
      </main>
      {/* Dormant lane (2026-08-11, see EDITOR_LANE_SWAP). `swapDialogOpen` can
          only be set by `handleSwap`, which the right rail no longer wires when
          the lane is dormant — so this guard is redundant TODAY. It is here
          because the dialog fetches `/api/editor/catalog` on open, and a
          dormant surface that can still be mounted by some future path is a
          surface that can still make a request. Cheap; unmounts the whole
          lane. */}
      {EDITOR_LANE_SWAP ? (
        <SwapDialog
          open={editing.swapDialogOpen}
          onClose={editing.handleSwapCancel}
          fromManifest={editing.editorManifest}
          onConfirm={editing.handleSwapConfirm}
        />
      ) : null}
      <DeleteScopeDialog
        open={!!editing.deleteScopePrompt}
        node={editing.deleteScopePrompt?.node ?? null}
        onConfirm={editing.confirmDeleteScope}
        onCancel={editing.cancelDeleteScope}
      />
      {editing.iterationScopePrompt ? (
        <IterationScopeDialog
          open
          editKind={editing.iterationScopePrompt.editKind}
          siblingCount={
            editing.iterationScopePrompt.iterationContext.siblingCount
          }
          rowIndex={editing.iterationScopePrompt.iterationContext.index}
          // dom-text "this row" was gated here until 2026-08-16, waiting on
          // "the deterministic this-row applicator that composes
          // `extractSlotInterpolationKey` + `applyIterationDataEditStatic`".
          // That composition now exists: the client sends `patch-text` with
          // the value alone and the server derives the property key from the
          // source, so nothing guesses a placeholder key any more. The
          // extractor refusing (text in a wrapper, computed expression, a row
          // that is a bare string) comes back as a 422 and drops to the LLM
          // lane, which is the same shape every other operation already has.
          //
          // No `thisRowEnabled` prop: every edit kind can now offer it, and a
          // gate that is always true is a gate someone has to re-read.
          onConfirm={editing.confirmIterationScope}
          onCancel={editing.cancelIterationScope}
        />
      ) : null}
      <MutationDisambiguationDialog
        prompt={editing.disambiguationPrompt}
        onConfirm={editing.confirmDisambiguation}
        onCancel={editing.cancelDisambiguation}
      />
      <SaveProgressDialog
        saving={editing.saving}
        pendingLLMInput={editing.savePendingLLMInput}
        lastLLMTrace={editing.saveLastLLMTrace}
        streamingText={editing.saveStreamingText}
        saveStatus={editing.saveStatus}
        conflict={editing.conflict}
        onForceOverwrite={editing.handleForceOverwrite}
        onReloadAfterConflict={editing.handleReloadAfterConflict}
        onDismissConflict={editing.handleClearConflict}
      />
      <TableEdgeMenu controller={tableEdgeMenu} />
      <ElementContextMenu
        controller={elementContextMenu}
        // An absent handler means the item does not exist — the menu renders
        // "Open in editor" only when it is handed one. Dormant by default; see
        // EDITOR_CODE_VIEW. "Open in VS Code" is a separate item that launches
        // an external editor and is deliberately untouched.
        onOpenFileEditor={EDITOR_CODE_VIEW ? handleOpenFileEditor : undefined}
        // Dormant by default — the menu omits the item entirely rather than
        // showing a control that does nothing.
        vscodeLinkEnabled={EDITOR_VSCODE_LINK}
        onStartChat={handleStartChatFromElement}
      />
    </div>
  )
}

export type { Selection }
