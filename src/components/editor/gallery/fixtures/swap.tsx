import type { ComponentManifest } from "@/editor/core"
import { SwapDialog } from "@/components/editor/swap-dialog"
import type { SurfaceEntry, SurfaceRenderContext } from "../types"
import { sampleCatalogEntries } from "./sample-catalog"
import { jsonOverride, useFetchOverride } from "./fetch-override"

/**
 * SwapDialog fetches /api/editor/catalog on open. The self-host mock backend's
 * OWN default for that route is a populated catalog, so it can't be relied on
 * to produce the empty-catalog rendering; and under Vitest the registry test's
 * blanket stub answers everything with a bare `[]`, which would make
 * `swap/populated` render the same empty state its sibling claims to differ
 * from. So each state claims the endpoint explicitly.
 *
 * The claim goes through the shared router in `./fetch-override` rather than
 * each state saving and restoring `window.fetch` itself — see that module for
 * why (the save/restore version rendered a populated catalog under the
 * "Catalog resolved empty" label when reached from a probe state).
 */

const CATALOG = (url: string) => url.includes("/api/editor/catalog")

function SwapFixture({
  ctx,
  catalog,
  fromManifest,
}: {
  ctx: SurfaceRenderContext
  catalog: unknown
  fromManifest: ComponentManifest | null
}) {
  useFetchOverride(jsonOverride(CATALOG, catalog))
  return (
    <SwapDialog
      open
      fromManifest={fromManifest}
      onClose={() => ctx.log("onClose")}
      onConfirm={(result) => ctx.log("onConfirm", result)}
    />
  )
}
const FROM_MANIFEST: ComponentManifest = {
  id: "acme-ds/UiButton",
  name: "UiButton",
  framework: "vue3",
  designSystem: "acme-ds",
  importPath: "@acme/design-system",
  description: "Primary action button.",
  props: [
    {
      name: "appearance",
      type: "'primary' | 'secondary' | 'tertiary'",
      required: false,
      control: {
        kind: "finite-choice",
        options: [
          { label: "primary", value: "primary" },
          { label: "secondary", value: "secondary" },
          { label: "tertiary", value: "tertiary" },
        ],
      },
    },
    {
      name: "size",
      type: "'small' | 'medium' | 'large'",
      required: false,
      control: {
        kind: "finite-choice",
        options: [
          { label: "small", value: "small" },
          { label: "medium", value: "medium" },
          { label: "large", value: "large" },
        ],
      },
    },
    { name: "disabled", type: "boolean", required: false, control: { kind: "boolean" } },
    { name: "to", type: "string", required: false, control: { kind: "text" } },
  ],
}

export const SWAP_SURFACE: SurfaceEntry = {
  id: "swap",
  title: "Swap component",
  kind: "modal",
  sourceFile: "src/components/editor/swap-dialog.tsx",
  states: [
    {
      id: "swap/empty-catalog",
      label: "Catalog resolved empty",
      render: (ctx) => <SwapFixture ctx={ctx} catalog={[]} fromManifest={FROM_MANIFEST} />,
    },
    {
      id: "swap/populated",
      label: "Catalog populated: real working layout",
      render: (ctx) => (
        <SwapFixture ctx={ctx} catalog={sampleCatalogEntries()} fromManifest={FROM_MANIFEST} />
      ),
    },
    {
      id: "swap/no-selection",
      label: "No component selected",
      render: (ctx) => <SwapFixture ctx={ctx} catalog={[]} fromManifest={null} />,
    },
  ],
}
