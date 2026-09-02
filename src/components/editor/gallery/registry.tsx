import type { SurfaceEntry, SurfaceState } from "./types"
import { ITERATION_SCOPE_SURFACE } from "./fixtures/iteration-scope"
import { MUTATION_DISAMBIGUATION_SURFACE } from "./fixtures/mutation-disambiguation"
import { STYLE_SCOPE_SURFACE } from "./fixtures/style-scope"
import { DELETE_SCOPE_SURFACE } from "./fixtures/delete-scope"
import { SAVE_PROGRESS_SURFACE } from "./fixtures/save-progress"
import { SWAP_SURFACE } from "./fixtures/swap"
import { CONNECT_VIEWER_DIALOG_SURFACE } from "./fixtures/connect-viewer-dialog"
import { PROJECT_SETTINGS_SURFACE } from "./fixtures/project-settings-page"
import { CHAT_DISCLOSURE_SURFACE } from "./fixtures/chat-disclosure"
import { NEW_PROJECT_DIALOG_SURFACE } from "./fixtures/new-project-page"
import { BRANCH_MENU_SURFACE } from "./fixtures/branch-menu"
import { PULL_REQUEST_DIALOG_SURFACE } from "./fixtures/pull-request-dialog"
import { BRANCH_MODE_DIALOGS_SURFACE } from "./fixtures/branch-mode-dialogs"
import { CAPTURE_TO_CANVAS_BUTTON_SURFACE } from "./fixtures/capture-to-canvas-button"
import { EDITOR_SETTINGS_MENU_SURFACE } from "./fixtures/editor-settings-menu"
import { REFERENCE_DIRS_DIALOG_SURFACE } from "./fixtures/reference-dirs-dialog"
import { DESKTOP_UPDATES_SURFACE } from "./fixtures/desktop-updates"
import { LLM_CREDENTIALS_SURFACE } from "./fixtures/llm-credentials"
import { CAPABILITIES_SURFACE } from "./fixtures/capabilities"
import { SMOKE_TEST_CONTROL_SURFACE } from "./fixtures/smoke-test-control"
import { ACTIVITY_PANEL_SURFACE } from "./fixtures/activity-panel"
import { CHAT_STATUS_BANNERS_SURFACE } from "./fixtures/chat-status-banners"
import { CHAT_PENDING_QUESTION_SURFACE } from "./fixtures/chat-pending-question"
import { CHAT_MID_TURN_SURFACE } from "./fixtures/chat-mid-turn"
import { STYLE_ORIGIN_ROW_SURFACE } from "./fixtures/style-origin-row"
import { TOASTS_SURFACE } from "./fixtures/toasts"

/**
 * The catalog. Single source of truth for the picker overlay AND the
 * screenshot script (which reads the ids off the running page rather than
 * importing this module — see tasks/scripts/surface-gallery-shots.mts).
 *
 * Ordered as a designer would work through it: decision modals first,
 * then inline surfaces, then toasts.
 */
export const SURFACE_REGISTRY: readonly SurfaceEntry[] = [
  ITERATION_SCOPE_SURFACE,
  MUTATION_DISAMBIGUATION_SURFACE,
  STYLE_SCOPE_SURFACE,
  DELETE_SCOPE_SURFACE,
  SAVE_PROGRESS_SURFACE,
  SWAP_SURFACE,
  CONNECT_VIEWER_DIALOG_SURFACE,
  NEW_PROJECT_DIALOG_SURFACE,
  PROJECT_SETTINGS_SURFACE,
  CHAT_DISCLOSURE_SURFACE,
  BRANCH_MENU_SURFACE,
  PULL_REQUEST_DIALOG_SURFACE,
  BRANCH_MODE_DIALOGS_SURFACE,
  CAPTURE_TO_CANVAS_BUTTON_SURFACE,
  EDITOR_SETTINGS_MENU_SURFACE,
  REFERENCE_DIRS_DIALOG_SURFACE,
  DESKTOP_UPDATES_SURFACE,
  LLM_CREDENTIALS_SURFACE,
  CAPABILITIES_SURFACE,
  SMOKE_TEST_CONTROL_SURFACE,
  // Inline surfaces — no scrim, no portal. They render in normal flow, so
  // their fixtures sit in an `InlineFrame` at a rail-realistic width.
  ACTIVITY_PANEL_SURFACE,
  CHAT_STATUS_BANNERS_SURFACE,
  CHAT_PENDING_QUESTION_SURFACE,
  CHAT_MID_TURN_SURFACE,
  STYLE_ORIGIN_ROW_SURFACE,
  // Toasts fire imperatively instead of rendering a node; the overlay pins
  // them open and dismisses them on state change.
  TOASTS_SURFACE,
]

export function findSurfaceState(
  id: string,
): { entry: SurfaceEntry; state: SurfaceState } | null {
  for (const entry of SURFACE_REGISTRY) {
    const state = entry.states.find((candidate) => candidate.id === id)
    if (state) return { entry, state }
  }
  return null
}
