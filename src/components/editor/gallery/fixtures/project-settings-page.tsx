"use client"

import { ProjectSettingsPage } from "@/components/editor/launcher/project-settings-page"
import type { SurfaceEntry, SurfaceRenderContext } from "../types"
import { useFetchOverride, jsonOverride } from "./fetch-override"

/**
 * The edit counterpart to the New Project surface.
 *
 * Every state is driven by the ONE read route the page opens with
 * (`/api/launcher/project-settings`), so the fixtures are just bodies. The
 * mutations are stubbed to a plain success and are not what these states are
 * for — what wants reviewing here is the shape: three sections stacked under
 * "All", one under a tab, and the two states where the config is wrong.
 */

const PATH = "/Users/designer/prototypes/ai-gateway"

const SETTINGS = (over: Record<string, unknown> = {}) => ({
  ok: true,
  path: PATH,
  name: "AI Gateway Prototype",
  designSystems: [
    {
      identity: "@acme/design-system",
      declaration: { source: { kind: "package", spec: "@acme/design-system" } },
    },
    {
      identity: "github:acme/ui-kit",
      declaration: { source: { kind: "git", repo: "github:acme/ui-kit" } },
    },
  ],
  readRoots: [
    {
      name: "billing-web",
      path: "/Users/designer/repos/billing-web",
      description: "The production app this prototype should match.",
    },
    { name: "brand", path: "/Users/designer/repos/brand", description: "" },
  ],
  warnings: [],
  ...over,
})

const EMPTY = SETTINGS({ designSystems: [], readRoots: [] })

const MALFORMED = SETTINGS({
  designSystems: [],
  warnings: ['desde.config.json: designSystems[1]: "spec" must be a string'],
})

function Fixture({
  ctx,
  body,
}: {
  ctx: SurfaceRenderContext
  body: unknown
}) {
  useFetchOverride(jsonOverride((url) => url.includes("/api/launcher/"), body))
  return (
    // `w-full` is load-bearing, not decoration. The page's root is `flex-1`
    // inside a flex COLUMN, so it takes its width from this wrapper — and the
    // gallery's inline host does not stretch its child. Without it the whole
    // surface measured 0px wide and screenshotted blank while every element
    // was present in the DOM.
    <div className="flex min-h-[40rem] w-full flex-col bg-background">
      <ProjectSettingsPage
        path={PATH}
        onClose={() => ctx.log("onClose")}
        onInspectReadRoot={async (candidate) => {
          ctx.log("onInspectReadRoot", candidate)
          return null
        }}
      />
    </div>
  )
}

export const PROJECT_SETTINGS_SURFACE: SurfaceEntry = {
  id: "project-settings",
  title: "Project settings (tabs, not a stepper)",
  kind: "inline",
  sourceFile: "src/components/editor/launcher/project-settings-page.tsx",
  states: [
    {
      id: "project-settings/all",
      label: "All sections",
      readyWhen: '[data-testid="settings-section-reference-dirs"]',
      render: (ctx) => <Fixture ctx={ctx} body={SETTINGS()} />,
    },
    {
      id: "project-settings/empty",
      label: "Nothing configured yet",
      readyWhen: '[data-testid="settings-section-reference-dirs"]',
      render: (ctx) => <Fixture ctx={ctx} body={EMPTY} />,
    },
    {
      id: "project-settings/malformed",
      label: "Config is malformed",
      readyWhen: '[data-testid="project-settings-warnings"]',
      render: (ctx) => <Fixture ctx={ctx} body={MALFORMED} />,
    },
    {
      id: "project-settings/read-failed",
      label: "The project could not be read",
      readyWhen: '[data-testid="project-settings-error"]',
      render: (ctx) => (
        <Fixture ctx={ctx} body={{ ok: false, reason: "Directory not found" }} />
      ),
    },
  ],
}
