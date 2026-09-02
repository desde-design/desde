"use client"

/**
 * Editor navigation breadcrumb — replaces the standalone project +
 * branch dropdowns in the workspace header with a single path:
 *
 *   🏠  ›  Project name ▾  ›  branch ▾
 *
 *  - Home  — navigates to the launcher's project picker ("list of
 *    projects"); the CLI lazily starts one (see goToEditorHome).
 *  - Project — the existing `ProjectMenu` (open in viewer / settings /
 *    change project), rendered as a breadcrumb segment.
 *  - Branch — the existing `BranchMenu` (switch / new / rename /
 *    publish), rendered as a breadcrumb segment. Branch mode is the only
 *    editor edit substrate, so this segment always renders.
 */

import { toast } from "sonner"
import { Home } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import { ProjectMenu } from "@/components/editor/project-menu"
import { BranchMenu } from "@/components/editor/branch-menu"
import { goToEditorHome } from "@/lib/editor-home"
import type { BranchesApi } from "@/hooks/useEditorBranches"

export function EditorBreadcrumb({
  branches,
  className,
}: {
  branches: BranchesApi
  className?: string
}) {
  const onHome = () => {
    void goToEditorHome().catch((err: unknown) =>
      toast.error(
        err instanceof Error ? err.message : "Couldn't open the projects home.",
      ),
    )
  }

  return (
    <Breadcrumb className={cn(className)}>
      {/* `text-inherit` because the primitive's list hard-codes
          `text-muted-foreground`, which is a step lighter again than the tone
          the nav bar sets. Inheriting keeps the whole row on one value. */}
      <BreadcrumbList className="gap-0 sm:gap-0 text-inherit">
        <BreadcrumbItem>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Projects home"
            title="Projects home"
            onClick={onHome}
            data-testid="breadcrumb-home"
          >
            <Home />
          </Button>
        </BreadcrumbItem>
        {/* The primitive's stock chevron (Mo, 2026-08-19). This used to pass
            a slash instead, arguing that a chevron reads as "go forward"
            while a slash just separates. Overruled: the chevron is what every
            breadcrumb in the product now uses, including the Viewer's, and
            one shape across both surfaces is worth more than that
            distinction. */}
        <BreadcrumbSeparator />
        <BreadcrumbItem>
          <ProjectMenu asBreadcrumb />
        </BreadcrumbItem>
        {/* The primitive's stock chevron (Mo, 2026-08-19). This used to pass
            a slash instead, arguing that a chevron reads as "go forward"
            while a slash just separates. Overruled: the chevron is what every
            breadcrumb in the product now uses, including the Viewer's, and
            one shape across both surfaces is worth more than that
            distinction. */}
        <BreadcrumbSeparator />
        <BreadcrumbItem>
          <BranchMenu branches={branches} asBreadcrumb />
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  )
}
