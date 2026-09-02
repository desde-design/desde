"use client"

import { useEffect } from "react"
import {
  DesignSystemsDialog,
  ProjectConventionsDialog,
} from "@/components/editor/editor-settings-menu"
import type { SurfaceEntry, SurfaceRenderContext } from "../types"
import { jsonOverride, useFetchOverride } from "./fetch-override"
import { clickLikeUser, runDrivenInteraction, waitForElement } from "./dom-interaction"

/**
 * `EditorSettingsMenu` itself is a "⋮" dropdown — its two content dialogs
 * (`ProjectConventionsDialog`, `DesignSystemsDialog`) are ALSO exported
 * standalone from the same file, so this renders those directly rather than
 * opening the dropdown to reach them (no interaction-driving needed here;
 * the "Run smoke test" third menu item is covered separately by
 * `smoke-test-control.tsx`, which owns `SmokeTestFailureDialog`).
 *
 * `ProjectConventionsDialog` reads `useProjectKnowledge()`
 * (`src/hooks/useProjectKnowledge.ts`), which caches its
 * `/api/editor/project-knowledge` response in a MODULE-LEVEL `let cached`
 * with no exported reset — once any instance resolves a response, every
 * later mount in the SAME page load (or the same vitest module registry)
 * returns that cached value immediately, skipping the fetch entirely. That
 * makes more than one distinct state for this dialog unreliable to
 * demonstrate honestly in one registry, so this ships exactly ONE state,
 * built to exercise every conditionally-rendered section at once (native
 * files, budgeted rule files, the truncated-digest warning, the docs
 * index, and the digest text) rather than splitting them across states
 * that would silently collapse onto whichever rendered first.
 *
 * The endpoint is claimed through the shared router in `./fetch-override`,
 * which registers during render — `useProjectKnowledge`'s own fetch fires from
 * an effect on a DESCENDANT, and child effects run before a parent's, so an
 * effect-based claim here would race it and sometimes lose.
 */

const PROJECT_KNOWLEDGE = (url: string) => url.includes("/api/editor/project-knowledge")

/**
 * Shaped to match what the real endpoint can actually emit.
 *
 * `rulesFiles` may only contain paths the rules collector actually reads: the
 * fixed root set in `src/editor/adapters/conventional-rules/index.ts`
 * (`CLAUDE.md`, `AGENTS.md`, `.cursorrules`, `.windsurfrules`,
 * `.github/copilot-instructions.md`) plus `.cursor/rules/*.md(c)`. A `docs/**`
 * path can only ever reach `docIndex` — an earlier version of this fixture
 * listed `docs/design.md` as a rules file, which the product cannot produce and
 * which the same fixture then contradicted two fields later.
 */
const PROJECT_KNOWLEDGE_BODY = {
  useRepoConventions: true,
  excludeFiles: ["**/*.generated.ts"],
  sdkRuntime: true,
  nativeFiles: ["CLAUDE.md"],
  knowledge: {
    rules: "# Project conventions\n\nUse shadcn primitives. Never hardcode hex colors.\n",
    rulesFiles: [
      { path: "AGENTS.md", chars: 4210, truncated: false },
      { path: ".cursor/rules/styling.mdc", chars: 1180, truncated: true },
    ],
    docIndex: [
      { path: "docs/bridge-protocol.md", title: "Bridge Protocol: postMessage API" },
      { path: "docs/grounding-pipeline.md", title: "Grounding pipeline" },
    ],
    truncated: true,
  },
}

function ProjectConventionsFixture({ ctx }: { ctx: SurfaceRenderContext }) {
  useFetchOverride(jsonOverride(PROJECT_KNOWLEDGE, PROJECT_KNOWLEDGE_BODY))
  return <ProjectConventionsDialog open onOpenChange={(next) => ctx.log("onOpenChange", next)} />
}

/**
 * The Design systems dialog with data in it.
 *
 * Without an override `useDesignSystems` gets a 404 from the harness and the
 * dialog is permanently empty, so the only reviewable state was "nothing
 * registered yet" — and the add flow, which is most of the surface, could not
 * be looked at at all.
 *
 * Two registrations rather than one: `respond()` gets no URL, so a single
 * override cannot branch, and the suggestions route has to be matched ahead
 * of the list route it is a prefix of.
 */
const DS_SUGGESTIONS = (url: string) => url.includes("/api/editor/design-systems/suggestions")
const DS_LIST = (url: string) =>
  url.includes("/api/editor/design-systems") && !url.includes("/suggestions")

const DS_LIST_BODY = {
  designSystems: [
    {
      id: "@acme/design-system",
      source: { kind: "installed", package: "@acme/design-system" },
      package: "@acme/design-system",
      version: "4.2.0",
      framework: "vue3",
      designSystem: "@acme/design-system",
      importPath: "@acme/design-system",
      addedAt: "2026-07-02T09:14:00.000Z",
      declared: true,
      hintCoverage: { hinted: 48, verified: 41, total: 62 },
    },
  ],
  health: null,
  reconciliation: null,
  declarationsError: null,
}

const DS_SUGGESTIONS_BODY = {
  suggestions: [
    { package: "@acme/charts", version: "2.1.3", componentCount: 14, framework: "vue3", importFrequency: 6 },
    { package: "@vueuse/components", version: "12.0.1", componentCount: 31, framework: "vue3", importFrequency: 2 },
  ],
}

function DesignSystemsFixture({
  ctx,
  drive,
}: {
  ctx: SurfaceRenderContext
  /** Clicks the flow open to the step this state is about. Omit for the list. */
  drive?: (isCancelled: () => boolean) => Promise<void>
}) {
  useFetchOverride(jsonOverride(DS_SUGGESTIONS, DS_SUGGESTIONS_BODY))
  useFetchOverride(jsonOverride(DS_LIST, DS_LIST_BODY))

  useEffect(() => {
    if (!drive) return
    let cancelled = false
    runDrivenInteraction(() => drive(() => cancelled))
    return () => {
      cancelled = true
    }
  }, [drive])

  return (
    <DesignSystemsDialog
      open
      onOpenChange={(next) => ctx.log("onOpenChange", next)}
      invalidateManifest={(entries) => ctx.log("invalidateManifest", entries.length)}
    />
  )
}

function testid<T extends Element = Element>(id: string): T | null {
  return document.querySelector<T>(`[data-testid="${id}"]`)
}

async function openAddFlow(isCancelled: () => boolean): Promise<boolean> {
  const open = await waitForElement(() => testid<HTMLButtonElement>("open-add-design-system"))
  if (isCancelled() || !open) return false
  clickLikeUser(open)
  return !isCancelled()
}

const driveToSourceStep = async (isCancelled: () => boolean): Promise<void> => {
  await openAddFlow(isCancelled)
}

const driveToRepoStep = async (isCancelled: () => boolean): Promise<void> => {
  if (!(await openAddFlow(isCancelled))) return
  const repo = await waitForElement(() => testid<HTMLElement>("add-design-system-repo"))
  if (isCancelled() || !repo) return
  clickLikeUser(repo)
  const next = await waitForElement(() => {
    const button = testid<HTMLButtonElement>("add-design-system-next")
    return button && !button.disabled ? button : null
  })
  if (isCancelled() || !next) return
  clickLikeUser(next)
}

export const EDITOR_SETTINGS_MENU_SURFACE: SurfaceEntry = {
  id: "editor-settings-menu",
  title: "Editor settings: references / design systems",
  kind: "modal",
  sourceFile: "src/components/editor/editor-settings-menu.tsx",
  states: [
    {
      id: "editor-settings-menu/project-conventions",
      label: "Model & references: full digest",
      render: (ctx) => <ProjectConventionsFixture ctx={ctx} />,
    },
    {
      id: "editor-settings-menu/design-systems",
      label: "Design systems: one registered",
      render: (ctx) => <DesignSystemsFixture ctx={ctx} />,
    },
    {
      id: "editor-settings-menu/design-systems-empty",
      label: "Design systems: none registered yet",
      render: (ctx) => (
        <DesignSystemsDialog
          open
          onOpenChange={(next) => ctx.log("onOpenChange", next)}
          invalidateManifest={(entries) => ctx.log("invalidateManifest", entries.length)}
        />
      ),
    },
    {
      id: "editor-settings-menu/design-systems-add-source",
      label: "Add design system: where from",
      readyWhen: '[data-testid="add-design-system-source"]',
      render: (ctx) => <DesignSystemsFixture ctx={ctx} drive={driveToSourceStep} />,
    },
    {
      id: "editor-settings-menu/design-systems-add-repo",
      label: "Add design system: git repository form",
      readyWhen: '[data-testid="add-design-system-repo-step"]',
      render: (ctx) => <DesignSystemsFixture ctx={ctx} drive={driveToRepoStep} />,
    },
  ],
}
