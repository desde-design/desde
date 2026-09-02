# Editor

Authoring tool for production-accurate prototypes. Designers compose and refine; output (intent, data contracts, off-system markers) is consumed by the existing review app and engineering MCP.

## Layout

- `core/`: framework-and-design-system-neutral types and interfaces. The contracts every adapter implements. **Must not import Vue, React, or any specific design system.**
- `adapters/`: concrete implementations of the core interfaces, one subdir per (framework | design system) combination. Vue 3 and a design system are the V1 targets; React, Material UI, Storybook ingestion, etc. are anticipated future adapters.

Editor's React UI lives separately at [`../components/editor/`](../components/editor/) and the bundled CLI page is at [`../editor-ui/`](../editor-ui/) (mounted by the `editor-cli/ui-src/` Vite bundle). Both consume the types defined in `core/`.

## Why this split

The user requirement is that editor scale to other frameworks (React) and design systems (anything other than the design system) without rewriting. The two adapter axes are how that scales: a new framework gets a new `FrameworkAdapter`; a new design system gets a new `ComponentManifestSource`. The inspector UI, action pipeline, and intent/data structures stay untouched.
