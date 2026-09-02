# components/editor

React UI components for the editor authoring surface. Renders in the platform shell (parent of the prototype iframe), not inside the prototype itself.

## Planned components (per the design doc)

- **Inspector panel**: the right-rail editor. Sectioned: Identity, Variants & Props, Layout, Style, State preview, Data, Intent. Generated dynamically from the selected component's `ComponentManifest`. The differentiator surface; expected to be the bulk of this directory.
- **Canvas chrome**: selection outline, off-system marker, hover preview overlay (the bridge renders some of this inside the iframe; the shell-side parts go here).
- **Breadcrumb**: ancestry strip, clickable to ascend.
- **Multi-selection summary**: Figma-style "selection colors"-style roll-up for shared properties.
- **Action prompt / agent input**: for restructuring operations and prose-described edits.

## What it consumes

- Selection state from the Zustand `inspector-slice` (extended with editor-specific fields if needed).
- `ComponentManifest`s from whatever `ComponentManifestSource` is active for the current prototype's design system.
- Edit dispatch through the `FrameworkAdapter` for the current prototype's framework.

## Style

Tailwind v4 + shadcn/ui (Radix) per Desde conventions. Inspector controls (segmented controls, paired numeric inputs, "+" affordances, etc.) borrow Figma's density and visual idioms. Canvas-coordinate concepts are replaced with layout-flow concepts.
