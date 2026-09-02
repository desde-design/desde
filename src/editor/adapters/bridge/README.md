# editor/adapters/bridge

`BridgeFrameworkAdapter`: the shell-side `FrameworkAdapter` implementation that
talks to the Desde comment-bridge over the postMessage protocol. It is
**framework-neutral**: it drives Vue 3 *and* React substrates with the same code.

## Why one adapter, not one per framework

The framework-specific work lives in two places that are NOT this adapter:

- **The bridge** ([`../../../bridge/comment-bridge.ts`](../../../bridge/comment-bridge.ts))
  auto-detects Vue vs React at runtime (`FrameworkRuntimeAdapter`: `__vueParentComponent`
  vs `__reactFiber$`) and emits a uniform `InspectionData` (incl. `editTarget`
  source coordinates) regardless of framework.
- **The server edit-handler** routes a `kind:"prop"` edit to the Vue or JSX
  applicator by the target file's **extension** (`.vue` vs `.tsx`/`.jsx`), not by
  any framework flag from the client.

So this adapter only relays the framework-neutral protocol: selection
(`selectAt`/`selectBySelector`/`selectParent`), structure, hover, DOM-edit mode,
direct-manipulation gestures, subscriptions, and `applyEdit` (which POSTs the
`editTarget` coordinate to `/api/editor/edit`). There is no Vue- or
React-specific branching here.

## What's genuinely framework-aware (and where it lives)

- Runtime component-tree walking, callsite stamps, slot/text disambiguation →
  the bridge's per-framework `FrameworkRuntimeAdapter`.
- Source edits (splice into `.vue` vs `.tsx`) → the server applicators
  (`apply-prop-edit.ts` for Vue, `apply-jsx-prop-edit.ts` for React).
- Design-system metadata (props/variants) → the manifest sources
  (`../acme-ds/`, `../vue-dts-meta/`, `../react-dts-meta/`).

`getIterationContext` reads a value the bridge already cached on the selection;
`resolveIterationDataLocation` is a framework-agnostic stub (defers to the LLM
fallback) pending per-framework static iteration analysis.

## History

Originally `Vue3FrameworkAdapter` under `adapters/vue3/`, the first (and for a
while only) substrate. When React support landed, the adapter was found to be
~99% bridge-protocol delegation with no real Vue coupling, so it was
renamed/generalized rather than duplicated.
