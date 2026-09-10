/**
 * Where the style-edit builders used to live.
 *
 * They are pure functions over a `Mutation`, so they moved to
 * `src/editor/edit-service/style-edit-builders.ts`, alongside the applicators
 * whose edits they build. This file re-exports the four the hook still calls,
 * so its import keeps working while the migration is in progress; the plan's
 * Task 12 deletes it and repoints the hook.
 */
export {
  blastRadiusNotice,
  buildPageScopedCssOverrideEdit,
  buildStyleEdit,
  isUnsupportedStyleBuild,
} from "@/editor/edit-service/style-edit-builders"
export type { StyleEditDestinationOptions } from "@/editor/edit-service/style-edit-builders"
