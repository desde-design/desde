"use client"

/**
 * Point this repo at a Desde viewer.
 *
 * Two steps. Credentials first: the URL may be wrong, the token may be
 * revoked, or the viewer may have no projects, and probing turns those into
 * three distinct, actionable messages instead of one opaque failure. Only when
 * that succeeds does the dialog become a project chooser.
 *
 * The steps replace each other rather than stacking. With the fields still on
 * screen under the results a user could edit them and pick a project without
 * re-probing, storing the newly typed token against the previously probed
 * origin: exactly the stale-result hazard `invalidateProbe` exists to prevent.
 *
 * On confirm this writes `platformBaseUrl` + `projectId` into
 * `.desde/config.json` (committed — it is the repo's identity) and
 * stores the access token per-machine in the CLI (never committed, never
 * returned to this page).
 */

import { useCallback, useState } from "react"
import { toast } from "sonner"
import { Loader2 } from "lucide-react"
import {
  EmptyState,
  Field,
  ListFrame,
  ListFrameSearch,
  OptionCard,
  OptionCardGroup,
} from "@/components/blocks"
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

export interface ViewerProjectOption {
  id: string
  slug: string
  name: string
}

export interface ConnectViewerDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Prefill when re-connecting an already-configured repo. */
  initialBaseUrl?: string | null
  onConnected?: () => void
  className?: string
}

export function ConnectViewerDialog({
  open,
  onOpenChange,
  initialBaseUrl,
  onConnected,
  className,
}: ConnectViewerDialogProps) {
  const [baseUrl, setBaseUrl] = useState(initialBaseUrl ?? "")
  const [token, setToken] = useState("")
  const [projects, setProjects] = useState<ViewerProjectOption[] | null>(null)
  const [origin, setOrigin] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // Second-step state. `selectedProjectId` is set in the probe handler rather
  // than a `useState` initializer, which cannot see a result that does not
  // exist yet.
  const [selectedProjectId, setSelectedProjectId] = useState<string | undefined>(
    undefined,
  )
  const [projectFilter, setProjectFilter] = useState("")

  /**
   * Discard a probe result the moment its inputs stop being true.
   *
   * Clearing only when a probe STARTS is not enough: after a successful probe
   * the user can edit the URL or token and click a listed project WITHOUT
   * re-probing, which stores the newly typed token against the previously
   * probed origin and links the repo to a project on the old viewer. The rows
   * must never outlive the inputs that produced them, so every edit
   * invalidates them and the credentials step comes back with its "Connect"
   * button, so nothing can be linked without re-probing.
   */
  const invalidateProbe = useCallback(() => {
    setProjects(null)
    setOrigin(null)
    setError(null)
    setSelectedProjectId(undefined)
    setProjectFilter("")
  }, [])

  const probe = useCallback(async () => {
    setBusy(true)
    setError(null)
    // Drop any previous result BEFORE re-probing.
    //
    // These outlived the inputs that produced them: probe successfully, then
    // edit the URL or token and probe again into a failure, and the old
    // project list stayed on screen and clickable under the new inputs.
    // Clicking one would store the CURRENT token against the OLD origin and
    // link to a project from the previous viewer — a credential and a link
    // both landing somewhere the user did not choose. Stale results are worse
    // than none, because they look like an answer to the question just asked.
    //
    // `null`, not `[]`. `[]` reads as "probed, and that viewer has no
    // projects", which rendered the "No projects on that viewer. Create one in
    // the viewer first" empty state for the whole round trip, and then left it
    // on screen underneath the error when the probe failed. Both are false: the
    // probe had not answered yet, or it never got an answer at all. `null` is
    // already the "no result" state that gates the empty state and the button
    // label, and it clears stale rows just as well.
    setProjects(null)
    setOrigin(null)
    try {
      const res = await editorFetch("/api/editor/viewer-auth/probe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseUrl, token }),
      })
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean
        reason?: string
        origin?: string
        projects?: ViewerProjectOption[]
      }
      if (!json.ok) {
        setError(json.reason ?? `Could not reach the viewer (HTTP ${res.status}).`)
        return
      }
      setOrigin(json.origin ?? baseUrl)
      setProjects(json.projects ?? [])
      setSelectedProjectId(json.projects?.[0]?.id)
      setProjectFilter("")
    } catch {
      setError("Could not reach the CLI. Is the editor still running?")
    } finally {
      setBusy(false)
    }
  }, [baseUrl, token])

  const connect = useCallback(
    async (project: ViewerProjectOption) => {
      setBusy(true)
      setError(null)
      try {
        // Token first: if writing the config succeeded but storing the token
        // failed, the repo would look connected and every comment fetch would
        // 401 — the confusing half-state this ordering avoids.
        const stored = await editorFetch("/api/editor/viewer-auth", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token, baseUrl: origin ?? baseUrl }),
        })
        const storedJson = (await stored.json().catch(() => ({}))) as { ok?: boolean; reason?: string }
        if (!storedJson.ok) {
          setError(storedJson.reason ?? "Could not store the access token.")
          return
        }

        const linked = await linkProjectOnDisk({
          projectId: project.id,
          slug: project.slug,
          platformBaseUrl: origin ?? baseUrl,
        })
        if (!linked.ok) {
          setError(linked.reason ?? "Could not write .desde/config.json.")
          return
        }

        toast.success(`Connected to ${project.name}`)
        onConnected?.()
        onOpenChange(false)
      } catch {
        setError("Could not reach the CLI. Is the editor still running?")
      } finally {
        setBusy(false)
      }
    },
    [token, origin, baseUrl, onConnected, onOpenChange],
  )

  // Two steps, because they ask for different things and the first has to
  // succeed before the second is even meaningful. Showing the credential
  // fields under the results also let a user edit them and pick a project
  // without re-probing, which is the stale-result hazard `invalidateProbe`
  // exists to prevent.
  const step: "credentials" | "project" = projects === null ? "credentials" : "project"

  const query = projectFilter.trim().toLowerCase()
  const visibleProjects = (projects ?? []).filter(
    (project) =>
      !query ||
      project.name.toLowerCase().includes(query) ||
      project.slug.toLowerCase().includes(query),
  )
  const selectedProject = (projects ?? []).find((p) => p.id === selectedProjectId)

  const issues = error
    ? [
        {
          key: "error",
          node: (
            <span
              role="status"
              className="text-destructive"
              data-testid="connect-viewer-error"
            >
              {error}
            </span>
          ),
        },
      ]
    : []

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="xl" className={className}>
        <DialogHeader>
          <DialogTitle>
            {step === "credentials" ? "Connect to a viewer" : "Select a project"}
          </DialogTitle>
          {/*
            The error joins the header rather than getting its own banner
            between the fields and the list, which put a red block in the
            middle of the form. It keeps the destructive colour, so the signal
            survives the container going away.
          */}
          <DialogCopy
            description={
              step === "credentials"
                ? "Comments made here sync with the viewer for the selected project."
                : `Comments made here will sync with the project you pick. Connected to ${origin ?? baseUrl}.`
            }
            issues={issues}
          />
        </DialogHeader>

        {step === "credentials" ? (
          <div className="flex flex-col gap-3">
            <Field label="Viewer URL" htmlFor="viewer-url">
              <Input
                id="viewer-url"
                value={baseUrl}
                onChange={(e) => {
                  setBaseUrl(e.target.value)
                  invalidateProbe()
                }}
                placeholder="https://viewer.example.com"
                autoComplete="off"
              />
            </Field>

            {/*
              The how-to lives on the field, not in the description. It is
              instructions for filling in THIS input, so it belongs beside it,
              and moving it out of the description keeps the header to a title
              plus one short line rather than a paragraph to read before the
              first control.

              The write-scope sentence earns its place because the viewer's own
              token form (`viewer/app/settings/tokens-panel.tsx`) ticks `read`
              by default and leaves `write` unticked, so the path of least
              resistance produces a token that cannot post a comment.

              This is PREVENTION, not the only guard: `viewer-probe.ts` already
              calls `/api/v1/me` and refuses a read-only token at connect time
              with a message naming the fix. Saying it here saves the round
              trip through that refusal. It is also the only thing standing up
              against a viewer old enough that `/me` does not report scopes,
              which the probe deliberately accepts rather than blocking a
              connection outright.
            */}
            <Field
              label="Access token"
              htmlFor="viewer-token"
              hint={
                <>
                  In the viewer: Settings, then Create token. Tick the{" "}
                  <strong className="font-medium">write</strong> scope, it is
                  off by default and comment sync needs it. The token is shown
                  once, and stored on this machine only.
                </>
              }
            >
              <Input
                id="viewer-token"
                // `password` so it isn't shoulder-surfed or captured in a
                // screen share: this is a bearer secret, not an identifier.
                type="password"
                value={token}
                onChange={(e) => {
                  setToken(e.target.value)
                  invalidateProbe()
                }}
                placeholder="dsv_…"
                autoComplete="off"
              />
            </Field>
          </div>
        ) : projects && projects.length === 0 ? (
          <EmptyState
            size="sm"
            title="No projects on that viewer"
            description="Create one in the viewer first, then come back."
          />
        ) : (
          /* The filter is the list's first row, inside the frame — the same
             shape as the repo picker and the Comments panel search. The frame
             stays put across the two states below, so the field keeps focus
             while a query narrows to nothing. */
          <ListFrame>
            <ListFrameSearch
              value={projectFilter}
              onValueChange={setProjectFilter}
              placeholder="Filter projects"
              aria-label="Filter projects"
              data-testid="connect-viewer-filter"
            />
            {visibleProjects.length === 0 ? (
              <p className="px-3 py-2 text-sm text-muted-foreground">
                No projects match that filter.
              </p>
            ) : (
              <OptionCardGroup
                value={selectedProjectId}
                onValueChange={setSelectedProjectId}
                aria-label="Choose a project"
                // Scrolls inside the frame; the filter row above stays fixed.
                className="max-h-64 overflow-y-auto"
              >
                {visibleProjects.map((project) => (
                  <OptionCard
                    key={project.id}
                    value={project.id}
                    title={project.name}
                    hint={<span className="font-mono">{project.slug}</span>}
                    disabled={busy}
                    data-testid={`connect-viewer-project-${project.slug}`}
                  />
                ))}
              </OptionCardGroup>
            )}
          </ListFrame>
        )}

        <DialogFooter>
          {step === "credentials" ? (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => onOpenChange(false)}
                disabled={busy}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={() => void probe()}
                disabled={busy || !baseUrl || !token}
              >
                {busy ? <Loader2 className="animate-spin" /> : null}
                Connect
              </Button>
            </>
          ) : (
            <>
              {/* Back parks left as wizard navigation; Cancel stays beside
                  the primary so this step keeps a visible way OUT, not only
                  a way backwards (Mo, 2026-08-29: every modal footer carries
                  a Close or Cancel). */}
              <Button
                variant="ghost"
                size="sm"
                className="sm:mr-auto"
                onClick={invalidateProbe}
                disabled={busy}
              >
                Back
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => onOpenChange(false)}
                disabled={busy}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={() => selectedProject && void connect(selectedProject)}
                disabled={busy || !selectedProject}
                data-testid="connect-viewer-link"
              >
                {busy ? <Loader2 className="animate-spin" /> : null}
                Link project
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
