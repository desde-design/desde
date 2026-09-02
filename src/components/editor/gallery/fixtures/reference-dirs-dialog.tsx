"use client"

import { ReferenceDirsDialog } from "@/components/editor/editor-settings-menu"
import type { ReferenceDirView } from "@/hooks/useReferenceDirs"
import type { SurfaceEntry, SurfaceRenderContext } from "../types"
import { jsonOverride, useFetchOverride } from "./fetch-override"

/**
 * `ReferenceDirsDialog` (defined alongside `DesignSystemsDialog` /
 * `ProjectConventionsDialog` in `editor-settings-menu.tsx`) wraps
 * `ReferenceDirsPanel`, which reads everything through `useReferenceDirs` —
 * a hook that fetches `/api/editor/read-roots` on mount. There is no prop
 * that hands the panel a list directly.
 *
 * `design-systems-panel.test.tsx` / `editor-settings-menu.test.tsx` mock the
 * hook module for that reason with `vi.mock`, but a gallery fixture is a real
 * running page, not a vitest module registry — `vi.mock` has nothing to
 * intercept there. `DesignSystemsFixture` in `./editor-settings-menu.tsx`
 * solves the identical problem by stubbing the fetch the hook makes rather
 * than the hook itself, through the shared `useFetchOverride` router. This
 * fixture follows the same approach: it does not touch `AddReferenceDirectory`
 * or the panel, it only answers the network call underneath them.
 */

const READ_ROOTS_LIST = (url: string) =>
  url.includes("/api/editor/read-roots") && !url.includes("/api/editor/read-roots/")

interface ReadRootsListBody {
  ok: true
  roots: ReferenceDirView[]
  warnings: string[]
}

/** The always-present implicit root, shaped as `loadReadRoots` synthesizes it. */
const WORKTREE_ROOT: ReferenceDirView = {
  name: "worktree",
  path: "/Users/designer/prototypes/ai-gateway-prototype",
  description: "The editor worktree (the current editing session).",
  isWorktree: true,
  isGit: true,
}

const EMPTY_BODY: ReadRootsListBody = { ok: true, roots: [WORKTREE_ROOT], warnings: [] }

const POPULATED_BODY: ReadRootsListBody = {
  ok: true,
  roots: [
    WORKTREE_ROOT,
    {
      name: "billing-web",
      path: "/Users/designer/code/billing-web",
      description: "Production billing UI, match these table patterns",
      isWorktree: false,
      isGit: true,
    },
    {
      name: "design-system",
      path: "/Users/designer/code/acme-design-system",
      isWorktree: false,
      isGit: true,
    },
  ],
  warnings: [],
}

const NON_GIT_BODY: ReadRootsListBody = {
  ok: true,
  roots: [
    WORKTREE_ROOT,
    {
      name: "brand-assets",
      path: "/Users/designer/Dropbox/acme-brand-assets",
      description: "Logo lockups and marketing copy decks, not a repo",
      isWorktree: false,
      isGit: false,
    },
  ],
  warnings: [],
}

function ReferenceDirsFixture({
  ctx,
  body,
}: {
  ctx: SurfaceRenderContext
  body: ReadRootsListBody
}) {
  useFetchOverride(jsonOverride(READ_ROOTS_LIST, body))
  return <ReferenceDirsDialog open onOpenChange={(next) => ctx.log("onOpenChange", next)} />
}

export const REFERENCE_DIRS_DIALOG_SURFACE: SurfaceEntry = {
  id: "reference-dirs-dialog",
  title: "Reference folders",
  kind: "modal",
  sourceFile: "src/components/editor/editor-settings-menu.tsx",
  states: [
    {
      id: "reference-dirs-dialog/empty",
      label: "No reference folders declared yet",
      render: (ctx) => <ReferenceDirsFixture ctx={ctx} body={EMPTY_BODY} />,
    },
    {
      id: "reference-dirs-dialog/populated",
      label: "Two declared folders, both git repos",
      render: (ctx) => <ReferenceDirsFixture ctx={ctx} body={POPULATED_BODY} />,
    },
    {
      id: "reference-dirs-dialog/non-git-root",
      label: "A declared folder that is not a git repo",
      render: (ctx) => <ReferenceDirsFixture ctx={ctx} body={NON_GIT_BODY} />,
    },
  ],
}
