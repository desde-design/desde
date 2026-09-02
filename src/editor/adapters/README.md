# editor/adapters

Concrete implementations of the interfaces defined in [`../core/`](../core/). One subdirectory per adapter. This directory is the seam that keeps Desde a generalized product: a new framework or design system is a new adapter here, never a change to `core/` or to editor UI code.

There are ~20 subdirectories today, spanning three kinds of interface:

- **`FrameworkAdapter`** (click → component tree, apply edit): [`bridge/`](./bridge/). It is the only one. Framework-neutral; it drives both Vue 3 and React substrates over the same postMessage protocol (renamed from `vue3/` once it stopped being Vue-specific).
- **`ComponentManifestSource`** (produce normalized component metadata): [`vue-dts-meta/`](./vue-dts-meta/), [`react-dts-meta/`](./react-dts-meta/), [`local-vue/`](./local-vue/), [`local-react/`](./local-react/), [`vue-component-meta/`](./vue-component-meta/), [`storybook/`](./storybook/), [`storybook-url/`](./storybook-url/), [`hints-cache/`](./hints-cache/), [`composite/`](./composite/) (composes the others), [`cached/`](./cached/) (on-disk persistence layer), [`remote/`](./remote/) (client-side proxy to the server endpoint). [`component-meta/`](./component-meta/) is not a source. It is the shared `vue-component-meta`-shaped raw → `ComponentManifest` normalizer the dts/meta sources above all run their output through.
- **`DesignTokenSource`** (produce normalized design tokens): [`css-custom-properties/`](./css-custom-properties/), [`composite-tokens/`](./composite-tokens/) (composes the others). There is deliberately no per-design-system preset. See "No vendor adapters" below.

Everything else is a narrower adapter-shaped seam: [`conventional-rules/`](./conventional-rules/) (`ProjectKnowledgeSource`: reads `CLAUDE.md`-style agent-rule files), [`icon-sets/`](./icon-sets/) (enumerates a package's named icon exports), [`node-npm/`](./node-npm/) (`PackageManagerAdapter` + verification adapter for npm/yarn/pnpm).

For the full data-flow picture (what feeds the composite sources, cache invalidation, health tracking, priority order), read the code directly: [`composite/`](./composite/) for how manifest sources combine, [`cached/`](./cached/) for the on-disk persistence layer, and [`../core/grounding-health.ts`](../core/grounding-health.ts) for per-source health tracking. This README only orients you to the subdirectories.

## Adding a new adapter

A new framework (e.g., React) means a new `FrameworkAdapter` implementation in a new subdir (today's `bridge/` already covers Vue 3 + React, since the bridge protocol is framework-neutral. A genuinely new framework would need a new bridge-side runtime adapter more than a new `FrameworkAdapter` impl). A new design system (e.g., Material UI, or a custom team library) means a new `ComponentManifestSource`. Zero-touch auto-scan ([`vue-dts-meta/`](./vue-dts-meta/) / [`react-dts-meta/`](./react-dts-meta/)) usually covers this without new code. A new metadata source (e.g., Storybook ingestion for any framework) is also a new `ComponentManifestSource`.

The contract is that the adapter returns the normalized shape from `core/`. No editor UI code changes when an adapter is added: the inspector and action pipeline consume `ComponentManifest`s and bridge messages without caring where they came from.

## No vendor adapters

There is **no per-design-system adapter in this directory, and adding one is a
regression.** There used to be three, all for the same vendor: a
manifest source serving checked-in JSON for 7 of its components, a design-token
preset for its token package, and a `ts-declaration/` adapter whose only
production entry point was that vendor's preset. All three are deleted.

They were removed because the generic seams strictly dominate them, measured on
a real install:

- **Manifests.** `vue-dts-meta`'s auto-scan (`scanInstalledVueLibraries`) finds
  the same library with no per-package code and extracts MORE props than the
  checked-in JSON did. The static source also never won: `library-dts-auto-scan`
  is ordered ahead of it and the composite is first-source-wins.
- **Tokens.** The generic `css-custom-properties` source parses the very same
  stylesheet and classifies it BETTER (124 tokens moved from `other` into a real
  category, 0 regressions). The preset only owned the package because
  `discover.ts` explicitly skipped it for the preset's benefit.
- **Correctness.** The static source was constructed unconditionally, so every
  prototype that did NOT use that vendor got 7 phantom Vue components injected
  into its catalogue (100% of the catalogue on a plain Vue project) while
  grounding health still reported `ok`.

A vendor adapter is warranted only when a library's shape genuinely cannot be
read by the generic extractors. Prove that with a `probe-library` run before
adding one, and give it a discovery gate so it cannot contribute to a prototype
that does not have the package installed.

## Conventions every adapter must follow

Follow these five rules for every adapter:

1. **Callbacks.** Vue adapters populate `events[]` (from `defineEmits<>()`). React adapters fold callback props into `props[]` with `control.kind === 'event'` and leave `events[]` unpopulated.
2. **Slots vs. children.** Vue adapters populate `slots[]` (from `defineSlots<>()`). React adapters leave `slots[]` unpopulated and surface `children` / `asChild` / render props as ordinary props with `control.kind === 'slot'` when the inspector should treat them as drop targets.
3. **Drop optional-state values from option lists.** Strip `'undefined'` (Vue optional unions) and `'null'` (cva-style React variants) from finite-choice options. Unset state is communicated via `required: false`, never as a value-list member.
4. **Filter platform-inherited props.** React adapters MUST exclude HTML/DOM attributes inherited from `React.ComponentProps<...>` (typical pattern: exclude declarations from `node_modules/@types/react`). The shared normalizer's `node_modules` ignore predicate is the analogue. Without it, schema expansion once blew a single text-input manifest to 71 MB.
5. **Variant grouping is design-system-specific.** Adapters with explicit variant config (cva for shadcn, hand-authored for others) populate `extensions.variants`. Adapters without it leave the field undefined; the inspector falls back to treating enum props as ordinary controls.

These rules are also captured as JSDoc on the relevant types in [`../core/manifest.ts`](../core/manifest.ts).

## Iteration-aware edits (optional)

Two methods on `FrameworkAdapter` opt an adapter into the iteration-scope dialog:

- `getIterationContext(el)`: read the iteration key + index + sibling count off a live DOM node. Pure runtime; the Vue 3 adapter walks `__vueParentComponent` to find the vnode whose `props['data-desde-src']` matches and reads `vnode.key`. A React adapter would walk the fiber tree from `el[Object.keys(el).find(k => k.startsWith('__reactFiber'))]` to the parent fiber and read `fiber.key`.
- `resolveIterationDataLocation({ templateLocation, iterationContext, rootElement })`: static resolution: given the iteration's source position + key, return the array literal's source position. Returns `Unresolved` when the adapter can't trace it deterministically; the shell falls through to the LLM lane in that case.

Adapters that implement neither method are still safe: selections from them simply don't surface the dialog, and the today-behavior delete/prop/duplicate/move/insert paths run unchanged. This is the contract a future React adapter would inherit on day one before any iteration-specific code is written.

The server-side static resolvers (`resolve-iteration-data-vue.ts`, `resolve-iteration-data-vue-cross-component.ts`) and the shared array-literal rewriter (`array-literal-rewriter.ts`) all live in `../edit-service/`. Only the runtime `getIterationContext` lives per-adapter. The rewriter is JS/TS-AST work that any framework whose data is JS arrays will reuse verbatim.
