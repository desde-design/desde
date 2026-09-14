"use client"

/**
 * "Viewer project" — which project on your viewer is this repo?
 *
 * Deliberately NOT the whole viewer (Mo, 2026-09-14: "just have the
 * affordance for the project link, not the whole viewer"). The address and
 * the access token belong to the machine and are set once, at Editor level;
 * this dialog answers the per-repo half. Before this existed, the project menu
 * opened the full connect flow, whose first step asked again for credentials
 * the machine already had — which is why the two menu entries were
 * indistinguishable.
 *
 * ## The credentials step appears only when it is needed
 *
 * With a viewer already set up, the dialog opens straight on the project list,
 * fetched by the CLI with the stored token — which never reaches this page.
 *
 * With no viewer set up, it asks for the address and token HERE and continues
 * to the list, rather than sending the user to another screen and back
 * (Mo, 2026-09-14). A dead end that names a different menu is a worse answer
 * than one extra step, and the step is only ever shown once per machine.
 *
 * ## Nothing is written until Link
 *
 * `Next` probes and lists; it stores nothing. That is the same discipline the
 * connect dialog documents: a mistyped URL or a revoked token must not be able
 * to leave a half-configured machine behind. Link is what writes, and it
 * writes both halves — the credential (as the machine default, since setting
 * one here IS the editor-level setting) and the repo's project link.
 */

import { useCallback, useEffect, useState } from "react"
import { toast } from "sonner"
import { EmptyState, Field, FieldGroup, ListFrame, OptionCard, OptionCardGroup } from "@/components/blocks"
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
import { Input } from "@/components/ui/input"
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

interface ProjectList {
  origin: string
  projects: ViewerProjectOption[]
  match: ViewerProjectMatch | null
}

type Phase =
  | { kind: "loading" }
  /** No viewer on this machine (or its token is gone): ask here, then list. */
  | { kind: "credentials" }
  | { kind: "error"; reason: string }
  | ({ kind: "projects" } & ProjectList)

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
  const [phase, setPhase] = useState<Phase>({ kind: "loading" })
  const [chosen, setChosen] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [baseUrl, setBaseUrl] = useState("")
  const [token, setToken] = useState("")
  /**
   * The credentials typed in THIS session, if any.
   *
   * Set only when the user came through the credentials step, and it is what
   * tells Link to store them. When the machine already had a viewer this stays
   * null and Link writes the project link alone, leaving the stored credential
   * untouched.
   */
  const [pendingCredential, setPendingCredential] = useState<
    { baseUrl: string; token: string } | null
  >(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setPhase({ kind: "loading" })
    setError(null)
    setPendingCredential(null)
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
        // 409 is "no viewer, or no token for it" — a prerequisite the user has
        // not met, not a failure. Ask for it here.
        if (res.status === 409) {
          setBaseUrl(json.origin ?? "")
          setPhase({ kind: "credentials" })
          return
        }
        if (!res.ok || json.ok === false) {
          setPhase({ kind: "error", reason: json.reason ?? "Could not reach your viewer." })
          return
        }
        setPhase({
          kind: "projects",
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
        if (!cancelled) setPhase({ kind: "error", reason: "Could not reach the editor." })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open, currentProjectId])

  /** Validate the typed credentials and list what they can reach. Writes nothing. */
  const probe = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await editorFetch("/api/editor/viewer-auth/probe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseUrl: baseUrl.trim(), token: token.trim() }),
      })
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean
        reason?: string
        origin?: string
        projects?: ViewerProjectOption[]
        match?: ViewerProjectMatch
      }
      if (!res.ok || json.ok === false) {
        setError(json.reason ?? "Could not reach that viewer.")
        return
      }
      setPendingCredential({ baseUrl: json.origin ?? baseUrl.trim(), token: token.trim() })
      setPhase({
        kind: "projects",
        origin: json.origin ?? baseUrl.trim(),
        projects: json.projects ?? [],
        match: json.match ?? null,
      })
      setChosen(currentProjectId ?? json.match?.projectId ?? undefined)
    } catch {
      setError("Could not reach the editor.")
    } finally {
      setBusy(false)
    }
  }, [baseUrl, token, currentProjectId])

  const link = useCallback(async () => {
    if (phase.kind !== "projects") return
    const picked = phase.projects.find((p) => p.id === chosen)
    if (!picked) return
    setBusy(true)
    setError(null)
    try {
      // Credential first, when there is one to store. If the config write
      // succeeded and this failed, the repo would look linked while every
      // comment fetch 401s — the half-state the connect flow orders around.
      if (pendingCredential) {
        const stored = await editorFetch("/api/editor/viewer-auth", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...pendingCredential, makeDefault: true }),
        })
        const storedJson = (await stored.json().catch(() => ({}))) as {
          ok?: boolean
          reason?: string
        }
        if (!stored.ok || storedJson.ok === false) {
          setError(storedJson.reason ?? "Could not save the viewer.")
          return
        }
      }
      const result = await linkProjectOnDisk({
        projectId: picked.id,
        slug: picked.slug,
        platformBaseUrl: phase.origin,
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
  }, [phase, chosen, pendingCredential, onLinked, onOpenChange])

  const onCredentials = phase.kind === "credentials"

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle>Viewer project</DialogTitle>
          <DialogCopy
            description={
              onCredentials
                ? "No viewer is set up yet. Add its address and an access token, then choose a project for this repo."
                : "Which project on your viewer is this repo? Comments here sync to the project you choose."
            }
            {...(error ? { issues: [{ key: "viewer", node: error }] } : {})}
          />
        </DialogHeader>

        {phase.kind === "loading" ? (
          <p className="text-sm text-muted-foreground">Loading projects…</p>
        ) : null}

        {onCredentials ? (
          <FieldGroup>
            <Field label="Viewer address" htmlFor="viewer-project-url">
              <Input
                id="viewer-project-url"
                value={baseUrl}
                onChange={(e) => {
                  setBaseUrl(e.target.value)
                  setError(null)
                }}
                placeholder="https://viewer.example.com"
                autoComplete="off"
              />
            </Field>
            <Field
              label="Access token"
              htmlFor="viewer-project-token"
              hint="In the viewer: Settings, then Create token. Tick the write scope, or comments cannot be posted."
            >
              <Input
                id="viewer-project-token"
                value={token}
                onChange={(e) => {
                  setToken(e.target.value)
                  setError(null)
                }}
                placeholder="dsv_…"
                autoComplete="off"
              />
            </Field>
          </FieldGroup>
        ) : null}

        {phase.kind === "error" ? (
          <EmptyState title="Could not list projects" description={phase.reason} />
        ) : null}

        {phase.kind === "projects" && phase.projects.length === 0 ? (
          <EmptyState
            title="That viewer has no projects"
            description="Create one in the viewer first, then choose it here."
          />
        ) : null}

        {phase.kind === "projects" && phase.projects.length > 0 ? (
          <ListFrame>
            <OptionCardGroup
              value={chosen}
              onValueChange={setChosen}
              aria-label="Choose a project"
              className="max-h-64 overflow-y-auto"
            >
              {phase.projects.map((project) => (
                <OptionCard
                  key={project.id}
                  value={project.id}
                  title={
                    phase.match?.projectId === project.id ? (
                      <span className="flex items-center gap-2">
                        {project.name}
                        {/* Says WHY this row was offered first, and survives
                            the user picking a different one. */}
                        <Badge variant="secondary">
                          {phase.match.by === "identity" ? "This repo" : "Same repository"}
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
          {onCredentials ? (
            <Button
              size="sm"
              onClick={() => void probe()}
              disabled={busy || baseUrl.trim() === "" || token.trim() === ""}
              busy={busy}
            >
              {busy ? "Checking" : "Next"}
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={() => void link()}
              disabled={busy || phase.kind !== "projects" || chosen === undefined}
              busy={busy}
            >
              Link
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
