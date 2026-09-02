/**
 * A handful of realistic Acme DS-shaped manifests, projected through the
 * REAL `buildCatalog` the server uses (`src/editor/edit-service/component-catalog.ts`)
 * — not a hand-shaped `CatalogEntry[]` — so the variant-hint derivation
 * (finite-choice → axis, boolean → `[false, true]`) is computed the exact
 * same way the CLI's `/api/editor/catalog` route computes it.
 *
 * Shared by two consumers that must agree on the same data:
 * `editor-cli/self-host/src/mock-backend.ts` (the harness's live default
 * for `/api/editor/catalog`) and `fixtures/swap.tsx`'s `swap/populated`
 * state (which overrides the same endpoint locally so the state renders the
 * same catalog under Vitest too, where the registry render test's own
 * global fetch stub would otherwise always answer `[]`).
 */

import type { ComponentManifest } from "@/editor/core"
import { buildCatalog, type CatalogEntry } from "@/editor/edit-service/component-catalog"

const SAMPLE_MANIFESTS: ComponentManifest[] = [
  {
    id: "acme-ds/UiButton",
    name: "UiButton",
    framework: "vue3",
    designSystem: "acme-ds",
    importPath: "@acme/design-system",
    description: "Primary action button.",
    props: [
      {
        name: "appearance",
        type: "'primary' | 'secondary' | 'tertiary' | 'danger'",
        required: false,
        control: {
          kind: "finite-choice",
          options: [
            { label: "primary", value: "primary" },
            { label: "secondary", value: "secondary" },
            { label: "tertiary", value: "tertiary" },
            { label: "danger", value: "danger" },
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
  },
  {
    id: "acme-ds/UiInput",
    name: "UiInput",
    framework: "vue3",
    designSystem: "acme-ds",
    importPath: "@acme/design-system",
    description: "Text input with label and validation states.",
    props: [
      { name: "modelValue", type: "string", required: false, control: { kind: "text" } },
      { name: "label", type: "string", required: false, control: { kind: "text" } },
      {
        name: "state",
        type: "'default' | 'error' | 'success'",
        required: false,
        control: {
          kind: "finite-choice",
          options: [
            { label: "default", value: "default" },
            { label: "error", value: "error" },
            { label: "success", value: "success" },
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
    ],
  },
  {
    id: "acme-ds/UiBadge",
    name: "UiBadge",
    framework: "vue3",
    designSystem: "acme-ds",
    importPath: "@acme/design-system",
    description: "Small status/count indicator.",
    props: [
      {
        name: "appearance",
        type: "'primary' | 'success' | 'warning' | 'danger'",
        required: false,
        control: {
          kind: "finite-choice",
          options: [
            { label: "primary", value: "primary" },
            { label: "success", value: "success" },
            { label: "warning", value: "warning" },
            { label: "danger", value: "danger" },
          ],
        },
      },
    ],
  },
  {
    id: "first-party/PricingCard",
    name: "PricingCard",
    framework: "vue3",
    designSystem: "first-party",
    description: "App-authored pricing tier card.",
    props: [
      { name: "title", type: "string", required: true, control: { kind: "text" } },
      { name: "price", type: "string", required: true, control: { kind: "text" } },
      { name: "highlighted", type: "boolean", required: false, control: { kind: "boolean" } },
    ],
  },
]

/** `CatalogEntry[]` for the four sample manifests above, built the real way. */
export function sampleCatalogEntries(): CatalogEntry[] {
  return buildCatalog(SAMPLE_MANIFESTS)
}
