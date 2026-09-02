/**
 * Local-file artifact store factory. The CLI's HTTP layer builds a
 * `LocalStores` bundle once at startup and threads it through to the
 * per-artifact handlers. Tests can construct in-memory replacements
 * that satisfy the same interfaces.
 */

import type {
  CanvasStore,
  CommentStore,
  NoteStore,
  ScreenshotPlanStore,
} from "../../../../src/editor/core"
import { createLocalCanvasStore } from "./local-canvas-store.js"
import { createLocalCommentStore } from "./local-comment-store.js"
import { createLocalNoteStore } from "./local-note-store.js"
import { createLocalScreenshotPlanStore } from "./local-screenshot-plan-store.js"

export interface LocalStores {
  comments: CommentStore
  notes: NoteStore
  canvases: CanvasStore
  screenshotPlans: ScreenshotPlanStore
}

export function createLocalStores(repoRoot: string): LocalStores {
  return {
    comments: createLocalCommentStore(repoRoot),
    notes: createLocalNoteStore(repoRoot),
    canvases: createLocalCanvasStore(repoRoot),
    screenshotPlans: createLocalScreenshotPlanStore(repoRoot),
  }
}

export { createLocalCanvasStore } from "./local-canvas-store.js"
export { createLocalCommentStore } from "./local-comment-store.js"
export { createLocalNoteStore } from "./local-note-store.js"
export { createLocalScreenshotPlanStore } from "./local-screenshot-plan-store.js"
export {
  DESDE_DIR,
  resolveStorePath,
} from "./local-store-base.js"
