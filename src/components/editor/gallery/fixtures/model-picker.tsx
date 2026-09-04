"use client"

/**
 * Surface-gallery fixture for the chat model picker.
 *
 * There was no picker surface at all before multi-provider work: the chip
 * needs a live catalog fetch, so it could not be summoned without a server.
 * `useFetchOverride` answers that fetch, which is what makes the grouped menu
 * reviewable next to the single-provider one it replaces.
 *
 * The chip caches its catalog at MODULE scope (`catalogCache`, plus a
 * `pickedThisLoad` memory — see the module comment on `model-picker-chip.tsx`).
 * Two states rendered from the SAME module instance would leak the first
 * state's catalog into every state after it: the sweep test renders every
 * state in this file inside one run, so that leak would be real here, not a
 * theoretical worry. Each state below therefore renders a SEPARATE
 * `React.lazy` wrapper around a freshly imported copy of the chip, tagged
 * with a cache-busting query string on the import specifier — the same
 * trick the chip's own tests reach for with `vi.resetModules()`, done here
 * so it also works in a real browser, where `vi` does not exist.
 *
 * The lazy wrappers are declared at MODULE scope, one per state, rather than
 * built inside a component from a custom hook — React (and this repo's
 * `react-hooks/static-components` lint rule) requires a component's identity
 * to be stable across renders, and a hook returning a fresh component
 * reference on every mount is exactly the pattern that rule exists to catch.
 */

import { lazy, Suspense, useState, type ComponentType } from "react"
import type { SessionModelConfig } from "@/editor/core/model-catalog"
import type { ModelPickerChipProps } from "@/components/editor/model-picker-chip"
import type { SurfaceEntry } from "../types"
import { InlineFrame } from "./inline-frame"
import { jsonOverride, useFetchOverride } from "./fetch-override"

const CATALOG_ROUTE = (url: string) => url.includes("/api/editor/chat/model-catalog")

/** One cache-busted import per state — each resolves to its OWN module instance. */
function freshModelPickerChip(bustId: string): Promise<{
  default: ComponentType<ModelPickerChipProps>
}> {
  return (
    import(
      /* @vite-ignore */ `../../model-picker-chip.tsx?gallery-bust=${bustId}`
    ) as Promise<typeof import("@/components/editor/model-picker-chip")>
  ).then((mod) => ({ default: mod.ModelPickerChip }))
}

const ChipOneProvider = lazy(() => freshModelPickerChip("one-provider"))
const ChipTwoProviders = lazy(() => freshModelPickerChip("two-providers"))
const ChipOpenaiChosen = lazy(() => freshModelPickerChip("openai-chosen"))
const ChipNoEffortModel = lazy(() => freshModelPickerChip("no-effort-model"))
const ChipStaleProvider = lazy(() => freshModelPickerChip("stale-provider"))

function ModelPickerFixture({
  Chip,
  catalogBody,
  initialValue,
}: {
  Chip: ComponentType<ModelPickerChipProps>
  catalogBody: unknown
  initialValue: SessionModelConfig | null
}) {
  useFetchOverride(jsonOverride(CATALOG_ROUTE, catalogBody))
  // A stateful wrapper, not a frozen prop — the "stale provider" state below
  // reconciles to null from an effect inside the chip, and an assertion
  // about what the chip renders AFTER that would be vacuous against a value
  // that never moves.
  const [value, setValue] = useState<SessionModelConfig | null>(initialValue)
  return (
    <InlineFrame>
      <Suspense fallback={null}>
        <Chip value={value} onChange={setValue} />
      </Suspense>
    </InlineFrame>
  )
}

/** Every state settles on the chip itself, which renders for all of them. */
const READY_WHEN = "[data-testid='editor-model-chip']"

const ANTHROPIC_CATALOG = [
  {
    providerId: "anthropic",
    models: [
      {
        id: "claude-opus-4-8",
        label: "Opus 4.8",
        effortLevels: ["low", "medium", "high", "xhigh", "max"],
        isDefault: true,
      },
      { id: "claude-haiku-4-5", label: "Haiku 4.5", effortLevels: null },
    ],
  },
]

const OPENAI_CATALOG = [
  {
    providerId: "openai",
    models: [
      {
        id: "gpt-5.2",
        label: "GPT-5.2",
        effortLevels: ["low", "medium", "high"],
        isDefault: true,
      },
    ],
  },
]

const ONE_PROVIDER_CATALOG = {
  catalogs: ANTHROPIC_CATALOG,
  default: { provider: "anthropic", model: "claude-opus-4-8" },
  defaultProviderId: "anthropic",
}

const TWO_PROVIDER_CATALOG = {
  catalogs: [...ANTHROPIC_CATALOG, ...OPENAI_CATALOG],
  default: { provider: "anthropic", model: "claude-opus-4-8" },
  defaultProviderId: "anthropic",
}

export const MODEL_PICKER_SURFACE: SurfaceEntry = {
  id: "model-picker",
  title: "Chat: the model picker",
  kind: "inline",
  sourceFile: "src/components/editor/model-picker-chip.tsx",
  states: [
    {
      id: "model-picker/one-provider",
      label: "One provider (today's look)",
      readyWhen: READY_WHEN,
      render: () => (
        <ModelPickerFixture
          Chip={ChipOneProvider}
          catalogBody={ONE_PROVIDER_CATALOG}
          initialValue={null}
        />
      ),
    },
    {
      id: "model-picker/two-providers",
      label: "Two providers, grouped",
      readyWhen: READY_WHEN,
      render: () => (
        <ModelPickerFixture
          Chip={ChipTwoProviders}
          catalogBody={TWO_PROVIDER_CATALOG}
          initialValue={null}
        />
      ),
    },
    {
      id: "model-picker/openai-chosen",
      label: "Two providers, OpenAI model chosen",
      readyWhen: READY_WHEN,
      render: () => (
        <ModelPickerFixture
          Chip={ChipOpenaiChosen}
          catalogBody={TWO_PROVIDER_CATALOG}
          initialValue={{ provider: "openai", model: "gpt-5.2" }}
        />
      ),
    },
    {
      id: "model-picker/no-effort-model",
      label: "A model with no effort levels (effort control hidden)",
      readyWhen: READY_WHEN,
      render: () => (
        <ModelPickerFixture
          Chip={ChipNoEffortModel}
          catalogBody={TWO_PROVIDER_CATALOG}
          initialValue={{ provider: "anthropic", model: "claude-haiku-4-5" }}
        />
      ),
    },
    {
      id: "model-picker/stale-provider",
      label: "Session's provider no longer served (drops to default)",
      readyWhen: READY_WHEN,
      render: () => (
        <ModelPickerFixture
          Chip={ChipStaleProvider}
          catalogBody={ONE_PROVIDER_CATALOG}
          initialValue={{ provider: "openai", model: "gpt-5.2" }}
        />
      ),
    },
  ],
}
