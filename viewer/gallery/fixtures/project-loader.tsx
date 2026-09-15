import { ProjectLoader } from "@/components/blocks"
import { PanelFrame } from "../harness/scenario"
import type { SurfaceEntry } from "@/components/gallery/types"

/**
 * The loading animation itself.
 *
 * It gets its own entry because in situ it is unreviewable: the Viewer shows
 * it over the prototype iframe, which loads in a few hundred milliseconds, so
 * the catalog would offer a state that is gone before it can be looked at. An
 * animation nobody can hold still is an animation nobody reviews.
 *
 * The same block is what the Editor's launcher shows while a project opens,
 * so this covers both surfaces.
 *
 * There is no "small" state any more. It demonstrated 96px "for a tighter
 * surface", which no call site ever used, and once the default came down to
 * 80 (Mo, 2026-09-14) the small one was the BIGGER one. A gallery state for a
 * size the product cannot produce is a state nobody can review.
 */
export const PROJECT_LOADER_SURFACE: SurfaceEntry = {
  id: "project-loader",
  title: "Loading animation",
  kind: "inline",
  sourceFile: "src/components/blocks/project-loader.tsx",
  states: [
    {
      id: "project-loader/labelled",
      label: "With a label — what the Viewer shows over the prototype",
      render: () => (
        <PanelFrame>
          <ProjectLoader label="Loading prototype" />
        </PanelFrame>
      ),
    },
    {
      id: "project-loader/bare",
      label: "No label — the animation on its own",
      render: () => (
        <PanelFrame>
          <ProjectLoader />
        </PanelFrame>
      ),
    },
  ],
}
