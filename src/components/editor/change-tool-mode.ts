/**
 * What a tool change means in the workspace, in one place.
 *
 * `requestToolMode` (`src/hooks/useEditorToolMode.ts`) is the wire: it writes
 * the mode and posts what the bridge needs to hear. This is the POLICY around
 * it, and there are two rules the wire has no business knowing about:
 *
 * 1. Asking for `comment` can be REFUSED, because the comment store may not
 *    know yet where comments belong. That lives in `requestCommentMode`.
 * 2. LEAVING the Comment tool closes an open new-comment composer.
 *
 * Rule 2 exists because the composer is dismissed by clicking away from it,
 * and the tool picker sits under that dismiss backdrop no longer. Before the
 * picker was raised above it (`editor-toolbar.tsx`), a click aimed at Select
 * hit the backdrop, closed the composer, and left the tool on Comment — so
 * the user asked to stop commenting and stayed armed to comment. With the
 * picker reachable, that same click has to do BOTH halves of what it looks
 * like it does, or the composer would be left open under a different tool.
 *
 * Order is load-bearing: the mode is written BEFORE the composer closes, so
 * that `useStickyCommentPlacement`'s closing edge reads the tool the user just
 * picked and does not re-arm placement behind them.
 *
 * It lives outside `editor-surface.tsx` so it can be tested without mounting
 * the whole workspace. Every tool change in the workspace goes through here,
 * from the toolbar's picker, from the Comments panel's button, and from
 * entering focus mode, so none of these rules can apply to one entry point and
 * not another.
 */

import { requestCommentMode, type RequestCommentModeDeps } from "./request-comment-mode"
import type { EditorToolMode } from "@/stores/tool-mode-slice"

export interface ChangeToolModeDeps extends RequestCommentModeDeps {
  /**
   * Clear `pendingPosition`, the new-comment composer's lifetime. A no-op
   * when no composer is open.
   */
  closeNewCommentComposer: () => void
}

/**
 * Move the workspace to `next`. Returns whether the change went through, so a
 * caller can tell "changed" from "refused" (only `comment` can be refused).
 */
export function changeToolMode(
  next: EditorToolMode,
  deps: ChangeToolModeDeps,
): boolean {
  if (next === "comment") return requestCommentMode(deps)
  deps.setToolMode(next)
  deps.closeNewCommentComposer()
  return true
}
