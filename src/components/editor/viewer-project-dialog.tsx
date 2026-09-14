"use client"

/**
 * "Viewer project" — which project on your viewer is this repo?
 *
 * Deliberately NOT the whole viewer (Mo, 2026-09-14: "just have the
 * affordance for the project link, not the whole viewer"). The URL and the
 * access token belong to the machine and are set once, at Editor level; this
 * dialog only answers the per-repo half. Before this existed, the project
 * menu opened the full connect flow, whose first step asked again for a URL
 * and token the machine already had — which is why the two menu entries were
 * indistinguishable.
 *
 * So there is no credentials step here at all. The list comes from
 * `GET /api/editor/viewer-auth/projects`, which the CLI answers using the
 * stored credential; the token never reaches this page.
 *
 * With no viewer set up yet there is nothing to choose, so it says so and
 * names where to go. Inventing a URL field here would rebuild the duplication
 * this dialog exists to remove.
 */

import { useCallback, useEffect, useState } from "react"
import { toast } from "sonner"
import { EmptyState, ListFrame, OptionCard, OptionCardGroup } from "@/components/blocks"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogCopy,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { editorFetch } from "@/lib/editor-fetch"
import { linkProjectOnDisk } from "@/services/editor-project-link"

interface ViewerProjectOption {
  id: string
  slug: string
  name: string
}

/** Mirrors the probe's `match`: which row the CLI resolved this checkout to. */
interface ViewerProjectMatch {
  projectId: string
  by: "identity" | "repo"
}

type Load =
  | { state: "loading" }
  /** No viewer configured on this machine, or its token is gone. */
  | { state: "no-viewer" }
  | { state: "error"; reason: string }
  | {
      state: "ready"
      origin: string
      projects: ViewerProjectOption[]
      match: ViewerProjectMatch | null
    }

export interface ViewerProjectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The project id this repo is linked to now, if any — used to preselect. */
  currentProjectId?: string | null
  onLinked?: () => void
}

export function ViewerProjectDialog({
  open,
  onOpenChange,
  currentProjectId,
  onLinked,
}: ViewerProjectDialogProps) {
  const [load, setLoad] = useState<Load>({ state: "loading" })
  const [chosen, setChosen] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoad({ state: "loading" })
    setError(null)
    void (async () => {
      try {
        const res = await editorFetch("/api/editor/viewer-auth/projects")
        const json = (await res.json().catch(() => ({}))) as {
          ok?: boolean
          reason?: string
          origin?: string
          projects?: ViewerProjectOption[]
          match?: ViewerProjectMatch
        }
        if (cancelled) return
        // 409 is "no viewer set up yet", which is a prerequisite rather than a
        // failure — see the module comment.
        if (res.status === 409) {
          setLoad({ state: "no-viewer" })
          return
        }
        if (!res.ok || json.ok === false) {
          setLoad({ state: "error", reason: json.reason ?? "Could not reach your viewer." })
          return
        }
        setLoad({
          state: "ready",
          origin: json.origin ?? "",
          projects: json.projects ?? [],
          match: json.match ?? null,
        })
        // Preselect what this repo already is, then what the CLI matched it
        // to. Never `projects[0]`: the first row the viewer happened to return
        // is unrelated to the repo in front of you, and a wrong preselection
        // looks like the work was done for you.
        setChosen(currentProjectId ?? json.match?.projectId ?? undefined)
      } catch {
        if (!cancelled) setLoad({ state: "error", reason: "Could not reach the editor." })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open, currentProjectId])

  const link = useCallback(async () => {
    if (load.state !== "ready") return
    const picked = load.projects.find((p) => p.id === chosen)
    if (!picked) return
    setBusy(true)
    setError(null)
    try {
      const result = await linkProjectOnDisk({
        projectId: picked.id,
        slug: picked.slug,
        platformBaseUrl: load.origin,
      })
      if (!result.ok) {
        setError(result.reason ?? "Could not link that project.")
        return
      }
      toast.success(`Linked to ${picked.name}`)
      onLinked?.()
      onOpenChange(false)
    } finally {
      setBusy(false)
    }
  }, [load, chosen, onLinked, onOpenChange])

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle>Viewer project</DialogTitle>
          <DialogCopy
            description="Which project on your viewer is this repo? Comments here sync to the project you choose."
            {...(error ? { issues: [{ key: "link", node: error }] } : {})}
          />
        </DialogHeader>

        {load.state === "loading" ? (
          <p className="text-sm text-muted-foreground">Loading projects…</p>
        ) : null}

        {load.state === "no-viewer" ? (
          <EmptyState
            title="No viewer set up yet"
            description="Add your viewer's address and access token in Editor settings, on the projects screen. Then come back here to choose a project."
          />
        ) : null}

        {load.state === "error" ? (
          <EmptyState title="Could not list projects" description={load.reason} />
        ) : null}

        {load.state === "ready" && load.projects.length === 0 ? (
          <EmptyState
            title="That viewer has no projects"
            description="Create one in the viewer first, then choose it here."
          />
        ) : null}

        {load.state === "ready" && load.projects.length > 0 ? (
          <ListFrame>
            <OptionCardGroup
              value={chosen}
              onValueChange={setChosen}
              aria-label="Choose a project"
              className="max-h-64 overflow-y-auto"
            >
              {load.projects.map((project) => (
                <OptionCard
                  key={project.id}
                  value={project.id}
                  title={
                    load.match?.projectId === project.id ? (
                      <span className="flex items-center gap-2">
                        {project.name}
                        {/* Says WHY this row was offered first, which survives
                            the user picking a different one. */}
                        <Badge variant="secondary">
                          {load.match.by === "identity" ? "This repo" : "Same repository"}
                        </Badge>
                      </span>
                    ) : (
                      project.name
                    )
                  }
                  hint={project.slug}
                  data-testid={`viewer-project-${project.slug}`}
                />
              ))}
            </OptionCardGroup>
          </ListFrame>
        ) : null}

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => void link()}
            disabled={busy || load.state !== "ready" || chosen === undefined}
            busy={busy}
          >
            Link
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
