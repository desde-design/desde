"use client"

import { CapabilitiesDialog } from "@/components/editor/editor-settings-menu"
import { ExtensionKeyDialog } from "@/components/editor/extension-key-dialog"
import type { SurfaceEntry, SurfaceRenderContext } from "../types"
import { jsonOverride, useFetchOverride } from "./fetch-override"

/**
 * The Extensions dialog (`CapabilitiesDialog` hosting `CapabilitiesPanel`).
 *
 * It had no gallery state until 2026-08-09, which is how its three stacked
 * problem banners went unnoticed through a design review of everything around
 * it: nothing could show them side by side.
 *
 * Bodies below are shaped to what `GET /api/editor/capabilities` can actually
 * emit (`editor-cli/src/server/capabilities-handler.ts`), not invented:
 *
 *  - `capabilities` is always the WHOLE catalog
 *    (`src/editor/core/capability-catalog.ts`), currently exactly two entries,
 *    with `enabled` computed per request. It is not a list of enabled things.
 *  - `enableable` is `target === "mcp-extension"`, so `web-search` can never
 *    carry an Enable button; the panel shows guidance instead.
 *  - **`configError` and `warnings` are mutually exclusive.** The handler
 *    returns `warnings: loaded.ok ? loaded.warnings : []`, so a config that
 *    failed to parse reports the error and no warnings. The two states below
 *    respect that; a fixture showing both at once would be showing something
 *    the server cannot produce.
 *  - `unknownExtensions` is whatever the user hand-wrote in `.mcp.json` that
 *    the catalog has no entry for.
 *
 * Not fixtured, and reachable only through interaction: `state.error` (a failed
 * enable POST) can co-render with warnings from an earlier successful load,
 * which is the one path that puts a destructive and a warning message in the
 * problems region together. The per-message tone classes exist for it.
 */

const CAPABILITIES = (url: string) => url.includes("/api/editor/capabilities")

const FIGMA_OFF = {
  id: "figma",
  label: "Figma",
  summary:
    "Build a screen from a Figma frame, using the project's own components.",
  target: "mcp-extension" as const,
  activation: "next-message" as const,
  requiresEnv: "FIGMA_API_KEY",
  secretStored: false,
  secretFromEnvironment: false,
  enabled: false,
  enableable: true,
  envReady: false,
}

const WEB_SEARCH_ON = {
  id: "web-search",
  label: "Web search",
  summary: "Look things up online while building.",
  target: "web-search" as const,
  activation: "next-message" as const,
  requiresEnv: null,
  secretStored: false,
  secretFromEnvironment: false,
  enabled: true,
  enableable: false,
  envReady: true,
}

/**
 * The state the API key form exists for: written into `.mcp.json`, skipped by
 * the loader, nothing working. Before 2026-08-18 this card printed
 * `export FIGMA_API_KEY=…` and told the user to restart.
 */
const NEEDS_KEY = {
  ok: true,
  configError: null,
  warnings: [],
  capabilities: [{ ...FIGMA_OFF, enabled: true, envReady: false }, WEB_SEARCH_ON],
  unknownExtensions: [],
}

const HEALTHY = {
  ok: true,
  configError: null,
  warnings: [],
  capabilities: [FIGMA_OFF, WEB_SEARCH_ON],
  // A hand-written server with no catalog entry, shown read-only.
  unknownExtensions: ["playwright"],
}

const WITH_WARNING = {
  ok: true,
  configError: null,
  // Verbatim shape from `loadExtensions` (src/editor/core/extensions-config.ts):
  // the declared-but-unset case, which is the most useful thing the panel says.
  warnings: [
    "figma: skipped, ${FIGMA_API_KEY} is not set in this shell. Export it and restart to enable it.",
  ],
  capabilities: [FIGMA_OFF, WEB_SEARCH_ON],
  unknownExtensions: [],
}

const WITH_CONFIG_ERROR = {
  ok: true,
  // `loaded.errors.join("; ")`, and warnings are empty by construction here.
  configError: "figma: 'command' must be a bare executable name or path",
  warnings: [],
  capabilities: [FIGMA_OFF, WEB_SEARCH_ON],
  unknownExtensions: [],
}

function CapabilitiesFixture({
  ctx,
  body,
}: {
  ctx: SurfaceRenderContext
  body: unknown
}) {
  useFetchOverride(jsonOverride(CAPABILITIES, body))
  return (
    <CapabilitiesDialog open onOpenChange={(next) => ctx.log("onOpenChange", next)} />
  )
}

/**
 * The form on its own, so both of its shapes get reviewed. The
 * `fromEnvironment` shape has no field at all and a disabled Save — saving
 * would report success and change nothing, because an exported value always
 * wins over a stored one.
 */
function KeyFormFixture({
  ctx,
  fromEnvironment = false,
}: {
  ctx: SurfaceRenderContext
  fromEnvironment?: boolean
}) {
  return (
    <ExtensionKeyDialog
      open
      onOpenChange={(next) => ctx.log("onOpenChange", next)}
      label="Figma"
      name="FIGMA_API_KEY"
      stored={false}
      fromEnvironment={fromEnvironment}
      onSave={async (name, value) => {
        ctx.log("onSave", name, value === null ? "cleared" : "a key")
        return { ok: true }
      }}
    />
  )
}

export const CAPABILITIES_SURFACE: SurfaceEntry = {
  id: "capabilities",
  title: "Extensions (what the agent can reach)",
  kind: "modal",
  sourceFile: "src/components/editor/capabilities-panel.tsx",
  states: [
    {
      id: "capabilities/healthy",
      label: "Healthy, with a hand-written server",
      render: (ctx) => <CapabilitiesFixture ctx={ctx} body={HEALTHY} />,
      readyWhen: '[data-testid="capabilities-panel"] [data-testid^="capability-row-"]',
    },
    {
      id: "capabilities/needs-key",
      label: "Turned on, but it still needs an API key",
      render: (ctx) => <CapabilitiesFixture ctx={ctx} body={NEEDS_KEY} />,
      readyWhen: '[data-testid="capability-key-figma"]',
    },
    {
      id: "capabilities/key-form",
      label: "The API key form",
      render: (ctx) => <KeyFormFixture ctx={ctx} />,
      readyWhen: '[data-testid="extension-key-input"]',
    },
    {
      id: "capabilities/key-form-external",
      label: "API key form, key already set outside the app",
      render: (ctx) => <KeyFormFixture ctx={ctx} fromEnvironment />,
      readyWhen: '[role="dialog"]',
    },
    {
      id: "capabilities/warning",
      label: "Declared but its key is missing",
      render: (ctx) => <CapabilitiesFixture ctx={ctx} body={WITH_WARNING} />,
      readyWhen: '[data-testid="capabilities-panel"] [data-slot="callout"]',
    },
    {
      id: "capabilities/config-error",
      label: "Malformed .mcp.json",
      render: (ctx) => <CapabilitiesFixture ctx={ctx} body={WITH_CONFIG_ERROR} />,
      readyWhen: '[data-testid="capabilities-panel"] [role="alert"]',
    },
  ],
}
