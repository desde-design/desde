"use client"

import { useEffect } from "react"
import { NewProjectPage } from "@/components/editor/launcher/new-project-page"
import type { LauncherOpenBlock, LauncherSupportedHost } from "@/types/launcher"
import type { SurfaceEntry, SurfaceRenderContext } from "../types"
import { clickLikeUser, runDrivenInteraction, setNativeValue, waitForElement } from "./dom-interaction"

// `NewProjectPageProps` itself isn't exported — mirrors this codebase's own
// `type EditingApi = ReturnType<typeof useEditorEditing>` pattern
// (branch-mode-controls.tsx) for deriving an un-exported prop type from the
// exported component instead of re-declaring it.
type NewProjectPageProps = Parameters<typeof NewProjectPage>[0]

/**
 * `NewProjectPage`'s "source" step is fully prop-driven (`initialSource`,
 * `folderPickerSupported`, `busy`, `error`), but the later "name" and
 * "design-systems" steps live behind internal `useState` reached only by
 * completing the earlier step — there is no `initialStep` prop. Every
 * dependency the transition needs (`onPickFolder`, `onSuggestDesignSystems`,
 * …) is a plain injected callback we fully control, so this fixture drives
 * the same interaction a user would (click the folder tile, type a name,
 * continue) rather than inventing a shortcut prop.
 */

const CHOSEN_PATH = "/Users/designer/prototypes/ai-gateway"
const PROJECT_NAME = "AI Gateway Prototype"

/** Stands in for `gh repo list`, newest first as the server sorts it. */
const GITHUB_REPOS = [
  { nameWithOwner: "acme/ai-gateway-prototype", name: "ai-gateway-prototype", isPrivate: true, updatedAt: "2026-08-09T18:00:00Z" },
  { nameWithOwner: "acme/checkout-redesign", name: "checkout-redesign", isPrivate: true, updatedAt: "2026-08-07T11:20:00Z" },
  { nameWithOwner: "acme/design-system", name: "design-system", isPrivate: false, updatedAt: "2026-07-30T09:05:00Z" },
  { nameWithOwner: "designer/portfolio", name: "portfolio", isPrivate: false, updatedAt: "2026-06-14T22:41:00Z" },
]

/**
 * Sample refusals, shaped exactly as `checkLauncherOpen` builds them
 * (`editor-cli/src/server/launcher-open-check.ts`). The `supported` list is
 * derived from the host registry at runtime; these literals stand in for one
 * plausible build so the surface can be reviewed without a CLI.
 */
const SUPPORTED_HOSTS: LauncherSupportedHost[] = [
  { id: "vite", label: "Vite" },
  { id: "nuxt", label: "Nuxt" },
  { id: "react-router", label: "React Router" },
  { id: "next", label: "Next.js" },
]

/**
 * A framework that resolves to a host this project will not boot. Astro is the
 * only one today, and since 2026-08-17 it gets the SAME generic refusal as any
 * unsupported framework: no per-host explanation, no config switch, no dormant
 * list. See `launcher-open-check.ts` where `WHY_OFF` used to be.
 */
const BLOCK_HOST_OFF: LauncherOpenBlock = {
  code: "framework-unsupported",
  summary: "Astro isn't supported.",
  remediation: [],
  attachCovers: false,
  supported: SUPPORTED_HOSTS,
}

/**
 * The one refusal decided AFTER a spawn, and the only one whose `cause` is
 * another process's stderr rather than our own prose — so it is the state that
 * proves the quoted-output treatment reads correctly next to our own numbered
 * steps.
 *
 * It was an ASTRO repo until 2026-08-18, which made it a fixture of an
 * impossible state: Astro is refused by `BLOCK_HOST_OFF` above, before any
 * spawn, so no Astro project can ever reach a post-spawn failure. It also
 * carried the pre-2026-08-18 copy that told the reader to run
 * `desde … --attach`. Next is a default-ON in-process host, so a
 * boot failure there is a state that actually happens.
 */
const BLOCK_BOOT_FAILED: LauncherOpenBlock = {
  code: "boot-failed",
  summary: "This project could not be started.",
  cause:
    "This project declares Next.js but next is not installed.\n\n" +
    "Attach mode does not use this seam and covers Next.js fully:\n" +
    "it runs this project's own dev server (npx next dev) and connects to it.",
  remediation: [
    "Install this project's dependencies in /Users/designer/prototypes/next-site, then open it again.",
    "If they are already installed, start the project's own dev server by itself — Editor runs that same server, so whatever stops it there is what stopped it here.",
  ],
  attachCovers: true,
  supported: SUPPORTED_HOSTS,
}

/**
 * Matches what `FRAMEWORK_SUMMARY` actually produces now. It carried the old
 * copy until 2026-08-17 ("This project is neither Vue 3 nor React, and Editor
 * edits only those", plus a remediation step about Svelte having no source
 * stamper) — a fixture showing copy the product no longer writes is worse than
 * no fixture, because it gets reviewed and approved.
 */
const BLOCK_UNSUPPORTED: LauncherOpenBlock = {
  code: "framework-unsupported",
  summary: "This prototype's framework isn't supported.",
  cause:
    "/Users/designer/prototypes/svelte-app/package.json has neither a 'vue' nor a 'react' dependency.",
  remediation: [],
  attachCovers: false,
  supported: SUPPORTED_HOSTS,
}

function testid<T extends Element = Element>(id: string): T | null {
  return document.querySelector<T>(`[data-testid="${id}"]`)
}

/** Base callbacks every state needs, all logged to the gallery's action log. */
function baseProps(ctx: SurfaceRenderContext): Omit<
  NewProjectPageProps,
  "open" | "onOpenChange" | "folderPickerSupported" | "busy"
> {
  return {
    onInspectPath: async (path) => {
      ctx.log("onInspectPath", path)
      return { block: null, error: null }
    },
    onPickFolder: async () => {
      ctx.log("onPickFolder")
      return { supported: true, path: CHOSEN_PATH }
    },
    onOpenPath: async (path) => {
      ctx.log("onOpenPath", path)
    },
    onSetProjectName: async (path, name) => {
      ctx.log("onSetProjectName", path, name)
      return { ok: true }
    },
    onClone: async (repoUrl) => {
      ctx.log("onClone", repoUrl)
      return { path: "/Users/designer/prototypes/cloned-repo" }
    },
    onSuggestDesignSystems: async (path) => {
      ctx.log("onSuggestDesignSystems", path)
      return [
        { package: "@acme/design-system", componentCount: 42, framework: "vue3" },
        { package: "@ag-grid-community/core", componentCount: 8, framework: "vue3" },
      ]
    },
    onDeclareDesignSystems: async (path, declarations) => {
      ctx.log("onDeclareDesignSystems", path, declarations.length)
      return { ok: true }
    },
  }
}

/**
 * Drive the source step through to the name step: pick "local", Browse,
 * Continue. Shared by both fixtures below, which otherwise repeat it verbatim.
 *
 * Returns false when the caller has unmounted mid-walk, so the caller can stop.
 */
async function reachNameStep(isCancelled: () => boolean): Promise<boolean> {
  const local = await waitForElement(() => testid<HTMLButtonElement>("new-project-local"))
  if (isCancelled() || !local) return false
  // Selecting the card reveals its form in place — there is no Next between
  // them any more, because a Next that left the stepper where it was told the
  // user their progress did not count.
  clickLikeUser(local)

  const browse = await waitForElement(() => testid<HTMLButtonElement>("new-project-browse"))
  if (isCancelled() || !browse) return false
  clickLikeUser(browse)

  const cont = await waitForElement(() => {
    const button = testid<HTMLButtonElement>("new-project-local-continue")
    return button && !button.disabled ? button : null
  })
  if (isCancelled() || !cont) return false
  clickLikeUser(cont)
  return true
}

function NameStepFixture({ ctx }: { ctx: SurfaceRenderContext }) {
  useEffect(() => {
    let cancelled = false
    runDrivenInteraction(async () => {
      if (!(await reachNameStep(() => cancelled))) return
    })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <NewProjectPage
      open
      onOpenChange={(next) => ctx.log("onOpenChange", next)}
      folderPickerSupported
      busy={false}
      {...baseProps(ctx)}
    />
  )
}

/** Clicks through "name" into "design-systems", filling the name first. */
function DesignSystemsStepFixture({ ctx }: { ctx: SurfaceRenderContext }) {
  useEffect(() => {
    let cancelled = false
    runDrivenInteraction(async () => {
      if (!(await reachNameStep(() => cancelled))) return

      const nameInput = await waitForElement(
        () => document.getElementById("new-project-name") as HTMLInputElement | null,
      )
      if (cancelled || !nameInput) return
      setNativeValue(nameInput, PROJECT_NAME)

      const continueBtn = await waitForElement(() => {
        const btn = testid<HTMLButtonElement>("new-project-name-continue")
        return btn && !btn.disabled ? btn : null
      })
      if (cancelled || !continueBtn) return
      clickLikeUser(continueBtn)
    })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <NewProjectPage
      open
      onOpenChange={(next) => ctx.log("onOpenChange", next)}
      folderPickerSupported
      busy={false}
      {...baseProps(ctx)}
    />
  )
}

export const NEW_PROJECT_DIALOG_SURFACE: SurfaceEntry = {
  id: "new-project-page",
  title: "New project (page)",
  // `page`, not `modal`: this stopped being a dialog on 2026-08-17.
  kind: "page",
  sourceFile: "src/components/editor/launcher/new-project-page.tsx",
  states: [
    {
      id: "new-project-page/source",
      label: "Source step: pick local or clone",
      render: (ctx) => (
        <NewProjectPage
          open
          onOpenChange={(next) => ctx.log("onOpenChange", next)}
          folderPickerSupported
          busy={false}
          {...baseProps(ctx)}
        />
      ),
    },
    {
      id: "new-project-page/clone-github",
      label: "Clone step: pick from your GitHub repositories",
      render: (ctx) => (
        <NewProjectPage
          open
          onOpenChange={(next) => ctx.log("onOpenChange", next)}
          initialSource="clone"
          folderPickerSupported
          busy={false}
          onListGitHubRepos={async () => {
            ctx.log("onListGitHubRepos")
            return { available: true, repos: GITHUB_REPOS }
          }}
          {...baseProps(ctx)}
        />
      ),
    },
    {
      id: "new-project-page/clone-signed-out",
      label: "Clone step: GitHub CLI present but signed out",
      render: (ctx) => (
        <NewProjectPage
          open
          onOpenChange={(next) => ctx.log("onOpenChange", next)}
          initialSource="clone"
          folderPickerSupported
          busy={false}
          onListGitHubRepos={async () => {
            ctx.log("onListGitHubRepos")
            return { available: false, reason: "not-authenticated" }
          }}
          {...baseProps(ctx)}
        />
      ),
    },
    {
      id: "new-project-page/source-clone",
      label: "Clone step: URL only, no GitHub CLI installed",
      render: (ctx) => (
        <NewProjectPage
          open
          onOpenChange={(next) => ctx.log("onOpenChange", next)}
          initialSource="clone"
          folderPickerSupported
          busy={false}
          onListGitHubRepos={async () => {
            ctx.log("onListGitHubRepos")
            return { available: false, reason: "not-installed" }
          }}
          {...baseProps(ctx)}
        />
      ),
    },
    {
      id: "new-project-page/source-manual-path",
      label: "Source step: no native picker, manual path fallback",
      render: (ctx) => (
        <NewProjectPage
          open
          onOpenChange={(next) => ctx.log("onOpenChange", next)}
          initialSource="local"
          folderPickerSupported={false}
          busy={false}
          {...baseProps(ctx)}
        />
      ),
    },
    {
      id: "new-project-page/error",
      label: "Source step: action error",
      render: (ctx) => (
        <NewProjectPage
          open
          onOpenChange={(next) => ctx.log("onOpenChange", next)}
          folderPickerSupported
          busy={false}
          error="Couldn't clone that repository: the URL returned a 404."
          {...baseProps(ctx)}
        />
      ),
    },
    /**
     * The shapes of "we cannot open this folder", which used to be one shape:
     * `editor exited before it was ready (code 4)`.
     *
     * The first two now render IDENTICALLY apart from their summary, and that
     * is the point of keeping both: an unsupported framework and a dormant one
     * are the same refusal to a user, so a fixture that made them look
     * different would be showing a distinction the product deliberately
     * dropped.
     */
    {
      id: "new-project-page/blocked-host-off",
      label: "Source step: a framework that isn't supported (Astro)",
      render: (ctx) => (
        <NewProjectPage
          open
          onOpenChange={(next) => ctx.log("onOpenChange", next)}
          folderPickerSupported
          busy={false}
          openBlock={BLOCK_HOST_OFF}
          {...baseProps(ctx)}
        />
      ),
    },
    {
      id: "new-project-page/blocked-unsupported",
      label: "Source step: the repo is not one that can be edited",
      render: (ctx) => (
        <NewProjectPage
          open
          onOpenChange={(next) => ctx.log("onOpenChange", next)}
          folderPickerSupported
          busy={false}
          openBlock={BLOCK_UNSUPPORTED}
          {...baseProps(ctx)}
        />
      ),
    },
    {
      id: "new-project-page/blocked-boot-failed",
      label: "Source step: the boot failed, and said why",
      render: (ctx) => (
        <NewProjectPage
          open
          onOpenChange={(next) => ctx.log("onOpenChange", next)}
          folderPickerSupported
          busy={false}
          openBlock={BLOCK_BOOT_FAILED}
          {...baseProps(ctx)}
        />
      ),
    },
    {
      id: "new-project-page/busy",
      label: "Source step: busy (tiles disabled)",
      render: (ctx) => (
        <NewProjectPage
          open
          onOpenChange={(next) => ctx.log("onOpenChange", next)}
          folderPickerSupported
          busy
          {...baseProps(ctx)}
        />
      ),
    },
    {
      id: "new-project-page/name",
      label: "Name step",
      readyWhen: '[data-testid="new-project-name-step"]',
      render: (ctx) => <NameStepFixture ctx={ctx} />,
    },
    {
      id: "new-project-page/design-systems",
      label: "Design-systems step: with suggestions",
      readyWhen: '[data-testid="new-project-design-systems-step"]',
      render: (ctx) => <DesignSystemsStepFixture ctx={ctx} />,
    },
  ],
}
