"use client"

import { useMemo, useState } from "react"
import { useLauncherRoute } from "./use-launcher-route"
import { FolderOpen, GitBranch, MoreVertical, Plus, Search, Sparkles } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import {
  AppHeader,
  Callout,
  ChoiceTile,
  EmptyState,
  HOVER_REVEAL,
  ProjectLoader,
  rowTint,
  useProjectGrid,
} from "@/components/blocks"
import { formatRelativeTime } from "@/lib/relative-time"
import { OpenBlockNotice } from "@/components/editor/launcher/open-block-notice"
import {
  NewProjectPage,
  type NewProjectSource,
} from "@/components/editor/launcher/new-project-page"
import {
  useLauncherApi,
  type LauncherProject,
} from "@/components/editor/launcher/use-launcher-api"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { LauncherSettingsMenu } from "@/components/editor/launcher/launcher-settings-menu"
import { ProjectSettingsPage } from "@/components/editor/launcher/project-settings-page"
import { demoDeleteMessage } from "@/components/editor/launcher/demo-delete-message"
import { useDesktopUpdates } from "@/hooks/useDesktopUpdates"
import { Toaster } from "@/components/ui/sonner"
import { useClaudeRuntimeStatus } from "@/hooks/useClaudeRuntimeStatus"

/**
 * Trim a repo path from the FRONT so its identifying tail survives.
 *
 * The card shows the path in a two-line clamp, and a clamp ellipsises the
 * END. For a path that is the wrong end entirely: MEASURED on the real
 * launcher, five of six cards overflowed (89px of text clamped to 30px) and
 * every one of them displayed
 * `/private/tmp/claude-501/-Users-mauricechang-Documents-` — a head that is
 * byte-identical across unrelated projects, while the last segment that
 * actually names the project was the part clipped away.
 *
 * A `dir="rtl"` + LRM span is what used to solve this, and it only works with
 * `truncate`: single-line, `white-space: nowrap`, ellipsis at the visual
 * start. It does not survive wrapping, so once the path is allowed two lines
 * the trick has to be replaced rather than adjusted.
 *
 * Whole segments are dropped, not characters, so the result is always a
 * readable path suffix rather than a string cut mid-word. The budget is
 * deliberately under two lines' worth (roughly 33 characters per line at
 * `text-xs` in this card width) so the clamp stays a backstop for the one
 * case this cannot help: a single trailing segment longer than the budget,
 * which is returned whole because a too-long name beats an empty line.
 */
export function trimPathToTail(path: string, maxChars = 60): string {
  if (path.length <= maxChars) return path
  const segments = path.split("/").filter(Boolean)
  let tail = ""
  for (let i = segments.length - 1; i >= 0; i--) {
    const candidate = `/${segments[i]}${tail}`
    if (candidate.length > maxChars - 1) break // -1 leaves room for the ellipsis
    tail = candidate
  }
  return `…${tail || `/${segments[segments.length - 1]}`}`
}

/**
 * Launcher home page — the pre-project surface `desde`
 * serves when invoked with no repo path. A editor-style top nav bar
 * (the Desde wordmark + New project + account) sits above a recent-
 * projects card grid, whose grid maths and teal row ramp are shared
 * with the Viewer dashboard (`blocks/project-grid.tsx`); opening
 * one spawns a editor and redirects. New projects come from a local
 * folder (native OS picker) or a git clone.
 *
 * Rendered from the same UI bundle as the editor (main.tsx branches on
 * `window.__DESDE_LAUNCHER__`), so it inherits the shared theme —
 * no bespoke styling surface.
 */
export function LauncherPage({
  folderPickerSupported,
}: {
  folderPickerSupported: boolean
}) {
  // Grid maths + the teal row ramp are shared with the Viewer dashboard —
  // see `src/components/blocks/project-grid.tsx` for why they live there.
  const { columns, style: gridStyle } = useProjectGrid()
  const api = useLauncherApi()
  const updates = useDesktopUpdates()
  // Side-effect-only (toast on downloading/error) — the launcher is the
  // FIRST screen a user sees, so this is where a first-ever install's
  // "downloading" toast is most likely to actually fire.
  useClaudeRuntimeStatus()
  // The create flow is a VIEW of this page, addressed by `#/new`, not a modal
  // over it. See `use-launcher-route.ts` for why the hash and why the view
  // rather than the step.
  const { route, navigate } = useLauncherRoute()
  // The project awaiting a delete confirm. Holding the whole entry, not the
  // path, so the dialog can name it after the row has left the list.
  const [pendingDelete, setPendingDelete] = useState<LauncherProject | null>(null)
  /**
   * Whether the row awaiting confirmation is the bundled demo. Compared on the
   * server-reported path rather than a name or a slug, either of which the user
   * can change. The empty-string guard matters: a failed demo probe reports an
   * empty path, and every project path would otherwise fail to match it, which
   * is correct, but an empty pendingDelete.path would not.
   */
  const deletingDemo =
    pendingDelete !== null && (api.demo?.path ?? "") !== "" && pendingDelete.path === api.demo?.path
  /**
   * Offered whenever the demo is not already on disk.
   *
   * Deliberately NOT gated on `triedAt`, which an earlier draft used to demote
   * the tile after one try. That gate turned out to be redundant and, in its
   * one reachable case, wrong: this empty state renders only when there are
   * ZERO prototypes, and trying the demo makes one, so the state disappears on
   * its own. The single case where the gate would have fired is "tried the
   * demo, deleted it, have nothing else" — which is exactly when offering it
   * again is the right thing to do.
   *
   * `triedAt` stays on the server. It is the durable record of whether this
   * machine has ever seen the demo, and a future New-prototype source card can
   * use it to rank itself. Nothing reads it here.
   */
  const showDemoTile = api.demo !== null && !api.demo.present
  const [deleting, setDeleting] = useState(false)
  const dialogOpen = route.view === "new-project"
  // A third view, same mechanism: settings SWAP the list rather than stacking
  // over it, for the reason `use-launcher-route.ts` gives about Back.
  const settingsPath = route.view === "project-settings" ? route.path : null
  const dialogSource = route.view === "new-project" ? route.source : null
  const [query, setQuery] = useState("")

  const openDialog = (source: NewProjectSource | null) => {
    navigate({ view: "new-project", source })
  }
  const closeDialog = (next: boolean) => {
    if (!next) navigate({ view: "projects" })
  }

  /**
   * Leave the create view when the FINAL open kicks off (post design-system
   * step) — the full-page loader is the single busy surface, so the wizard
   * stacked behind it would be redundant. Only wraps `onOpenPath`: pick/
   * clone no longer open anything by themselves (the flow stays up through
   * its own "Add a design system" step), so they don't leave. Failures
   * surface in the page-level error callout the flow leaves behind.
   */
  const handoffToLoader =
    <A extends unknown[], R>(action: (...args: A) => Promise<R>) =>
    (...args: A): Promise<R> => {
      navigate({ view: "projects" })
      return action(...args)
    }

  const isLoading = api.projects === null
  // Memoised, not a bare `?? []`: the fallback allocates a new array on every
  // render, which would make it a fresh dependency each time and stop the
  // filter memo below from ever memoising.
  const projects = useMemo(() => api.projects ?? [], [api.projects])
  const busy = api.busy !== null

  /**
   * Matches on BOTH the display name and the full path. Path matters as much
   * as name here: this list routinely holds several projects with the same
   * trailing name in different directories (`ai-gateway-prototype` sits in
   * the repo AND in two scratchpads), and the path is the only thing that
   * tells them apart.
   */
  const visibleProjects = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return projects
    return projects.filter((p) => {
      const label = p.slug ?? p.path.split("/").pop() ?? p.path
      return (
        label.toLowerCase().includes(q) || p.path.toLowerCase().includes(q)
      )
    })
  }, [projects, query])

  return (
    <div className="flex min-h-dvh flex-col bg-background text-foreground">
      {/*
        `width` follows the VIEW, and must stay in step with <main>'s below.
        The project list is `max-w-5xl`; the create flow is `max-w-2xl`, and
        with the header pinned to the wider one the wordmark sat a long way
        left of the form it was heading.
      */}
      <AppHeader width={dialogOpen ? "2xl" : "5xl"}>
        {/*
          UNguarded as of 2026-08-18. It used to render only when the desktop
          bridge was present, because the only thing here was an update button
          and a browser tab has no updates. The gear now also holds the
          Anthropic API key, which is machine-level and just as useful in a
          browser tab, so hiding it there would leave a CLI user no way to set
          a key before opening a project.
        */}
        <LauncherSettingsMenu updates={updates} />
      </AppHeader>
      {/* The launcher's toast outlet, matching `editor-page.tsx`. Without it
          every notice raised on this page (the runtime install's "Setting up
          AI chat", a failed update-setting write) rendered into nothing:
          sonner needs a mounted Toaster on the page, and this page had none
          until 2026-09-02. */}
      <Toaster position="bottom-left" richColors closeButton />

      {/*
        The project list and the create flow are two VIEWS of this page, not a
        page with a modal over it. New Project outgrew a dialog: six states and
        two nested sub-flows in a 36rem box, with no way to see where you were.

        Swapped rather than stacked because `NewProjectPage` brings its own
        narrower column (`max-w-2xl`); rendering it inside this one would nest
        two centred columns and double the padding. `NewProjectPage` returns
        null when `open` is false, so it stays where it is below and only this
        half needs the guard.
      */}
      {dialogOpen || settingsPath ? null : (
      <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-10">
        {/* Heading row: the page title on the left, the create action on the
            right, one line. The button sat a row lower, beside the search
            field, until 2026-09-02 (Mo: align it with the Projects header).
            It lives here rather than in the search row so it never
            disappears with that row on an empty list. */}
        <div className="mb-6 flex items-center justify-between gap-3">
          <h1 className="text-2xl font-medium">Projects</h1>
          <Button
            onClick={() => openDialog(null)}
            disabled={busy}
            data-testid="launcher-new-project"
          >
            <Plus data-icon="inline-start" />
            New project
          </Button>
        </div>

        {/* The search input renders only when there is something to search.
            A filter over an empty list is a control that cannot do anything,
            and the empty state below already carries the ways in. */}
        {projects.length > 0 ? (
          <div className="relative mb-8 w-full max-w-xs">
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
              data-testid="launcher-search"
            />
          </div>
        ) : null}

        {/* A structured refusal renders in full; a plain string stays a one
            line banner. The two are mutually exclusive in the hook, so the
            page never shows the same failure twice in two shapes. */}
        {api.openBlock ? (
          <OpenBlockNotice block={api.openBlock} className="mb-6" />
        ) : api.error ? (
          <Callout tone="destructive" size="lg" className="mb-6">
            {api.error}
          </Callout>
        ) : null}

        {isLoading ? (
          <div className="grid gap-5" style={gridStyle}>
            {/* One skeleton per column, so the placeholder row matches the
                real grid's shape at every breakpoint instead of a fixed 3. */}
            {Array.from({ length: columns }, (_, i) => (
              // min-h-32 tracks the real card: min-h-24 panel + the tint
              // strip under it. A skeleton that is not the height of the thing
              // it stands in for buys a layout jump at the moment the data
              // lands, which is the one thing a skeleton exists to prevent.
              <Card key={i} className="min-h-32 gap-2 rounded-xl p-4">
                <div className="h-5 w-28 animate-pulse rounded bg-muted" />
                <div className="flex flex-col gap-1">
                  <div className="h-3 w-full animate-pulse rounded bg-muted" />
                  <div className="h-3 w-2/3 animate-pulse rounded bg-muted" />
                </div>
              </Card>
            ))}
          </div>
        ) : projects.length === 0 ? (
          <EmptyState
            title="No projects"
            description="Open a prototype repo to start authoring."
          >
            {/*
              The demo tile leads, because it is the only option here that
              needs nothing the reader does not already have. It disappears once
              the demo has been tried: `triedAt` survives deleting it, so
              someone who removed it on purpose is not offered it again in the
              most prominent slot on the page. It stays reachable from the New
              prototype sources either way.
            */}
            <div
              className={cn(
                "grid w-full gap-3 text-left",
                showDemoTile ? "max-w-3xl sm:grid-cols-3" : "max-w-xl sm:grid-cols-2",
              )}
            >
              {showDemoTile ? (
                <ChoiceTile
                  size="lg"
                  icon={<Sparkles />}
                  title="Try the demo"
                  hint="A sample app, ready to edit. Nothing to install."
                  disabled={busy}
                  onClick={() => void api.tryDemo()}
                  data-testid="launcher-empty-try-demo"
                />
              ) : null}
              <ChoiceTile
                size="lg"
                icon={<FolderOpen />}
                title="Open a local folder"
                hint={
                  folderPickerSupported
                    ? "Choose a repo with the system file browser."
                    : "Enter the path to a repo on this machine."
                }
                disabled={busy}
                onClick={() => openDialog("local")}
                data-testid="launcher-empty-open-local"
              />
              <ChoiceTile
                size="lg"
                icon={<GitBranch />}
                title="Clone from GitHub"
                hint="Cloned with the git credentials already on this machine."
                disabled={busy}
                onClick={() => openDialog("clone")}
                data-testid="launcher-empty-clone"
              />
            </div>
          </EmptyState>
        ) : visibleProjects.length === 0 ? (
          /* Distinct from the "no projects yet" state above, and it has to
             be: that one means "create something", this one means "your
             filter is too narrow". Offering the create tiles here would
             answer a question nobody asked. */
          <EmptyState
            title="No matching projects"
            description={`Nothing here matches "${query.trim()}".`}
            data-testid="launcher-no-matches"
          >
            <Button
              variant="outline"
             
              onClick={() => setQuery("")}
            >
              Clear search
            </Button>
          </EmptyState>
        ) : (
          <div className="grid gap-5" style={gridStyle}>
            {/* Indexed over the FILTERED list, so the row banding re-flows to
                match what is on screen. Banding the unfiltered index would
                leave a filtered grid with gaps in its colour sequence. */}
            {visibleProjects.map((project, index) => (
              <LauncherProjectCard
                key={project.path}
                project={project}
                disabled={busy}
                // Clamped, not cycled: a long list settles into the calmest
                // tint rather than restarting at full saturation.
                tint={rowTint(index, columns)}
                onOpen={() => void api.openPath(project.path)}
                onSettings={() =>
                  navigate({ view: "project-settings", path: project.path })
                }
                onDelete={() => {
                  // Refresh before showing the confirmation, so the demo's
                  // "nothing will be lost" cannot be minutes stale. Fire and
                  // forget: the dialog opens now, and the copy re-renders when
                  // the fresher summary lands.
                  if (project.path === api.demo?.path) void api.refreshDemo()
                  setPendingDelete(project)
                }}
              />
            ))}
          </div>
        )}
      </main>
      )}

      {/* Full-page busy overlay — covers the launcher while a project
          spawns / clones, until the browser redirects to the editor.
          Suppressed while the dialog is up (the native folder-chooser
          wait keeps it open) so the two never stack. */}
      {/*
        A confirm, because this is destructive in the only sense that applies
        here: the row is gone and nothing on this screen brings it back.

        The description is doing the real work. "Delete" on a card that shows a
        folder path can only read as "delete the folder", and it does not: the
        registry is a recents cache, so this forgets the project and leaves
        every file where it is. Saying that in the dialog is what makes the
        menu item safe to label the way Mo asked for.
      */}
      <Dialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && !deleting && setPendingDelete(null)}
      >
        <DialogContent size="md" data-testid="launcher-delete-project">
          <DialogHeader>
            <DialogTitle>{deletingDemo ? "Delete the demo?" : "Delete this project?"}</DialogTitle>
            <DialogDescription>
              {/*
                The demo is the one row where "the folder stays on disk" would
                be false: its delete really removes the directory, because it
                lives somewhere the user never chose and a recents-only removal
                would strand it. So the copy branches, and the demo half names
                what would actually be lost.
              */}
              {deletingDemo && api.demo ? (
                demoDeleteMessage(api.demo)
              ) : pendingDelete ? (
                <>
                  <strong className="font-medium text-foreground">
                    {pendingDelete.slug ?? pendingDelete.path.split("/").pop()}
                  </strong>{" "}
                  will be removed from this list. The folder and everything in it stays on disk, and
                  opening it again brings the project back.
                </>
              ) : null}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              disabled={deleting}
              onClick={() => setPendingDelete(null)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              busy={deleting}
              data-testid="launcher-delete-project-confirm"
              onClick={() => {
                if (!pendingDelete) return
                setDeleting(true)
                const run = deletingDemo
                  ? api.deleteDemo()
                  : api.removeProject(pendingDelete.path)
                void run.then((res) => {
                  setDeleting(false)
                  // Only close on success: a refused delete has to leave the
                  // dialog up, with the banner behind it carrying the reason.
                  if (res.ok) setPendingDelete(null)
                })
              }}
            >
              {deleting ? "Deleting" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {settingsPath ? (
        <ProjectSettingsPage
          // Keyed on the path so switching projects remounts rather than
          // carrying one project's staged name into another's form.
          key={settingsPath}
          path={settingsPath}
          onClose={() => navigate({ view: "projects" })}
          onInspectReadRoot={api.inspectReadRoot}
          onPickReadRoot={folderPickerSupported ? api.pickReadRoot : undefined}
        />
      ) : null}

      {api.busy && !dialogOpen ? (
        <ProjectLoader
          label={api.busy}
          className="fixed inset-0 z-50 bg-background/90 backdrop-blur-sm"
        />
      ) : null}

      <NewProjectPage
        open={dialogOpen}
        onOpenChange={closeDialog}
        initialSource={dialogSource}
        folderPickerSupported={folderPickerSupported}
        busy={busy}
        error={api.error}
        openBlock={api.openBlock}
        onInspectPath={api.inspectPath}
        onPickFolder={api.pickForNewProject}
        onClone={api.cloneForNewProject}
        onListGitHubRepos={api.listGitHubRepos}
        onOpenPath={handoffToLoader(api.openPath)}
        onSetProjectName={api.setProjectName}
        onSuggestDesignSystems={api.suggestDesignSystems}
        onDeclareDesignSystems={api.declareDesignSystems}
      />
    </div>
  )
}

/**
 * A recent-project card: name, the repo path (in place of the deploy URL),
 * and a relative "opened" timestamp. The whole card is the click target that
 * boots an editor on the repo — a `Button` styled as a card (never a raw
 * `<button>`) so it stays keyboard- and disabled-aware.
 *
 * A tinted teal parent FRAMES two children: the white content card, and the
 * "opened" meta under it. `p-2` on the parent is what makes it a frame rather
 * than a backing sheet — the tint shows on all four sides of the card instead
 * of only below it. The tint is passed IN, because it encodes the card's row
 * and no card can know its own row.
 *
 * Radii: parent `rounded-2xl` (16px), card `rounded-xl` (12px), padding 6px.
 * True concentricity wants `inner = outer - padding` = 10px, which is not a
 * step on the radius ramp (`lg` is 8, `xl` is 12), so 12 is the deliberate
 * round-up — 2px proud rather than 2px shy, which keeps the card corner soft
 * against a soft frame instead of looking clipped. Values tuned by eye in
 * devtools, 2026-08-13. If the padding ever moves, re-check both radii
 * together: they are a set, and a mismatched pair reads as a squeezed corner
 * long before anyone can name why.
 *
 * The cards sit square. An earlier pass tilted them 1deg for the scattered
 * look of the reference; that reference is a marketing collage, and on a
 * scannable list of real click targets the tilt read as skew rather than as
 * play.
 *
 * Depth is carried by the shadow, which is what separates the white card from
 * the tint now that no offset does it. `--shadow-sm` in this theme is already
 * a soft, diffuse `0 4px 10px` — closer to an outer glow than a drop shadow —
 * so the reference's look needs the theme's own token, not a bespoke one.
 * Hover deepens it to `md`, which also replaces the affordance the
 * straighten-on-hover used to provide.
 */
function LauncherProjectCard({
  project,
  disabled,
  tint,
  onOpen,
  onSettings,
  onDelete,
}: {
  project: LauncherProject
  disabled: boolean
  tint: string
  onOpen: () => void
  onSettings: () => void
  onDelete: () => void
}) {
  const name = project.slug ?? project.path.split("/").pop() ?? project.path
  return (
    // `group` is what the row's actions reveal off — see `HOVER_REVEAL`.
    <div className={cn("group flex flex-col gap-1 rounded-2xl p-1.5", tint)}>
      <Button
        variant="outline"
        disabled={disabled}
        onClick={onOpen}
        data-testid={`launcher-project-${name}`}
        // min-h-24, down from 36: the card holds two lines (name + path), and
        // 144px left a third of it empty.
        // shadow-xs, not sm: one layer at 5% instead of two at 10%. The card
        // sits on a tint that already separates it from the page, so the
        // shadow only has to lift it slightly. Hover steps to `sm` to keep
        // the same relative lift the old sm/md pair had.
        className="flex h-auto min-h-24 w-full flex-1 flex-col items-stretch justify-start gap-1.5 rounded-xl border-transparent bg-card p-3 text-left whitespace-normal shadow-xs transition-shadow duration-200 hover:border-foreground/20 hover:shadow-sm"
      >
        <span className="truncate text-base font-medium text-foreground">
          {name}
        </span>
        {/* The ellipsis is in the STRING now, not the CSS — see
            `trimPathToTail`. The `dir="rtl"` + LRM span this replaces put the
            ellipsis at the visual start, which IS the right end to cut, but
            it rides on `truncate`'s `white-space: nowrap` and does not
            survive wrapping.

            `line-clamp-2`, NOT `truncate`, is what allows two lines at all —
            `truncate` can only ever produce one and would silently defeat any
            clamp beside it. It stays as a backstop for the one case the trim
            cannot help: a single segment longer than the whole budget.

            `mt-auto` is the bottom alignment. The card is a flex column, so
            an auto top margin on the last child absorbs the free space above
            it: the name stays pinned to the top, the path sits on the floor,
            and a taller card opens the gap BETWEEN them rather than leaving a
            void under the path. */}
        <span
          className="mt-auto line-clamp-2 text-left text-xs text-muted-foreground"
          title={project.path}
        >
          {trimPathToTail(project.path)}
        </span>
      </Button>
      {/* The meta line, sitting on the tint inside the frame.

          `px-3` MATCHES the card's `p-3`, and that is the whole point: the
          parent's `p-1.5` applies to both children equally, so equal
          horizontal padding puts this label's text on the same vertical line
          as the project name above it. Change the card's padding and change
          this with it, or two left edges drift a few pixels apart and read as
          a mistake rather than a choice.

          `border border-transparent` is load-bearing, not decoration. The
          card is a `variant="outline"` Button carrying a 1px border, so
          matching padding alone would still leave this label one pixel left
          of the name. Matching the border equalises the box model instead of
          reaching for an off-scale `px-[13px]`, which would also silently
          break if the card's border ever changed.

          One label colour serves all five rows in both modes, which is what
          the alpha ceiling in ROW_TINTS buys. 85%, not 75%: MEASURED by
          compositing each tint over each mode's real background, the worst
          case across all ten combinations is the deepest row on dark, and at
          /75 that came to 4.36:1 — under AA by a hair while every light-mode
          row sat above 6. Raising the label to /85 takes the worst case to
          5.13:1 and leaves row 1's teal at full strength; easing the tint
          instead would have paid for the same contrast with the punch this
          treatment exists for. */}
      <div className="flex items-center justify-between gap-2 border border-transparent px-3 py-1">
        <span className="min-w-0 truncate text-2xs font-medium tracking-wide text-foreground/85 uppercase">
          Opened {formatRelativeTime(project.lastOpenedAt)}
        </span>
        {/*
          The card's actions, in the meta row rather than floating over the
          card (Mo, 2026-08-21). The gear that used to sit here was absolutely
          positioned over the top-right corner, because the card is one big
          Button and a button may not nest another. Down here it is a sibling
          of the label in an ordinary flex row, so it needs no positioning.

          It IS still hover-revealed (Mo, 2026-08-25). This comment used to
          argue the opposite — that a control appearing only on hover inside
          an always-visible row is a worse trade than showing it — and that
          is overruled: the strip reads as the card's status line, and a
          permanent button in it competes with the one thing it has to say.
          `HOVER_REVEAL` carries the keyboard, touch and menu-open cases; see
          that constant before trimming any clause out of it.

          `-mr-1.5` pulls the button's own padding back out of the row's
          `px-3`, so the glyph lands on the same right edge the card's content
          uses rather than three pixels inside it.
        */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              disabled={disabled}
              aria-label={`Actions for ${name}`}
              data-testid={`project-menu-${name}`}
              className={cn(
                "-mr-1.5 flex-none text-foreground/85 hover:bg-foreground/10",
                HOVER_REVEAL,
              )}
            >
              <MoreVertical />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={onSettings}>Edit</DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onSelect={onDelete}>
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}
