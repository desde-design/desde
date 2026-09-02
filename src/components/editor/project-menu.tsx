"use client"

/**
 * Header project chip for the editor. Shows the repo's project identity
 * (embedded in `.desde/config.json` — no sign-in, network, or cloud
 * link needed) and a menu to open the linked viewer, copy its link, or
 * connect/change the viewer link.
 *
 * The label comes from `EDITOR_PROJECT.identity.name`, falling back to the
 * raw slug, then to the repo folder's own name, and only then to the literal
 * "Project". `activeProjectId`
 * (from the local editor store) only gates whether "Open in viewer" / "Copy
 * project link" are enabled — it does not change the label. There is no
 * settings item and no Firestore resolution; `ConnectViewerDialog` writes a
 * new `.desde/config.json` on connect and reloads the page, since
 * `EDITOR_PROJECT` is injected once at CLI boot and `setActiveProjectId` has
 * no callers to react to in place.
 */

import { useCallback, useState } from "react"
import { toast } from "sonner"
import { ChevronDown, ExternalLink, FolderGit2, Link2 } from "lucide-react"
import { useEditorStore } from "@/stores/editor-only"
import { EDITOR_PROJECT, EDITOR_REPO_ROOT } from "@/lib/editor-feature-flags"
import { ConnectViewerDialog } from "@/components/editor/connect-viewer-dialog"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

/**
 * Viewer URL for the linked project, or null when it cannot be built.
 *
 * The route is `/review/<slug>`. It used to be `/project/<projectId>`, which
 * no longer exists anywhere in `viewer/app` — the self-hosted viewer registers
 * `review/[slug]` and `settings`, nothing else. Every "Open in viewer" and
 * "Copy project link" therefore produced a dead URL.
 *
 * Returns null when the slug is unknown rather than guessing. `slug` is
 * populated by project resolve/link; a repo whose `.desde/config.json`
 * carries only a `projectId` has none, and `/review/null` would be a 404
 * that looks like the project is missing. A disabled menu item is the honest
 * answer — the id cannot be substituted, because the route keys on slug.
 */
function viewerProjectUrl(): string | null {
  const base = EDITOR_PROJECT?.platformBaseUrl
  const slug = EDITOR_PROJECT?.slug
  if (!base || !slug) return null
  return `${base.replace(/\/$/, "")}/review/${encodeURIComponent(slug)}`
}

export function ProjectMenu({
  className,
  asBreadcrumb = false,
}: {
  className?: string
  /** Render the trigger as a breadcrumb segment (ghost text, no box). */
  asBreadcrumb?: boolean
}) {
  const activeProjectId = useEditorStore((s) => s.activeProjectId)
  const [connectOpen, setConnectOpen] = useState(false)


  const openInViewer = useCallback(() => {
    if (!activeProjectId) return
    const url = viewerProjectUrl()
    if (!url) {
      // Distinguish the two reasons, because the remedies differ: one is a
      // config edit, the other is linking the repo to a viewer project.
      toast.info(
        EDITOR_PROJECT?.platformBaseUrl
          ? "This repo has no viewer project slug yet: link it to a viewer project first."
          : "Set platformBaseUrl in .desde/config.json to open the viewer.",
      )
      return
    }
    window.open(url, "_blank", "noopener")
  }, [activeProjectId])

  const copyLink = useCallback(() => {
    if (!activeProjectId) return
    // Falls back to the bare project id when no viewer URL can be built —
    // still useful to paste into a chat, and never a URL that 404s.
    const url = viewerProjectUrl() ?? activeProjectId
    void navigator.clipboard
      .writeText(url)
      .then(() => toast.success("Project link copied"))
      .catch(() => toast.error("Couldn't copy to clipboard"))
  }, [activeProjectId])

  // Identity is embedded in the REPO — it survives being signed out, offline,
  // and having no viewer configured. There is no longer a cloud project doc
  // to prefer over it: the registry this used to read from is gone, which is
  // also what fixes the long-standing bug where the chip showed "Link
  // project" while the slug was already in hand.
  const embedded = EDITOR_PROJECT?.identity ?? null
  /*
   * The folder-name rung was missing, and its absence is what Mo saw
   * (2026-08-18: "why does the breadcrumb not show the project name — I see
   * a name in the project card").
   *
   * The launcher card reads `slug ?? basename(path)` off the projects
   * registry, so it always has SOMETHING to show. This chip read
   * `identity.name ?? slug` off the CLI bootstrap and fell straight to the
   * literal "Project" — so a repo with no name written into
   * `.desde/config.json` showed a real name on one screen and a generic
   * word on the next, for the same project.
   *
   * `repoRoot` is already in the bootstrap (stylesheet resolution), so the
   * fix is one more rung rather than new plumbing. The trailing-slash strip
   * matters: a root stored with one would otherwise yield an empty segment.
   */
  const folderName = EDITOR_REPO_ROOT?.replace(/\/+$/, "").split("/").pop()
  const label = embedded?.name ?? EDITOR_PROJECT?.slug ?? folderName ?? "Project"
  const linked = Boolean(activeProjectId)

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              asBreadcrumb && "gap-1 px-1.5 font-normal",
              className,
            )}
          >
            {/*
              No icon (Mo, 2026-08-18). A folder glyph beside a project name
              in a breadcrumb labels the row's KIND, which the breadcrumb
              position already says, and it competed with the home icon two
              places to its left. The same glyph stays on the menu ITEM
              below, where it labels an action rather than a location.
            */}
            <span className="max-w-40 truncate">{label}</span>
            <ChevronDown className="opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          {/* Viewer-dependent actions stay visible but disabled when the
              project isn't linked, so the affordance is discoverable rather
              than appearing out of nowhere after linking. */}
          <DropdownMenuItem onClick={openInViewer} disabled={!linked}>
            <ExternalLink />
            Open in viewer
          </DropdownMenuItem>
          <DropdownMenuItem onClick={copyLink} disabled={!linked}>
            <Link2 />
            Copy project link
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setConnectOpen(true)}>
            <FolderGit2 />
            {linked ? "Change viewer…" : "Connect to viewer…"}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ConnectViewerDialog
        open={connectOpen}
        onOpenChange={setConnectOpen}
        initialBaseUrl={EDITOR_PROJECT?.platformBaseUrl ?? null}
        // The CLI wrote a new config and stored a token; a reload is the
        // simplest way to pick both up, since EDITOR_PROJECT is injected at
        // boot and the comment store keys off it.
        onConnected={() => window.location.reload()}
      />

    </>
  )
}
