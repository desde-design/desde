"use client"

/**
 * `EditorToolbar` — the floating centered pill that hangs off the bottom edge
 * of the nav bar (`editor-nav-bar.tsx`). It carries the prototype's tools, in
 * this order: the tool picker, Undo, Redo, Sizing. The canvas view switcher
 * (dormant by default) and the exit-editor X keep the trailing end.
 *
 * The tool picker is ONE segmented control, `Navigate | Select | Comment`,
 * and it leads because it decides what every click in the prototype does.
 * It replaced an Inspect switch sitting beside a Comment toggle button
 * (2026-08-14). Those two controls were already three values of one
 * `toolMode` field (see `src/stores/tool-mode-slice.ts`), so a switch plus a
 * button was two shapes drawing one choice, and neither of them could show
 * Navigate as a thing the user had picked rather than as the absence of the
 * other two.
 *
 * Undo/Redo moved here from the nav bar (2026-08-14) so every per-edit control
 * is in one cluster. This file's own comment already called them "toolbar"
 * buttons while they rendered in the row above.
 *
 * Naming: this is the TOOLBAR. The full-width row above it is the NAV BAR.
 * "Top bar" is retired as a term, because it read as both. This element used
 * to carry `data-testid="editor-top-bar"` while being the toolbar, which is
 * where the confusion came from.
 *
 * Positioning: the pill is absolutely positioned against the nav bar's
 * relative container, so it must render as a child of `EditorNavBar`.
 * `top-full` puts its top at the nav bar's bottom; `-translate-y-3/4` pulls it
 * back up by three quarters of its own height, so three quarters of the pill
 * overlaps the nav bar and the last quarter hangs into the workspace. Its
 * centre sits ABOVE the border, not on it. That asymmetry is the point: it
 * reads as attached to the bar and hanging from it, where a centred pill would
 * read as floating across the seam.
 */

import { Compass, Maximize2, MessageSquarePlus, MousePointerClick, Pencil, SquareDashedMousePointer, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  SegmentedToggle,
  type SegmentedToggleOption,
} from "@/components/editor/segmented-toggle"
import { BreakpointMenu } from "@/components/editor/breakpoint-menu"
import { CaptureToCanvasButton } from "@/components/editor/capture-to-canvas-button"
import { UndoRedoControls } from "@/components/editor/undo-redo-controls"
import { PinsHiddenToggle } from "@/components/editor/pins-hidden-toggle"
import type { ActiveBreakpoint } from "@/components/editor/tailwind-classes"
import type { CaptureScreenshotResult } from "@/hooks/useIframeScreenshotCapture"
import type { BranchesApi } from "@/hooks/useEditorBranches"
import type { EditorToolMode } from "@/stores/tool-mode-slice"
import { EDITOR_CANVAS } from "@/lib/editor-feature-flags"

/** Which workspace surface fills the center pane. */
export type EditorView = "editor" | "canvas" | "file-editor"
/** Whether the canvas is read-only or editable. */
export type CanvasMode = "read" | "edit"

/**
 * The tool picker's options. The middle one is "Select", the word Mo chose,
 * and its stored value is `select`, so the label and the value agree. It is
 * not called Inspect anywhere.
 */
const TOOL_OPTIONS: ReadonlyArray<SegmentedToggleOption<EditorToolMode>> = [
  {
    value: "navigate",
    label: "Navigate",
    icon: <MousePointerClick className="h-3 w-3" />,
  },
  {
    value: "select",
    label: "Select",
    icon: <SquareDashedMousePointer className="h-3 w-3" />,
  },
  {
    value: "comment",
    label: "Comment",
    icon: <MessageSquarePlus className="h-3 w-3" />,
  },
]

const VIEW_OPTIONS = [
  {
    value: "editor" as const,
    label: "Editor",
    icon: <Pencil className="h-3 w-3" />,
  },
  {
    value: "canvas" as const,
    label: "Canvas",
    icon: <Compass className="h-3 w-3" />,
  },
]

const CANVAS_MODE_OPTIONS = [
  { value: "read" as const, label: "Read" },
  { value: "edit" as const, label: "Edit" },
]

interface EditorToolbarProps {
  view: EditorView
  onViewChange: (next: EditorView) => void
  canvasMode: CanvasMode
  onCanvasModeChange: (next: CanvasMode) => void
  /** The tool the user has picked. Drives the picker's selected segment. */
  toolMode: EditorToolMode
  /**
   * Pick a tool. Asking for `comment` can be REFUSED upstream (the comment
   * store may not know yet where comments belong), which is why the picker
   * renders `toolMode` rather than remembering what it last asked for.
   */
  onToolModeChange: (next: EditorToolMode) => void
  /** Branch-mode git state. Feeds the Undo/Redo pair. */
  branches: BranchesApi
  /** Hide or show every comment pin in the prototype. Feeds the pin toggle. */
  onPinsHiddenChange: (hidden: boolean) => void
  /** Whether the prototype iframe is the foreground surface. */
  showIframe: boolean
  activeBreakpoint: ActiveBreakpoint
  breakpointOptions: ReadonlyArray<SegmentedToggleOption<ActiveBreakpoint>>
  onBreakpointChange: (next: ActiveBreakpoint) => void
  /** Capture the current viewport, for "Screenshot → canvas". */
  captureScreenshot: () => Promise<CaptureScreenshotResult>
  /** Live route (pathname + search + hash) the capture is taken against. */
  captureRoute: string
  /** Prototype origin the capture is taken against. */
  prototypeUrl: string
  /** Whether the bridge is ready (gates the capture button). */
  captureEnabled: boolean
  /** When provided, the toolbar renders an exit-editor X button. */
  onExitCompose?: () => void
  /**
   * Hide every piece of editor chrome so the prototype fills the window.
   * Rendered LAST, at the right edge (Mo, 2026-09-02: "move the full screen
   * button in the project top bar into the tool bar. It should be the last
   * option"). It lived in the nav bar's right-hand cluster until then.
   */
  onHideChrome: () => void
}

export function EditorToolbar({
  view,
  onViewChange,
  canvasMode,
  onCanvasModeChange,
  toolMode,
  onToolModeChange,
  branches,
  onPinsHiddenChange,
  showIframe,
  activeBreakpoint,
  breakpointOptions,
  onBreakpointChange,
  captureScreenshot,
  captureRoute,
  prototypeUrl,
  captureEnabled,
  onExitCompose,
  onHideChrome,
}: EditorToolbarProps) {
  return (
    <header
      // `bg-card`, not a muted/background blend: this bar floats over the
      // prototype, so it has to read as chrome sitting on top rather than
      // a tint of the page under it. Also retires an arbitrary
      // `color-mix()` for a token that already tracks the four themes.
      //
      // `z-50`, not `z-30`. The new-comment composer portals a full-viewport
      // dismiss backdrop at `z-40` (`comment-thread-popup.tsx`), and at
      // `z-30` this whole bar sat UNDER it: with a composer open, a click
      // aimed at the tool picker hit the backdrop instead, dismissed the
      // composer, and left the tool exactly where it was. Sticky placement
      // keeps a composer open far more of the time, so that was reachable
      // constantly. The nav bar above is `relative` with no z-index, so it
      // opens no stacking context and this value competes with the portal
      // directly.
      //
      // What that reorders, deliberately: the backdrop no longer dismisses
      // clicks on the toolbar. It still covers everything else, and the two
      // toolbar controls that need to dismiss (the tool picker's non-Comment
      // segments) close the composer themselves in `handleToolModeChange`.
      //
      // `z-[60]` rather than `z-50`, which is where this first landed. The
      // composer's own popup is also `z-50` and portals AFTER this bar, so at
      // equal z it won every overlap: measured on the live CLI, a pin dropped
      // near the top of the viewport put the composer straight over the tool
      // picker. Being unable to reach the picker is not fatal, since Escape
      // and the X still close the composer, but "the toolbar is the one thing
      // always reachable" is the rule worth keeping. An arbitrary value is
      // used knowingly: Tailwind's z scale stops at 50, so there is no step
      // above the portal to reach for.
      //
      // `top-12.5`: the pill's top edge sits 50px below the top of the nav
      // bar it is positioned in (Mo, 2026-09-02: "add to the margin top of
      // the toolbar to 50px"). The nav bar is 40px tall, so the pill floats
      // 10px under it, over the prototype card. It used to hang off the
      // nav's bottom edge with a three-quarter lift, straddling a border
      // the nav no longer has; a first attempt added the 50px ON TOP of
      // that anchor and landed the bar "really low".
      className="absolute left-1/2 top-12.5 z-[60] flex -translate-x-1/2 items-center gap-1 rounded-md border bg-card p-1 shadow-xs"
      data-testid="editor-toolbar"
    >
      {/* The tool picker. Navigate = clicks drive the prototype. Select =
          the inspector overlay is armed. Comment = the placement overlay is
          armed, and the TOOL stays picked across pins.
          The overlay does not: the bridge un-arms it on every pin, and the
          shell re-arms it when that pin's composer closes (see
          `useStickyCommentPlacement` and `src/stores/tool-mode-slice.ts`).
          So an active Comment segment does not mean an armed overlay right
          now. One control, because it is one choice. */}
      {showIframe ? (
        <SegmentedToggle
          value={toolMode}
          options={TOOL_OPTIONS}
          onChange={onToolModeChange}
          ariaLabel="Prototype tool"
          // No track of its own: the toolbar pill IS the container, and a
          // second one inside it was a box in a box (Mo, 2026-08-18).
          variant="plain"
        />
      ) : null}
      {/*
        A rule between the tool picker and everything after it (Mo,
        2026-08-18). Without the picker's own track, the three segments and
        the Undo/Redo/Sizing buttons became one undifferentiated run of
        controls — and they are two different kinds of thing: the picker sets
        a MODE that persists, the rest are one-shot ACTIONS.

        Rendered only when the picker is, since a rule with nothing on its
        left is a stray mark.
      */}
      {showIframe ? (
        // `h-5` and `bg-border/80` → `bg-foreground/15` (Mo, 2026-08-18).
        // `bg-border` on the pill's own near-white ground was close to
        // invisible, and at `h-4` it was shorter than the 24px controls it
        // separates, so it read as a speck rather than a division.
        <div className="mx-1.5 h-5 w-px shrink-0 bg-foreground/15" />
      ) : null}
      {/* Undo/Redo — not gated on `showIframe`: they act on source edits,
          which are just as real in the file-editor view. */}
      <UndoRedoControls branches={branches} />
      {/* Hide comments, after Undo and Redo (Mo, 2026-09-02). Gated on the
          iframe like the picker: pins only exist in the prototype. */}
      {showIframe ? <PinsHiddenToggle onPinsHiddenChange={onPinsHiddenChange} /> : null}
      {showIframe ? (
        <BreakpointMenu
          value={activeBreakpoint}
          options={breakpointOptions}
          onChange={onBreakpointChange}
        />
      ) : null}
      {/* Editor ↔ Canvas switcher. Hidden in the file-editor view AND
          when the canvas surface is dormant (EDITOR_CANVAS off,
          2026-08-04): with only "Editor" left, a single-option tablist
          is chrome, not a control — hide the whole strip rather than
          show an orphan tab. Flip `editor.canvas: true` in
          .desde/config.json (or EDITOR_CANVAS=1) to restore. */}
      {view === "file-editor" || !EDITOR_CANVAS ? null : (
        <SegmentedToggle
          value={view}
          options={VIEW_OPTIONS}
          onChange={onViewChange}
          ariaLabel="Workspace view"
        />
      )}
      {view === "canvas" ? (
        <SegmentedToggle
          value={canvasMode}
          options={CANVAS_MODE_OPTIONS}
          onChange={onCanvasModeChange}
          ariaLabel="Canvas mode"
        />
      ) : null}
      {/* "Screenshot → canvas" — dormant with the canvas surface
          (2026-08-04); see the switcher comment above. */}
      {showIframe && EDITOR_CANVAS ? (
        <CaptureToCanvasButton
          capture={captureScreenshot}
          currentRoute={captureRoute}
          baseUrl={prototypeUrl}
          enabled={captureEnabled}
          iconOnly
        />
      ) : null}
      {onExitCompose ? (
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onExitCompose}
          title="Exit editor mode"
          data-testid="editor-exit"
        >
          <X />
        </Button>
      ) : null}
      {/* Full screen, last. A one-shot action like Undo and Redo, so it sits
          in this cluster; rightmost because it is the one control here that
          takes the whole toolbar away with it. */}
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={onHideChrome}
        title="Hide chrome"
        aria-label="Hide chrome"
        data-testid="editor-hide-chrome"
      >
        <Maximize2 />
      </Button>
    </header>
  )
}
