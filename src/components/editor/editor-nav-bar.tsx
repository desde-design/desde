"use client"

/**
 * `EditorNavBar` — the full-width row across the top of the editor workspace.
 * It carries the breadcrumb (home › project ▾ › branch ▾) on the left, and the
 * branch Commit / Merge / Push controls, the settings menu and the hide-chrome
 * button on the right.
 *
 * Undo/Redo used to live here. They moved into the toolbar (2026-08-14) to sit
 * with the other per-edit controls; this row is now project + branch scope
 * only.
 *
 * Naming: this is the NAV BAR. The floating pill that hangs off its bottom
 * edge is the TOOLBAR (`editor-toolbar.tsx`). "Top bar" is retired as a term,
 * because it read as both surfaces at once.
 *
 * The row spans the full viewport width, above the split, so the prototype
 * container and the right rail both begin at the same y. It is the toolbar's
 * positioning context, so the toolbar is passed in as `children` and renders
 * inside this row's relative container.
 */

import type { ReactNode } from "react"
import { Maximize2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { EditorBreadcrumb } from "@/components/editor/project-breadcrumb"
import { EditorSettingsMenu } from "@/components/editor/editor-settings-menu"
import { BranchModeControls } from "@/components/editor/branch-mode-controls"
import type { useEditorEditing } from "@/hooks/useEditorEditing"
import type { BranchesApi } from "@/hooks/useEditorBranches"

type EditingApi = ReturnType<typeof useEditorEditing>

interface EditorNavBarProps {
  editing: EditingApi
  branches: BranchesApi
  /** Disables the settings actions that would race a running chat turn. */
  chatSubmitting: boolean
  /** Enter focus mode: hide all editor chrome. */
  onHideChrome: () => void
  /** The floating toolbar, positioned against this row. */
  children?: ReactNode
}

export function EditorNavBar({
  editing,
  branches,
  chatSubmitting,
  onHideChrome,
  children,
}: EditorNavBarProps) {
  return (
    <div
      // The nav bar sits BACK. It is orientation and plumbing, not the work,
      // so its text is a step lighter than the workspace's. Set once here and
      // inherited: `Button`'s ghost and outline variants deliberately declare
      // no resting text colour, only `hover:text-foreground`, so every label
      // and glyph in this row quiets down together and snaps back to full
      // contrast under the pointer.
      className="relative flex shrink-0 items-center border-b px-3 py-2 text-foreground/70"
      data-testid="editor-nav-bar"
    >
      {/* Navigation breadcrumb: home › project ▾ › branch ▾. Replaces
          the standalone project + branch dropdowns; the branch segment
          self-hides outside branch mode. The Editor↔Canvas switcher now
          lives in the floating toolbar below (first item). */}
      <EditorBreadcrumb branches={branches} />
      {/* ONE gap for the whole right-hand cluster, and `BranchModeControls`
          uses the same value on its own row. It has to: it renders its
          buttons inside a nested flex row, so the parent's gap never reaches
          them, and the two values had drifted to 8px inside and 2px outside.
          The result was Commit to Merge sitting four times as far apart as
          Merge to the settings gear. If you change this, change it there too. */}
      <div className="ml-auto flex items-center gap-1.5">
        {/* Branch mode is the only edit substrate: edits are immediate and
            there's no promote step, so neither the worktree Commit/Push
            cluster nor the buffered Save/Discard applies. Commit (working
            tree → this branch) + Publish (this branch → default), plus an
            AI-queue flush when inline edits need the LLM lane. */}
        <BranchModeControls editing={editing} branches={branches} />
        <EditorSettingsMenu
          invalidateManifest={editing.invalidateAttributionManifest}
          chatSubmitting={chatSubmitting}
        />
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onHideChrome}
          title="Hide chrome"
          data-testid="editor-hide-chrome"
        >
          <Maximize2 />
        </Button>
      </div>
      {children}
    </div>
  )
}
