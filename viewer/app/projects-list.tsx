"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { MoreVertical, Plus, Search, Settings, Trash2 } from "lucide-react"
import { EmptyState, HOVER_REVEAL, ProjectLoader, rowTint, useProjectGrid } from "@/components/blocks"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { LoadFailure } from "./load-failure"
import { formatRelativeTimeShort } from "@/lib/relative-time"
import { AddPrototypeSource } from "./add-prototype-source"
import { CreateProjectDialog } from "./create-project-dialog"
import { GITHUB_APP_SETUP_INTRO, GithubAccessSetupStep } from "./github-app-setup-card"
import { clearUrlParams } from "./github-access-flow"
import { ProjectRepoPanel } from "./project-repo-panel"
import { failureMessage, fetchJson } from "./api-client"
import { prototypeAnonymouslyReadable, prototypeHref } from "./prototype-origin"
import { useCurrentUser } from "./use-current-user"
import { canManageProjects } from "./instance-role"
import type { ProjectAccessValue } from "./project-access-copy"

export interface ProjectsListProps {
  /**
   * `VIEWER_SERVE_DOMAIN` (or `null` in path mode) and `VIEWER_PUBLIC_URL`,
   * supplied by the Server Component in `page.tsx`. When a serve domain is
   * configured, "Open" below points at the prototype's OWN origin instead
   * of `/p/{slug}/` — that link is a TOP-LEVEL navigation, so an iframe
   * sandbox cannot contain it and the origin is the only real boundary
   * (security audit findings B2 + S8). See `prototype-origin.ts`.
   */
  serveDomain: string | null
  publicUrl: string
}

/** The public half of the active deployment — see `ProjectView` on the server. */
interface ActiveDeployment {
  status: "building" | "deployed" | "failed"
  /** When the build STARTED. No completion time is stored. */
  createdAt: string
}

interface ProjectSummary {
  id: string
  slug: string
  name: string
  activeDeploymentId: string | null
  access: ProjectAccessValue
  createdAt: string
  /**
   * Absent on an older server that predates the field; `null` when there is
   * genuinely no active deployment. Both render as "never deployed", so the
   * distinction does not reach the screen — but keep them distinct in the
   * type, because "the server didn't say" and "there isn't one" are not the
   * same claim and a future card may want to tell them apart.
   */
  activeDeployment?: ActiveDeployment | null
}

export function ProjectsList({ serveDomain, publicUrl }: ProjectsListProps) {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null)
  // The instance-wide public-link kill switch, from the SAME `GET
  // /api/v1/projects` response the project list comes from. Defaults to
  // `false` (not `true`) until it loads — see `prototypeAnonymouslyReadable`'s
  // doc comment for why that direction is the safe one; it only matters
  // before the first response lands, since no card renders (and no href gets
  // computed from it) until `projects` itself is non-null.
  const [publicLinksEnabled, setPublicLinksEnabled] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  const [createOpen, setCreateOpen] = useState(false)
  // Who may delete a project — the caller's INSTANCE role, mirroring the
  // server's `hasProjectManageAuthority` (`server/auth/authorize.ts`), which
  // is what `DELETE /api/v1/projects/:id` actually gates on. A `viewer`
  // never sees the delete affordance; the server enforces this
  // independently, so this is a UX courtesy, not the real gate.
  //
  // `canManageProjects` is the shared predicate (`./instance-role.ts`), not a
  // local `role === "admin" || role === "editor"` — three files were each
  // carrying their own copy of that expression.
  const { user: currentUser } = useCurrentUser()
  const canManage = canManageProjects(currentUser?.role)
  /**
   * The project the create flow just made, held open on the repo-connect
   * wizard. Null when that wizard is closed.
   */
  const [connecting, setConnecting] = useState<{ id: string; name: string; access: ProjectAccessValue } | null>(
    null,
  )
  /**
   * `?connect=<id>` reopens this wizard, so the combined GitHub-access flow
   * can come back to it (2026-08-29). That flow leaves for github.com, and a
   * dialog held only in local state would be shut on arrival: the reader would
   * land on the dashboard with no sign their one click had finished.
   *
   * It resolves against the loaded list rather than opening straight away,
   * because the wizard's header needs the project's name and access, and an
   * id in a URL is not proof it exists or that this reader may see it. An
   * unknown id opens nothing, which is the same outcome as a stale link.
   */
  const [connectParamId, setConnectParamId] = useState<string | null>(() =>
    typeof window === "undefined"
      ? null
      : new URLSearchParams(window.location.search).get("connect"),
  )
  if (connectParamId !== null && projects !== null) {
    // Adjust during render rather than in an effect: an effect would paint the
    // dashboard first and pop the dialog a frame later, which reads as a stray
    // modal rather than as the flow resuming.
    const match = projects.find((p) => p.id === connectParamId)
    setConnectParamId(null)
    if (match) {
      setConnecting({ id: match.id, name: match.name, access: match.access })
    }
  }

  /**
   * Closing drops `?connect=`, so a reload does not reopen a wizard the
   * reader just dismissed (codex, 2026-08-29). The parameter's only job is to
   * REOPEN, so it has to die with the dialog.
   */
  /**
   * The Add flow's App-setup step — its own dialog view, entered from the
   * GitHub tab's "Set up GitHub access" button and left through its Back
   * (Mo, 2026-08-29: another step in the flow, not content inside the
   * tabbed screen). Reset on close so a reopened dialog starts at the tabs.
   */
  const [addingGithubAccess, setAddingGithubAccess] = useState(false)

  const closeConnecting = useCallback(() => {
    setConnecting(null)
    setAddingGithubAccess(false)
    clearUrlParams("connect")
  }, [])

  // Grid maths + the teal row ramp are shared with the Editor launcher — see
  // `src/components/blocks/project-grid.tsx` for why they live there.
  const { columns, style: gridStyle } = useProjectGrid()

  /**
   * Bumped to re-run the load below. A counter rather than calling a shared
   * `load()` from two places: the effect already owns the cancellation flag
   * that stops a late response from overwriting fresher state, and a second
   * entry point would need its own copy of that.
   */
  const [reloadToken, setReloadToken] = useState(0)

  useEffect(() => {
    let cancelled = false
    fetchJson<{ projects: ProjectSummary[]; publicLinksEnabled?: boolean }>("/api/v1/projects")
      .then((data) => {
        if (cancelled) return
        setProjects(data.projects)
        setPublicLinksEnabled(data.publicLinksEnabled === true)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(failureMessage(err))
      })
    return () => {
      cancelled = true
    }
  }, [reloadToken])

  /**
   * A new project exists. Put it in the list straight away, then hand it to
   * the repo-connect wizard — a project with no repository cannot be built,
   * so stopping at "created" would leave the user on a dead card with no hint
   * about what comes next.
   */
  function handleCreated(project: { id: string; slug: string; name: string }) {
    setCreateOpen(false)
    setReloadToken((n) => n + 1)
    // A freshly created project always starts at the server's default
    // access ("all-members" — see `POST /projects`), so this is accurate
    // without waiting on a round trip.
    setConnecting({ id: project.id, name: project.name, access: "all-members" })
  }

  /** A project is gone — drop it from the list in place, no round trip. */
  function handleDeleted(projectId: string) {
    setProjects((prev) => (prev ? prev.filter((p) => p.id !== projectId) : prev))
  }

  // Memoised, not a bare `?? []`: the fallback allocates a new array on every
  // render, which would make it a fresh dependency each time and stop the
  // filter memo below from ever memoising.
  const allProjects = useMemo(() => projects ?? [], [projects])

  /**
   * Matches on BOTH the display name and the slug. The slug matters because
   * it is what appears in the URL a reviewer was sent, so it is often the
   * only part of a project someone can remember well enough to type.
   */
  const visibleProjects = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return allProjects
    return allProjects.filter(
      (p) => p.name.toLowerCase().includes(q) || p.slug.toLowerCase().includes(q),
    )
  }, [allProjects, query])

  if (error) {
    return (
      <LoadFailure title="Couldn't load projects" description={error}>
        <Button size="sm" onClick={() => window.location.reload()}>
          Retry
        </Button>
      </LoadFailure>
    )
  }

  return (
    <>
      {/* The page title lives HERE rather than in `page.tsx`, because whether
          it belongs on screen depends on what this component resolved to.

          "If the empty state is for a page, no need for a page title" (Mo,
          2026-08-25). An empty state already names its own subject — "No
          projects" over "Projects" is the same word twice, one of them
          redundant, stacked. So the heading shows while loading and once
          there is a list, and stays away when the whole page is an empty
          state. The failure branch above returns before this for the same
          reason.

          Hidden while LOADING too (Mo, 2026-08-26). The loader already names
          what is arriving, so a heading above it is the same word twice — and
          a heading that appears first, then gets joined by a cat, is two
          arrivals where there is only one.

          `projects.length`, not `visibleProjects.length`: a search that
          matches nothing is not an empty page. The list is still there and
          the heading still describes it. */}
      {/* One gap down the page: heading, filter, grid, 16px each (Mo,
          2026-08-25). They were 20px and 32px, which read as two unrelated
          decisions stacked, and the larger one pushed the grid down the page
          for no reason the eye could attribute to anything.

          16 rather than the grid's own 20: card-to-card is a different
          relationship from section-to-section, and matching them would say
          the filter belongs to the grid the way one card belongs beside
          another.

          The heading is the same SIZE as the wordmark on purpose, too: the
          two are told apart by face, weight and colour (teal Playfair 700
          against foreground DM Sans 600), not by scale. See
          `blocks/wordmark.tsx`. */}
      {projects !== null && projects.length > 0 ? (
        <h1 className="mb-4 text-2xl font-medium">Projects</h1>
      ) : null}

      {/* Filter row: search on the left, the create action pushed to the right
          edge by `ml-auto`. Same shape as the Editor launcher's row.

          The WHOLE row is conditional on there being at least one project,
          which is a deliberate difference from the Editor launcher. There the
          top button survives the empty state because the empty state's own
          controls are DIFFERENT things (open a local folder, clone from
          GitHub), so nothing is duplicated. Here they would be the same
          button twice, a hundred pixels apart — which read as a bug when it
          was measured in the gallery. Empty means one call to action, and the
          empty state is the better place for it. */}
      {projects !== null && projects.length > 0 ? (
        <div className="mb-4 flex items-center gap-3">
          <div className="relative w-full max-w-xs">
            <Search
              className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search projects"
              aria-label="Search projects"
              className="pl-8"
              data-testid="projects-search"
            />
          </div>
          {/* X4: create authority, not read authority — a Viewer can search
              the list above, but the server refuses their POST /projects, so
              the button that starts that flow has no reason to be here. */}
          {canManage ? (
            <Button
              /*
                `secondary`, not the filled default and not `outline` (Mo,
                2026-08-26). In a populated toolbar this sits above the list it
                adds to, and a filled primary there outshouts the projects
                themselves.

                Outline was tried first and lost to its neighbour: its border
                is nearly the same grey as the search field's beside it, so the
                two controls flattened into one row of equal weight. A soft
                fill reads as a button without competing with the teal cards.

                The EMPTY state's copy of this button stays FILLED: it is the
                only action on that page, and the two are never on screen at
                once — the toolbar is suppressed when the list is empty.
              */
              variant="secondary"
              className="ml-auto"
              onClick={() => setCreateOpen(true)}
              data-testid="new-project"
            >
              <Plus data-icon="inline-start" />
              Add project
            </Button>
          ) : null}
        </div>
      ) : null}

      {projects === null ? (
        /* A spinner in the middle with the label under it (Mo, 2026-08-19),
           deliberately NOT the Editor launcher's skeleton cards. The two
           surfaces differ here on purpose: the launcher reads a local file
           and lands in a few milliseconds, so a skeleton that matches the
           card geometry is the right anti-jump device. This list is an HTTP
           round-trip to a server that may be cold, which is long enough that
           a person needs telling something is happening, not a grey mock of
           a grid.

           `min-h-64` reserves the vertical space so the grid does not jump up
           the page when it lands.

           The cat in a box, not a spinner (Mo, 2026-08-25). `ProjectLoader`'s
           own header used to argue the opposite — that this list is "arriving
           inside a page that is already there" and so earns less than the
           Editor's loader. That reasoning did not survive contact with the
           Editor, which shows the cat for this exact act: loading somebody's
           list of projects. Two surfaces doing the same thing were showing
           two different waits, and the distinction only existed in a comment. */
        <ProjectLoader label="Loading" className="min-h-64" />
      ) : projects.length === 0 ? (
        /* The old copy here read "Create one with the API, then upload a
           built prototype bundle" — an instruction nobody can follow from
           this screen. There is a button now, so this says what the button
           does.

           X4: a Viewer sees neither the button nor the instruction that
           names it — "create a project" describes an action they don't
           have, on a screen with no admin/editor to hand it to. */
        <EmptyState
          title="No projects"
          /* Says what a project IS, not just what the button does (Mo,
             2026-08-25). Someone on this screen for the first time has no
             way to know, and "Create a project and connect its repository"
             answered a question they had not been able to ask yet. Same
             sentence for a Viewer, who cannot create one but still needs to
             know what is missing. */
          description="A project is built from a repository, for other people to open and comment on."
        >
          {canManage ? (
            <Button onClick={() => setCreateOpen(true)} data-testid="new-project-empty">
              <Plus data-icon="inline-start" />
              Add project
            </Button>
          ) : null}
        </EmptyState>
      ) : visibleProjects.length === 0 ? (
        /* Distinct from the "no projects yet" state above, and it has to be:
           that one means "add something", this one means "your filter is too
           narrow". */
        <EmptyState
          title="No matching projects"
          description={`Nothing here matches "${query.trim()}".`}
          data-testid="projects-no-matches"
        >
          <Button variant="outline" onClick={() => setQuery("")}>
            Clear search
          </Button>
        </EmptyState>
      ) : (
        <div className="grid gap-5" style={gridStyle}>
          {/* Indexed over the FILTERED list, so the row banding re-flows to
              match what is on screen. Banding the unfiltered index would
              leave a filtered grid with gaps in its colour sequence. */}
          {visibleProjects.map((project, index) => (
            <ProjectCard
              key={project.id}
              project={project}
              href={prototypeHref({
                slug: project.slug,
                serveDomain,
                publicUrl,
                anonymouslyReadable: prototypeAnonymouslyReadable(project.access, publicLinksEnabled),
              })}
              canManage={canManage}
              onDeleted={handleDeleted}
              onSetUp={() =>
                setConnecting({ id: project.id, name: project.name, access: project.access })
              }
              tint={rowTint(index, columns)}
            />
          ))}
        </div>
      )}

      <CreateProjectDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        publicUrl={publicUrl}
        onCreated={handleCreated}
      />

      {/* Step two of the Add-project flow: pick the source. It mounts only
          while `connecting` is set, so the panels' own fetches fire fresh for
          each new project instead of being keyed and reset. */}
      <Dialog open={connecting !== null} onOpenChange={(next) => !next && closeConnecting()}>
        <DialogContent size="lg">
          {addingGithubAccess ? (
            <>
              <DialogHeader>
                <DialogTitle>Set up GitHub access</DialogTitle>
                <DialogDescription>{GITHUB_APP_SETUP_INTRO}</DialogDescription>
              </DialogHeader>
              <GithubAccessSetupStep
                onBack={() => setAddingGithubAccess(false)}
                onClose={closeConnecting}
                /* Come back with this wizard open, not to a bare dashboard. */
                returnTo={
                  connecting ? `/?connect=${encodeURIComponent(connecting.id)}` : undefined
                }
              />
            </>
          ) : (
            <>
              <DialogHeader>
                {/* The wizard's second step keeps the wizard's TITLE (Mo,
                    2026-08-29): both steps say "Add project", so these
                    screens read as part of adding, not as settings. This
                    dialog only ever opens from `handleCreated` and its
                    `?connect=` return leg, so the title is never wrong for
                    some other entry. */}
                <DialogTitle>Add project</DialogTitle>
                {/* No project name (Mo, 2026-08-29: keep copy generic
                    where we can) — the reader named it one click ago, and
                    the sentence says the same thing without it. */}
                <DialogDescription>
                  Where the project comes from: a GitHub repository, or a build you upload.
                </DialogDescription>
              </DialogHeader>
              {connecting ? (
                <AddPrototypeSource
                  projectId={connecting.id}
                  onClose={closeConnecting}
                  /* Come back with this wizard open, not to a bare dashboard. */
                  returnPath={`/?connect=${encodeURIComponent(connecting.id)}`}
                  onSetUpGithub={() => setAddingGithubAccess(true)}
                  onUploaded={() => {
                    closeConnecting()
                    /* The new deployment should show on the card straight away. */
                    setReloadToken((n) => n + 1)
                  }}
                />
              ) : null}
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}

/**
 * The uppercase meta strip under each card — the Viewer's answer to the
 * Editor launcher's "Opened 3 days ago".
 *
 * It says ONE thing: what happened to the last build, and when. It used to
 * lead with the project's visibility ("MEMBERS · DEPLOYED 3H AGO") and the
 * card body carried two more status lines above it — a public-link warning
 * and "Last build failed". Mo cut all of it on 2026-08-19: the failure was
 * being said twice on the same card, and visibility is not what someone
 * scanning a grid of projects is looking for.
 *
 * "Deployed" reports the build's START time, because that is the only
 * timestamp `Deployment` stores. For a finished build the difference is the
 * build duration and nobody will notice; for a `building` row it would be
 * actively misleading, which is why that case says "Building now" and gives
 * no time at all.
 *
 * `formatRelativeTimeShort` rather than the long form, measured: at four
 * columns this strip is 215px, and `Build failed 40 minutes ago` rendered
 * 237px there.
 */
function metaLine(project: ProjectSummary): string {
  const deployment = project.activeDeployment
  if (!deployment) return "Never deployed"
  if (deployment.status === "building") return "Building now"
  const when = formatRelativeTimeShort(deployment.createdAt)
  const verb = deployment.status === "failed" ? "Failed" : "Deployed"
  return when ? `${verb} ${when}` : verb
}

/*
 * The card carries NO access badge (Mo, 2026-08-25). It used to show two:
 * "Public" for a reachable public-link project, then "Invited". Both are
 * gone, and `project-access-badge.tsx` went with them — with neither state
 * left there was no component.
 *
 * What that gives up, so nobody restores it by accident and nobody misses it
 * silently: a public-link project is readable by anyone holding the URL with
 * no sign-in, and the pill was the only marking that said so at a glance.
 * That fact now lives only in the access dialog, which is also where it gets
 * chosen. The card's one status line is `metaLine` above, about the build.
 */

/**
 * A project card, built to the Editor launcher's recipe: a tinted teal parent
 * FRAMES two children — the white content card, and the meta strip under it.
 * `p-1.5` on the parent is what makes it a frame rather than a backing sheet,
 * so the tint shows on all four sides. The tint is passed IN, because it
 * encodes the card's row and no card can know its own row.
 *
 * Radii: parent `rounded-2xl` (16px), card `rounded-xl` (12px), padding 6px.
 * True concentricity wants `inner = outer - padding` = 10px, which is not a
 * step on the radius ramp, so 12 is the deliberate round-up. If the padding
 * ever moves, re-check both radii together — they are a set.
 *
 * ## What differs from the Editor's card, and why
 *
 * **The whole card is a link, not a button.** Opening a project is a
 * top-level navigation and in subdomain mode it crosses to another origin, so
 * it has to be a real `<a href>` — a click handler would break
 * middle-click, cmd-click and "copy link address" on the primary action of
 * the primary screen.
 *
 * **Review (and, for a caller who can manage projects, Delete) replace the
 * settings gear** in the hover-revealed corner. Same slot, same treatment.
 * Both are hidden until hover for the same reason the Editor hides its gear:
 * they are secondary to opening the project, and a permanently visible
 * cluster of buttons turns a scannable grid into a wall of controls.
 * `focus-within:opacity-100` on their shared container keeps them reachable
 * by keyboard, and `[@media(hover:none)]` pins them visible on touch, where
 * hover never fires and they would otherwise be unreachable.
 *
 * **An undeployed project is inert.** There is nothing at `/p/{slug}/` to
 * open, so the card renders as a disabled button rather than a dead link, and
 * the strip below says why.
 */
function ProjectCard({
  project,
  href,
  canManage,
  onDeleted,
  onSetUp,
  tint,
}: {
  project: ProjectSummary
  href: string
  /** May this caller delete the project — see `ProjectsList`'s `canManageProjects`. */
  canManage: boolean
  onDeleted: (projectId: string) => void
  /**
   * Resumes the Add-project wizard at its source step for THIS project
   * (Mo, 2026-08-30: option 2). A never-deployed card used to be a disabled
   * dead end; now clicking it reopens the flow the person left, since a
   * project exists from step 1 whether or not step 2 ever finished.
   */
  onSetUp: () => void
  tint: string
}) {
  const deployed = project.activeDeploymentId !== null

  /**
   * `?settings=<id>` opens this card's repo dialog, so the combined
   * GitHub-access flow can come back to it (2026-08-29). Each card tests the
   * parameter against its OWN id, which is why this needs no lookup: a card
   * only renders for a project the reader can already see.
   *
   * Lazy initializer rather than an effect, for the reason `SettingsNav` and
   * the review screen record for theirs: an effect paints the closed state
   * first and opens a frame later, which reads as a stray modal rather than
   * as the flow resuming. Reading `window` during render is safe because a
   * dialog's open state is not in the server-rendered markup — Radix portals
   * its content, so both sides agree on an empty container.
   */
  const [settingsOpen, setSettingsOpen] = useState(
    () =>
      typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).get("settings") === project.id,
  )
  /** Same step state as the Add flow's — see `addingGithubAccess` there. */
  const [settingsGithubAccess, setSettingsGithubAccess] = useState(false)
  /** Closing drops `?settings=`, for the reason `closeConnecting` records. */
  const closeSettings = useCallback(() => {
    setSettingsOpen(false)
    setSettingsGithubAccess(false)
    clearUrlParams("settings")
  }, [])
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const handleDelete = useCallback(async () => {
    setDeleting(true)
    setDeleteError(null)
    try {
      const res = await fetch(`/api/v1/projects/${encodeURIComponent(project.id)}`, { method: "DELETE" })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        setDeleteError(body?.error ?? "Couldn't delete this project. Try again.")
        return
      }
      setDeleteOpen(false)
      onDeleted(project.id)
    } catch (err) {
      setDeleteError(failureMessage(err))
    } finally {
      setDeleting(false)
    }
  }, [project.id, onDeleted])

  /**
   * Shared by both branches, so a deployed and an undeployed card are the
   * same object — only the interactivity and the two things below differ.
   */
  const cardBase =
    "flex h-auto min-h-24 w-full flex-1 flex-col items-stretch justify-start gap-1.5 rounded-xl border border-transparent bg-card p-3 text-left whitespace-normal shadow-xs"
  const cardInteractive =
    "transition-shadow duration-200 hover:border-foreground/20 hover:shadow-sm"

  const body = (
    <>
      <span className="min-w-0 truncate text-base font-medium text-foreground">{project.name}</span>
      {/* `mt-auto` is the bottom alignment: an auto top margin on the last
          child absorbs the free space above it, so the name stays pinned to
          the top, the path sits on the floor, and a taller card opens the gap
          BETWEEN them rather than leaving a void underneath. */}
      <span className="mt-auto truncate text-xs text-muted-foreground" title={href}>
        {href}
      </span>
    </>
  )

  return (
    // `group` so the Review action can reveal on hover. It cannot live INSIDE
    // the card, which is one big link, so it is a positioned sibling over it —
    // hence `relative` here.
    <div
      className={cn(
        "group relative flex flex-col gap-1 rounded-2xl p-1.5",
        // The row tint, unconditionally.
        //
        // Until 2026-09-01 an undeployed card sat on a flat grey ground,
        // because the card itself was a `disabled` Button: 50% transparent,
        // so the frame showed through, and over the teal ramp that produced
        // an aqua card in a row of white ones. Grey was the fix for that.
        //
        // No card is disabled any more, so the grey has nothing left to say.
        // Worse, it said the wrong thing: an out-of-service ground is the
        // same "you are not allowed" message the disabled state was sending,
        // just moved from the control to the colour behind it. Fixing only
        // the click would have half-fixed the complaint.
        tint,
      )}
    >
      {/* The card opens the REVIEW screen, not the bare prototype.

          It used to open the prototype, with a comment icon in the corner as
          the way through to review. That icon is gone (Mo, 2026-08-25:
          "Remove all extraneous badges or statuses"), and it was the ONLY
          link to `/review/:slug` anywhere in the viewer — so leaving the card
          pointed at the prototype would have stranded the review screen
          behind a hand-typed URL.

          Opening review loses nothing: it embeds the prototype in an iframe,
          so the prototype is still what you see, with the comment rail beside
          it. The card keeps printing the prototype's own URL below the name,
          which is where it is served rather than where this click goes. */}
      {deployed ? (
        <Button asChild variant="outline" className={cn(cardBase, cardInteractive)}>
          <a href={`/review/${project.slug}`} data-testid={`project-open-${project.slug}`}>
            {body}
          </a>
        </Button>
      ) : canManage ? (
        /* Never deployed, and the caller can fix that: the card itself
           resumes the Add wizard at its source step (Mo, 2026-08-30) — the
           project exists from step 1, so this is the flow they left, not
           a new one. Review stays deployment-only (`resolveReviewProject`),
           which is why this can't be a `/review/…` link. */
        <Button
          variant="outline"
          onClick={onSetUp}
          className={cn(cardBase, cardInteractive)}
          data-testid={`project-open-${project.slug}`}
        >
          {body}
        </Button>
      ) : (
        /* A viewer-role caller cannot set it up, but they can still LOOK at
           it. This used to be a disabled button, and a disabled control says
           "you are not allowed" when the truth is "nobody has built this yet"
           (Mo, 2026-09-01). The review route now tells those apart and renders
           an honest empty state for the second, so this is an ordinary link,
           identical to the deployed branch. */
        <Button asChild variant="outline" className={cn(cardBase, cardInteractive)}>
          <a href={`/review/${project.slug}`} data-testid={`project-open-${project.slug}`}>
            {body}
          </a>
        </Button>
      )}

      {/* The meta strip, sitting on the tint inside the frame.

          `px-3` MATCHES the card's `p-3`, and `border border-transparent`
          matches the card's 1px outline border — together they equalise the
          box model so this label's text lands on the same vertical line as
          the project name above it. Change the card's padding or border and
          change this with it, or two left edges drift a few pixels apart and
          read as a mistake rather than a choice.

          One label colour serves all four rows in both modes, which is what
          the alpha ceiling in `ROW_TINTS` buys. /85 rather than /75: measured
          across every tint-over-mode combination, the worst case (deepest row
          on dark) was 5.13:1 at /85 against 4.36:1 at /75, which is under AA.

          That measurement was taken when the ramp opened on /45. It now opens
          on /34 (Mo, 2026-09-01), so the deepest tint is lighter than the one
          measured and the worst case can only have improved. /85 stays, and
          stays conservative. */}
      {/* The strip is a ROW now, not a lone label: the card's own actions sit
          at its right end (Mo, 2026-08-25), matching the Editor launcher's
          card, whose gear left the hover-revealed top-right corner for this
          same row on 2026-08-21. A control that only appears on hover, inside
          a strip that is always visible, is a worse trade than showing it. */}
      <div className="flex items-center gap-1">
        <span
          className="min-w-0 flex-1 truncate border border-transparent px-3 py-1 text-2xs font-medium tracking-wide text-foreground/85 uppercase"
          data-testid={`project-meta-${project.slug}`}
        >
          {metaLine(project)}
        </span>
        {canManage ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                className={cn("mr-1.5 flex-none", HOVER_REVEAL)}
                aria-label={`More actions for ${project.name}`}
                data-testid={`project-menu-${project.slug}`}
              >
                <MoreVertical />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => setSettingsOpen(true)}>
                <Settings />
                Settings
              </DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => {
                  // A previous attempt's error must not survive into a fresh
                  // one — otherwise reopening this dialog shows a failure
                  // from last time before the user has done anything.
                  setDeleteError(null)
                  setDeleteOpen(true)
                }}
                data-testid={`project-delete-${project.slug}`}
              >
                <Trash2 />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>

      {/* The SAME repo settings the review rail opens (`rail-menus.tsx`'s
          "Repository"), mounted here so a project's settings are reachable
          without first opening the project. Access is deliberately not
          duplicated into this menu yet — it lives in the rail beside the
          screen it affects. */}
      <Dialog
        open={settingsOpen}
        onOpenChange={(next) => (next ? setSettingsOpen(true) : closeSettings())}
      >
        <DialogContent size="xl">
          {settingsGithubAccess ? (
            <>
              <DialogHeader>
                <DialogTitle>Set up GitHub access</DialogTitle>
                <DialogDescription>{GITHUB_APP_SETUP_INTRO}</DialogDescription>
              </DialogHeader>
              <GithubAccessSetupStep
                onBack={() => setSettingsGithubAccess(false)}
                onClose={closeSettings}
                returnTo={`/?settings=${encodeURIComponent(project.id)}`}
              />
            </>
          ) : (
            <>
              <DialogHeader>
                {/* Matches the review screen's title for the SAME panel (Mo,
                    2026-08-29: "Repository settings") — one dialog, one name.
                    The project's name rides the description, since out here
                    the reader isn't inside it. */}
                <DialogTitle>Repository settings</DialogTitle>
                <DialogDescription>
                  Where {project.name} is built from.
                </DialogDescription>
              </DialogHeader>
              <ProjectRepoPanel
                projectId={project.id}
                onClose={closeSettings}
                /* Come back with this dialog open, not to a bare dashboard. */
                returnPath={`/?settings=${encodeURIComponent(project.id)}`}
                onSetUpGithub={() => setSettingsGithubAccess(true)}
              />
            </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={deleteOpen} onOpenChange={(open) => !deleting && setDeleteOpen(open)}>
        {/* No `X` while the delete is in flight. Mo, 2026-08-28. */}
        <DialogContent showCloseButton={!deleting}>
          <DialogHeader>
            <DialogTitle>Delete {project.name}?</DialogTitle>
            <DialogDescription>
              This removes the project, its comments and its deployments. This can&apos;t be undone.
              {deleteError ? (
                <span role="alert" className="mt-2 block text-destructive">
                  {deleteError}
                </span>
              ) : null}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setDeleteError(null)
                setDeleteOpen(false)
              }}
              disabled={deleting}
            >
              Cancel
            </Button>
            {/* `busy` for the spinner — see `Button`'s own doc. A delete
                confirm has no other progress indicator. */}
            <Button
              variant="destructive"
              onClick={() => void handleDelete()}
              disabled={deleting}
              busy={deleting}
            >
              {deleting ? "Deleting" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
