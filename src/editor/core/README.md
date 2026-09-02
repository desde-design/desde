# editor/core

Framework-and-design-system-neutral types and interfaces. The contracts every adapter implements.

## Rules

- No Vue, React, Angular, Svelte, or any other framework imports.
- No the design system, Material UI, Chakra, or any other design system imports.
- No DOM-API-specific types beyond what's strictly part of the abstraction (e.g., a generic `selector: string` is fine; a `HTMLButtonElement` is not).
- If a type needs to express "this came from a particular framework", it does so via a string discriminant (e.g., `framework: 'vue3' | 'react' | ...`), never via a typed import.

## Exports

Defined in [`manifest.ts`](./manifest.ts):

- `ComponentManifestSource`: abstraction for "produce normalized component metadata for a design system". One implementation per supported design system or metadata-source combination.
- `ComponentManifest`: normalized component API shape. The inspector consumes this instead of raw extractor output.
- `ComponentPropManifest`: prop metadata with `control.kind` separated from raw TypeScript schema. A TypeScript union may be raw `enum` metadata without being a finite-choice UI control.
- `ComponentSlotManifest` and `ComponentEventManifest`: framework-neutral slots/events. Vue scoped slots and React render props can both normalize here.
- `ComponentManifestExtensions`: optional docs, variant groups, state previews, data contracts, categories, and off-system policy. These are explicit extension points because TypeScript metadata alone does not supply the whole inspector model.

Defined in [`framework-adapter.ts`](./framework-adapter.ts):

- `FrameworkAdapter`: interface for "click → component tree", "select parent / child", "subscribe to selection events", "apply edit", "lifecycle". One implementation per supported framework.
- `EditResult`: `{ kind: 'applied', mode: 'deterministic' | 'agent' } | { kind: 'cancelled' } | { kind: 'failed', reason }`.
- `AdapterSubscription`: unsubscribe handle returned by event subscribers.

Defined in [`selection.ts`](./selection.ts):

- `Selection`, `SelectionTarget`, `SelectionAncestor`: selection-state shapes.
- `IframePoint`, `AdapterTarget`: coordinate and connection types.

Defined in [`edit.ts`](./edit.ts):

- `StructuralEdit`: discriminated union over `kind`. See the `StructuralEdit` export at the bottom of [`edit.ts`](./edit.ts) for the current variant list (it has grown well past the original handful: 24 variants as of this writing, including `llm-patch`, JSX-specific edits like `jsx-style`, and token/text-branch lanes. It also drifts, so this README doesn't duplicate it). The only edit type `FrameworkAdapter.applyEdit` accepts.
- `AgentRequest`: free-form prose request to the agent orchestrator. **Lives outside `StructuralEdit`.** The orchestrator interprets prompts and produces structural edits; adapters never see `AgentRequest`s. This makes "agent prompt marked deterministic" unrepresentable.
- `InsertionTarget`: `{ parentId, slot?, index }`. Used by `PasteEdit` and `MoveEdit` to express "this slot of this parent at this position." Negative `index` means "from the end."
- `ComponentRef`: design-system-qualified component reference (used by `WrapEdit`).

Defined in [`intent.ts`](./intent.ts):

- `IntentRecord`: free-form rationale capture.
- `DataBinding`: mock-data shape attached to a data-bound component, doubles as a contract for production APIs.
- `OffSystemMarker`: explicit marker that an element or property is authored off-system.

Type round-trip sanity tests live in [`types.test.ts`](./types.test.ts).
