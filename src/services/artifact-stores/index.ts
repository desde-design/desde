/**
 * HTTP-backed artifact store factories for the CLI shell.
 *
 * The shell imports these to talk to the local editor-cli HTTP
 * server (auth + session header are added transparently by the
 * fetch interceptor the shell installs at boot — see
 * editor-cli/ui-src/src/main.tsx). Each factory returns a value
 * that satisfies the canonical store interface in
 * `src/editor/core/stores/`.
 *
 * Viewer note: this directory is CLI-specific. The viewer has its own
 * server-side comment storage (SQLite) and does not consume these stores;
 * Editor reaches it over HTTP through the CLI's viewer-proxy. The
 * store-agnostic consumer contract (`setComments` etc.) still holds.
 */

export { createHttpCanvasStore } from "./http-canvas-store"
export { createHttpCommentStore } from "./http-comment-store"
export { createHttpNoteStore } from "./http-note-store"
export {
  createHttpScreenshotPlanStore,
  type CreateFromRoutesInput,
  type CreateFromRoutesResult,
  type HttpScreenshotPlanStore,
} from "./http-screenshot-plan-store"
export {
  ArtifactStoreError,
  isArtifactStoreError,
  isMissingArtifactError,
} from "./shared"

export { createViewerHttpCommentStore, type ViewerHttpCommentStoreOptions } from "./viewer-http-comment-store"
export {
  createLocalOverlayCommentStore,
  type LocalOverlayCommentStoreOptions,
} from "./local-overlay-comment-store"
