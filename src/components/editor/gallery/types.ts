/**
 * The Editor catalog's types.
 *
 * They live one level up, in `@/components/gallery/types`, because the Viewer
 * has a catalog too (`viewer/gallery/`) and two catalogs with independently
 * drifting shapes could not share the controller that drives both pickers.
 *
 * This module stays as the re-export the ~30 fixtures under `./fixtures/`
 * already import, so moving the definitions cost no churn in any of them.
 */
export type {
  SurfaceEntry,
  SurfaceKind,
  SurfaceRenderContext,
  SurfaceState,
} from "@/components/gallery/types"
