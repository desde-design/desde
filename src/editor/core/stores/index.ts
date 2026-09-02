/**
 * Artifact storage interfaces — framework-neutral abstractions over
 * the four artifact types the CLI persists locally and the viewer
 * fetches from Firestore. See `tasks/cli-viewer-architecture.md`
 * (CLI shell model + v1 work sequencing) for context.
 *
 * Consumers depend on the interface, not the impl. CLI impls live in
 * `editor-cli/src/server/stores/`; viewer impls live in
 * `src/services/` (Firestore-backed, not present in this slice).
 */

export type {
  CommentStore,
  CommentCreateInput,
  CommentUpdatePatch,
  CommentReplyInput,
  CommentSubscriber,
} from "./comment-store"

export { createInMemoryCommentStore } from "./in-memory-comment-store"

export type {
  NoteStore,
  NoteCreateInput,
  NoteUpdatePatch,
  NoteReplyInput,
} from "./note-store"

export type {
  ScreenshotPlanStore,
  ScreenshotPlanCreateInput,
  ScreenshotPlanUpdatePatch,
} from "./screenshot-plan-store"

export type {
  CanvasStore,
  CanvasCreateInput,
  CanvasUpdatePatch,
  CanvasFrameCreateInput,
  CanvasFrameUpdatePatch,
  CanvasEdgeCreateInput,
  CanvasEdgeUpdatePatch,
  CanvasAnnotationCreateInput,
  CanvasAnnotationUpdatePatch,
} from "./canvas-store"
