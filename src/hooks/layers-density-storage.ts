/**
 * Persistence for the Structure panel's density choice.
 *
 * It is a per-user VIEW preference, so it belongs next to the other editor
 * UI preferences in `localStorage` — not in an `EDITOR_*` feature flag,
 * which is boot-time config the CLI reads from the project's config file.
 * Before this existed the choice was plain `useState`, so it reset to
 * `essentials` on every reload.
 *
 * Its own module rather than a pair of helpers inside `useEditorEditing`:
 * the hook is 4,400 lines with live adapter side effects and no test
 * harness, and this is exactly the kind of thing that wants one.
 */

import {
  DEFAULT_LAYERS_DENSITY,
  isLayersDensity,
  type LayersDensity,
} from "./layers-density-filter"

/**
 * Same `desde.editor.<name>.v1` convention as the rail width
 * (`desde.editor.right-rail-width.v1`) and the edit/layers split
 * (`desde.editor.edit-layers-split.v1`).
 */
export const LAYERS_DENSITY_STORAGE_KEY = "desde.editor.layers-density.v1"

/**
 * The stored density, or the default.
 *
 * Anything that is not one of the three valid densities is discarded: a
 * hand-edited value, a key left behind by an older build, or a density that
 * has since been removed must not leave the filter switching on a level it
 * cannot honour. `localStorage` itself can throw (blocked storage, private
 * mode), so the read is guarded rather than trusted.
 */
export function readStoredLayersDensity(): LayersDensity {
  if (typeof window === "undefined") return DEFAULT_LAYERS_DENSITY
  try {
    const stored = window.localStorage.getItem(LAYERS_DENSITY_STORAGE_KEY)
    return isLayersDensity(stored) ? stored : DEFAULT_LAYERS_DENSITY
  } catch {
    return DEFAULT_LAYERS_DENSITY
  }
}

/** Best effort. A view preference is not worth failing an interaction over. */
export function writeStoredLayersDensity(density: LayersDensity): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(LAYERS_DENSITY_STORAGE_KEY, density)
  } catch {
    // Storage blocked or full. The choice still applies for this session.
  }
}
