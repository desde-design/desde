/**
 * Asking for comment placement mode, in one place.
 *
 * Two controls ask for it: the toolbar's tool picker and the Comments panel's
 * Comment button. They are different components — a `SegmentedToggle` and a
 * `CommentModeButton` — so what makes the refusal below apply to both is NOT
 * a shared control. It is that both are wired to `handleToolModeChange` in
 * `editor-surface.tsx`, which is the only place either of them can reach the
 * mode from, and which routes every request for `comment` through here.
 *
 * That distinction matters for a third entry point: rendering a particular
 * button inherits nothing. Route it through `handleToolModeChange` — or
 * through this function — or it will write comments to
 * `.desde/comments.json` for a repo that syncs to a viewer, which is the
 * misfiling the refusal exists to prevent.
 *
 * All this adds on top of `requestToolMode("comment")` is the refusal. The
 * mutual exclusion with Select is not handled here any more: comment mode
 * and Select are two values of one field (`src/stores/tool-mode-slice.ts`),
 * so entering one leaves the other by construction rather than by remembering
 * to turn it off.
 */

import { toast } from "sonner"
import type { EditorToolMode } from "@/stores/tool-mode-slice"

export interface RequestCommentModeDeps {
  /**
   * The viewer-auth status is still outstanding, so the comment store
   * choice is a provisional "local" rather than a decided one. See
   * `useEditorCommentStore`.
   */
  resolving: boolean
  /**
   * `resolving` is stuck because the status request FAILED, not because it
   * is still in flight. The two want different copy: one clears on its own,
   * the other wants a reload.
   */
  resolveFailed: boolean
  /**
   * `requestToolMode` from `useEditorToolMode`: writes the mode and posts
   * what the bridge needs to hear.
   */
  setToolMode: (next: EditorToolMode) => void
}

/**
 * Ask for comment placement mode. Returns whether the request went through,
 * so a caller can tell "entered" from "refused".
 */
export function requestCommentMode(deps: RequestCommentModeDeps): boolean {
  // Refuse while the viewer-auth status is still outstanding. `mode` is a
  // provisional "local" until it lands, so a comment placed in that window
  // would be written to `.desde/comments.json` even for a repo that
  // syncs to a viewer, silently, and in a file the team never reads. The
  // window is one request long; saying "one moment" beats misfiling it.
  if (deps.resolving) {
    toast.info(
      deps.resolveFailed
        ? "Can't tell where comments should be saved, so they're paused rather than saved to the wrong place. Reload to retry."
        : "Checking the viewer connection, try again in a moment.",
    )
    return false
  }
  deps.setToolMode("comment")
  return true
}
