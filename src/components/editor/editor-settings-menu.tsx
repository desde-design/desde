"use client"

/**
 * Editor settings menu — a vertical "more" (⋮) icon button right-aligned in
 * the workspace header row (across from Editor / Canvas, above the prototype
 * container). It holds:
 *   - "Model & references" — opens the project-conventions dialog: a read-only
 *     view of what the AI tiers are grounded in (CLAUDE.md / AGENTS.md /
 *     .cursorrules / docs …).
 *   - "Design systems" — opens the design-systems dialog (registered libraries
 *     + add-by-detected/npm/repo). This was a top-level right-rail tab; it now
 *     lives behind the gear so it doesn't spend rail chrome on an
 *     onboarding-only surface.
 *   - "Run smoke test" — runs the editor smoke test, surfacing failures in a
 *     dialog.
 *
 * The "Model & references" entry replaces the old always-on "Following
 * CLAUDE.md" header badge — the grounding info now lives behind the gear
 * instead of spending header chrome. The conventions off-switch + exclusion
 * list still live in `.desde/config.json` (editor-cli), not in a
 * settings UI; that dialog is transparency only.
 */

import { useCallback, useState } from "react"
import {
  Boxes,
  FolderSearch,
  KeyRound,
  Settings,
  Puzzle,
  ScrollText,
  Share2,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import { ReferenceDirsPanel } from "@/components/editor/reference-dirs/reference-dirs-panel"
import { DesignSystemsPanel } from "@/components/editor/design-systems-panel"
import { CapabilitiesPanel } from "@/components/editor/capabilities-panel"
import {
} from "@/components/editor/smoke-test-control"
import {
  DesktopUpdateBadge,
  DesktopUpdateRestartConfirmDialog,
  DesktopUpdateSection,
} from "@/components/editor/desktop-update-menu"
import { useProjectKnowledge } from "@/hooks/useProjectKnowledge"
import { useDesktopUpdates } from "@/hooks/useDesktopUpdates"
import { useClaudeRuntimeStatus } from "@/hooks/useClaudeRuntimeStatus"
import { useLlmCredentials } from "@/hooks/useLlmCredentials"
import { useViewerAuthStatus } from "@/hooks/useViewerAuthStatus"
import { YourViewerDialog } from "@/components/editor/your-viewer-dialog"
import { ConnectViewerDialog } from "@/components/editor/connect-viewer-dialog"
import { useFirstRunCredentialPrompt } from "@/hooks/useFirstRunCredentialPrompt"
import { LlmCredentialDialog } from "@/components/editor/llm-credential-dialog"

export function EditorSettingsMenu({
  className,
  invalidateManifest,
  chatSubmitting,
}: {
  className?: string
  /**
   * Final review fix wave — threaded down to the Design Systems dialog's
   * drift panel (`useDriftEntries`) so a dismiss/clear/regenerate-hints
   * response's `invalidate` list drops the SAME `CachedManifestLookup`
   * entry `useEditorEditing`'s `attribution` path reads from. See
   * `useEditorEditing.ts`'s `invalidateAttributionManifest` doc comment.
   */
  invalidateManifest?: (entries: Array<{ name: string; importPath?: string }>) => void
  /**
   * Whether a chat turn is currently streaming — threaded down from
   * `editor-surface.tsx`'s `chat.submitting`. Used ONLY to decide whether
   * clicking "Restart to update" needs a confirmation first
   * (`tasks/electron-app.md` §4). Absent entirely in a browser tab (the
   * desktop update section itself doesn't render there), so `undefined`
   * behaves the same as `false`.
   */
  chatSubmitting?: boolean
}) {
  const [conventionsOpen, setConventionsOpen] = useState(false)
  const [designSystemsOpen, setDesignSystemsOpen] = useState(false)
  const [capabilitiesOpen, setCapabilitiesOpen] = useState(false)
  const [referenceDirsOpen, setReferenceDirsOpen] = useState(false)
  const [restartConfirmOpen, setRestartConfirmOpen] = useState(false)
  const updates = useDesktopUpdates()
  // Side-effect-only (toast on downloading/error) — see the hook's own doc
  // comment for why this has no return value the menu needs to render.
  useClaudeRuntimeStatus()

  // ONE owner of credential state. The dialog receives it as a prop rather
  // than calling the hook itself, so a save or removal in the dialog updates
  // the gear's marker immediately instead of on the next page load.
  const credentials = useLlmCredentials()
  /**
   * The connect-a-viewer flow had no entry point anywhere in the product
   * before 2026-08-18 — it was reachable only from the surface gallery (Mo:
   * "the flow exists but there is nowhere to reach it").
   *
   * It sits in the PROJECT menu, not the launcher's, even though Mo asked for
   * an editor-level setting, because the flow ends by linking THIS repo to a
   * viewer project and there is no repo on the launcher. The half that really
   * is editor-level — the viewer server's URL and token — is already stored
   * per-machine (`viewer-token-store.ts`), so connecting a second project to
   * the same viewer does not ask for the token again. Splitting the dialog
   * into "which server" (editor) and "which project" (repo) is the follow-up.
   */
  const viewerAuth = useViewerAuthStatus()
  const [yourViewerOpen, setYourViewerOpen] = useState(false)
  const [connectViewerOpen, setConnectViewerOpen] = useState(false)
  const credentialStatus = credentials.status
  const { shouldPrompt: credentialPrompt, dismiss: dismissCredentialPrompt } =
    useFirstRunCredentialPrompt(credentialStatus, credentials.dismissPrompt)
  const [credentialDialogManuallyOpen, setCredentialDialogManuallyOpen] =
    useState(false)
  const credentialMissing = credentialStatus?.source === "none"
  // The first-run prompt opens the SAME dialog the gear opens, because they
  // ask for the same thing. `manuallyOpen` only has to override the auto-open
  // once it has been dismissed.
  const credentialDialogOpen = credentialDialogManuallyOpen || credentialPrompt

  const handleCredentialDialogChange = useCallback(
    (open: boolean) => {
      setCredentialDialogManuallyOpen(open)
      // Closing the auto-opened prompt IS the dismissal. Without this the
      // dialog would immediately reopen, since `credentialPrompt` is still
      // true while no credential exists.
      if (!open && credentialPrompt) dismissCredentialPrompt()
    },
    [credentialPrompt, dismissCredentialPrompt],
  )

  /**
   * An update the user could act on RIGHT NOW — downloaded and waiting, or
   * offered for download. Not `checking` (nothing to say yet), not
   * `downloading` (already happening), not `error` (a problem, not an
   * invitation).
   */
  const updateReady =
    updates?.state.phase === "available" || updates?.state.phase === "ready"

  const handleRestartClick = () => {
    if (chatSubmitting) {
      setRestartConfirmOpen(true)
      return
    }
    updates?.restartAndInstall()
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          {/*
            The button GROWS to say "Update" when there is one, rather than
            wearing a coloured dot (Mo, 2026-08-17).
            
            A dot on a gear says "something in here changed" and makes the user
            open the menu to find out what. An update is the one thing behind
            this menu worth interrupting for, and it has a deadline, so it says
            its own name. Every other phase — checking, downloading, error —
            keeps the dot: those are progress and problems, not a call to act.
          */}
          <Button
            variant={updateReady ? "outline" : "ghost"}
            size={updateReady ? "sm" : "icon-sm"}
            // F4 (whole-branch review, Minor): `relative` only matters when
            // the badge below actually renders (it's positioned absolute
            // against this button) — applying it unconditionally gave a
            // plain browser tab one class it never had at the merge base,
            // even though the CLI-in-a-browser flow is otherwise untouched
            // by construction (see useDesktopUpdates.ts's module doc
            // comment).
            className={cn(updates || credentialMissing ? "relative" : undefined, className)}
            title="Editor settings"
            data-testid="editor-settings"
          >
            {/*
              A gear, not `⋮`. Three dots means "more of the same kind of
              thing" and gives no clue what is behind it; a gear is the one
              glyph every desktop app already spends on settings, which is
              what this menu is.
            */}
            <Settings />
            {updateReady ? "Update" : null}
            {/* The dot is redundant once the word is there. */}
            {updates && !updateReady ? (
              <DesktopUpdateBadge state={updates.state} />
            ) : null}
            {credentialMissing ? (
              <span
                data-testid="editor-settings-credential-marker"
                aria-label="AI features need an API key"
                // BOTTOM-right, not top-right: `DesktopUpdateBadge` owns the
                // top-right corner, and this marker renders after it, so
                // sharing the position hid update-ready and update-error
                // whenever credentials were also missing.
                className="absolute -bottom-0.5 -right-0.5 size-2 rounded-full bg-warning"
              />
            ) : null}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DesktopUpdateSection updates={updates} onRestartClick={handleRestartClick} />
          <DropdownMenuItem
            onSelect={() => setCredentialDialogManuallyOpen(true)}
            data-testid="editor-settings-api-key"
          >
            <KeyRound className="h-4 w-4" />
            Anthropic API key
            {credentialMissing ? (
              <span className="ml-auto text-2xs text-muted-foreground">Not set</span>
            ) : null}
          </DropdownMenuItem>
          {/*
            Color theme is hidden (Mo, 2026-08-17). Dark mode is not designed
            yet — `CLAUDE.md` says so outright — and a theme picker whose
            themes are undesigned invites a choice that makes the product
            look worse. The sub-menu and every theme are still here in
            `themes`; this is a gate, not a deletion.
          */}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => setConventionsOpen(true)}
            data-testid="editor-settings-references"
          >
            <ScrollText className="h-4 w-4" />
            Model &amp; references
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => setCapabilitiesOpen(true)}
            data-testid="editor-settings-capabilities"
          >
            <Puzzle className="h-4 w-4" />
            Extensions…
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => setDesignSystemsOpen(true)}
            data-testid="editor-settings-design-systems"
          >
            <Boxes className="h-4 w-4" />
            Design systems
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => setReferenceDirsOpen(true)}
            data-testid="editor-settings-reference-dirs"
          >
            <FolderSearch className="h-4 w-4" />
            Reference folders
          </DropdownMenuItem>
          {/* The MACHINE's viewer, above the per-repo link. Setting it once
              is what lets every other repo resolve itself, so it comes first:
              the item below is the override, not the starting point. */}
          <DropdownMenuItem
            onSelect={() => setYourViewerOpen(true)}
            data-testid="editor-settings-your-viewer"
          >
            <Share2 className="h-4 w-4" />
            Your viewer
            {viewerAuth.status?.defaultOrigin ? null : (
              <span className="ml-auto text-2xs text-muted-foreground">Not set</span>
            )}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => setConnectViewerOpen(true)}
            data-testid="editor-settings-connect-viewer"
          >
            <Share2 className="h-4 w-4" />
            {viewerAuth.status?.configured ? "Viewer" : "Share for review…"}
            {viewerAuth.status?.configured ? (
              <span className="ml-auto text-2xs text-muted-foreground">Connected</span>
            ) : null}
          </DropdownMenuItem>
          {/*
            "Run smoke test" is hidden (Mo, 2026-08-17: "I am not even sure
            what this is"). That is the finding, not the fix — a menu item
            whose owner cannot say what it does has no business in a settings
            menu a designer opens.

            The machinery stays wired (`useSmokeTest`, the failure dialog) so
            un-hiding it is deleting this comment. What it needs first is a
            name that says what it checks and when to reach for it.
          */}
        </DropdownMenuContent>
      </DropdownMenu>
      <YourViewerDialog
        open={yourViewerOpen}
        onOpenChange={setYourViewerOpen}
        defaultOrigin={viewerAuth.status?.defaultOrigin ?? null}
        link={viewerAuth.status?.link ?? null}
        onSaved={() => void viewerAuth.refresh()}
      />
      <LlmCredentialDialog
        open={credentialDialogOpen}
        onOpenChange={handleCredentialDialogChange}
        credentials={credentials}
      />
      <ProjectConventionsDialog
        open={conventionsOpen}
        onOpenChange={setConventionsOpen}
      />
      <CapabilitiesDialog open={capabilitiesOpen} onOpenChange={setCapabilitiesOpen} />
      <DesignSystemsDialog
        open={designSystemsOpen}
        onOpenChange={setDesignSystemsOpen}
        invalidateManifest={invalidateManifest}
      />
      <ReferenceDirsDialog open={referenceDirsOpen} onOpenChange={setReferenceDirsOpen} />
      <ConnectViewerDialog
        open={connectViewerOpen}
        onOpenChange={setConnectViewerOpen}
        initialBaseUrl={viewerAuth.status?.baseUrl ?? null}
        // Re-probe rather than trusting the dialog's own success: the menu
        // label reads off `configured`, which is the CLI's view of the config
        // file, not the client's memory of a POST.
        onConnected={() => void viewerAuth.refresh()}
      />
      {/* No SmokeTestFailureDialog: nothing can start a smoke run from here
          while the menu item is hidden, so its failure dialog had no producer.
          Both come back together. */}
      <DesktopUpdateRestartConfirmDialog
        open={restartConfirmOpen}
        onOpenChange={setRestartConfirmOpen}
        onConfirm={() => updates?.restartAndInstall()}
      />
    </>
  )
}

/**
 * Controlled dialog hosting the {@link DesignSystemsPanel}. The panel was
 * previously a top-level right-rail tab; it now lives behind the settings gear
 * so it doesn't spend rail chrome on a surface used only during onboarding.
 * The panel triggers a node_modules scan on mount, so it only mounts while the
 * dialog is open.
 */
export function DesignSystemsDialog({
  open,
  onOpenChange,
  invalidateManifest,
}: {
  open: boolean
  onOpenChange: (next: boolean) => void
  /** See `EditorSettingsMenu`'s prop of the same name — passed straight through to the panel. */
  invalidateManifest?: (entries: Array<{ name: string; importPath?: string }>) => void
}) {
  // The panel owns whether it is listing or adding; the dialog owns the title.
  // Without this the header read "Design systems" over an add form, which is
  // the one thing a stepped flow's header is for.
  const [mode, setMode] = useState<"list" | "add">("list")
  // Adjust-during-render (React's sanctioned prop-derived-state pattern) rather
  // than an effect: the panel unmounts on close and re-reports "list" when it
  // remounts, but only after its own effect runs, which would show the add
  // title for the first frame of the next open.
  const [prevOpen, setPrevOpen] = useState(open)
  if (open !== prevOpen) {
    setPrevOpen(open)
    if (!open) setMode("list")
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="2xl"
        data-testid="design-systems-dialog"
      >
        <DialogHeader>
          <DialogTitle>
            {mode === "add" ? "Add a design system" : "Design systems"}
          </DialogTitle>
          <DialogDescription>
            {mode === "add"
              ? "It is installed and its components learned, so the agent can build with them."
              : "The component libraries the agent builds with. Adding one installs it and learns its components, so the agent uses them instead of inventing its own."}
          </DialogDescription>
        </DialogHeader>
        {/*
          Standard dialog padding, not `p-0` plus a full-bleed bordered body.
          That chrome made this the only dialog whose content sat at a
          different inset from its own header, with a rule across the middle
          that no other dialog has. The panel scrolls inside instead.
        */}
        {open ? (
          <div className="max-h-[60vh] min-h-0 overflow-y-auto">
            <DesignSystemsPanel
              invalidateManifest={invalidateManifest}
              showTitle={false}
              padded={false}
              onModeChange={setMode}
            />
          </div>
        ) : null}
        {/*
          An explicit Close. The header `X` alone is not enough: it is a 16px
          icon in a corner, it is the last thing in the reading order, and a
          modal whose only exit is a glyph reads as one you are stuck in. See
          docs/design.md § "Every modal can be dismissed".
        */}
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Close</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Controlled dialog hosting {@link ReferenceDirsPanel} — the folders outside
 * this repo that the agent may read.
 *
 * Sits beside Design systems and Extensions rather than on the right rail, for
 * the same reason both of those do: it is a setup surface, not something you
 * work in. `xl` rather than `2xl` because the body is a short list plus a
 * three-field form, not a digest.
 *
 * Mount-gated on `open` so each opening refetches. The list can go stale
 * without any action in this session: a directory the user moved on disk
 * stops resolving, and the panel should say so rather than show what was true
 * when the editor booted.
 */
export function ReferenceDirsDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="xl" data-testid="reference-dirs-dialog">
        <DialogHeader>
          <DialogTitle>Reference folders</DialogTitle>
          <DialogDescription>
            Other folders on this machine the agent may read, like a production
            repo you want this prototype to match. It can read and search them
            and never writes to them.
          </DialogDescription>
        </DialogHeader>
        {open ? (
          <div className="max-h-[60vh] min-h-0 overflow-y-auto">
            <ReferenceDirsPanel enabled={open} />
          </div>
        ) : null}
        {/*
          An explicit Close. The header `X` alone is not enough: it is a 16px
          icon in a corner, it is the last thing in the reading order, and a
          modal whose only exit is a glyph reads as one you are stuck in. See
          docs/design.md § "Every modal can be dismissed".
        */}
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Close</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Controlled dialog showing what the agent is grounded in. Handles all three
 * states inline (conventions off / nothing found / full digest) so it can be
 * opened unconditionally from the settings menu.
 */
export function ProjectConventionsDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (next: boolean) => void
}) {
  const pk = useProjectKnowledge()
  const knowledge = pk.knowledge

  // Files the agent is grounded in: SDK-native files (e.g. CLAUDE.md, loaded
  // directly by the runtime) first, then the budgeted digest files. In SDK
  // mode CLAUDE.md lives in `nativeFiles`, not `knowledge.rulesFiles`.
  const budgetedFiles = knowledge?.rulesFiles ?? []
  const followedPaths = [
    ...pk.nativeFiles,
    ...budgetedFiles.map((f) => f.path),
  ]
  // Truncation reflects only the budgeted digest — native files are loaded in
  // full and never counted toward the size budget.
  const truncated = knowledge?.truncated ?? false

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="2xl" data-testid="project-conventions-dialog">
        <DialogHeader>
          <DialogTitle>Project conventions</DialogTitle>
          {/*
            One description. The two "nothing to show" states used to render as
            body paragraphs and the truncation notice as a warning banner, which
            meant up to three separate blocks of prose explaining the same
            thing: what the agent is and isn't reading. They are all sentences
            about that, so they are sentences in one paragraph.
          */}
          <DialogDescription>
            The agent follows the conventions written down in this repo, so
            what it builds matches what is already here. Edit these files to
            change what it follows.
            {!pk.useRepoConventions ? (
              <span data-testid="conventions-off">
                {" "}
                Right now they are turned off in{" "}
                <span className="font-mono">.desde/config.json</span>, so
                edits ignore CLAUDE.md, AGENTS.md and anything similar.
              </span>
            ) : followedPaths.length === 0 ? (
              <span data-testid="conventions-empty">
                {" "}
                This repo has none yet. Add a{" "}
                <span className="font-mono">CLAUDE.md</span> (or AGENTS.md,
                .cursorrules, …) and the agent will follow it.
              </span>
            ) : truncated ? (
              <span className="text-warning" data-testid="conventions-truncated">
                {" "}
                The digest exceeded its size budget and was truncated, so the
                agent may not see every rule. Trim a rules file or move detail
                into <span className="font-mono">docs/</span>.
              </span>
            ) : null}
          </DialogDescription>
        </DialogHeader>

        {pk.useRepoConventions && followedPaths.length > 0 ? (
          <>
            {/*
              One inventory region: what the agent reads in full, what goes into
              the budgeted digest, what it can retrieve, and what config keeps
              out. Four answers to "which files count", so four rows of one
              container rather than four floating blocks.
            */}
            <div className="divide-y rounded-md border text-base">
              {pk.nativeFiles.length > 0 ? (
                <div className="p-3">
                  <h3 className="mb-1 font-normal">
                    Loaded directly by the agent
                  </h3>
                  <ul className="space-y-0.5">
                    {pk.nativeFiles.map((path) => (
                      <li key={path} className="truncate font-mono text-code-lg">
                        {path}
                      </li>
                    ))}
                  </ul>
                  <p className="mt-1 text-sm text-muted-foreground">
                    The SDK runtime reads these in full from disk, so they
                    aren&apos;t part of the size-budgeted digest below and are
                    never truncated.
                  </p>
                </div>
              ) : null}

              {budgetedFiles.length > 0 ? (
                <div className="p-3">
                  <h3 className="mb-1 font-normal">
                    Rule files ({budgetedFiles.length})
                  </h3>
                  <ul className="space-y-0.5">
                    {budgetedFiles.map((f) => (
                      <li
                        key={f.path}
                        className="flex items-center justify-between gap-4 font-mono text-code-lg"
                      >
                        <span className="truncate">{f.path}</span>
                        <span className="shrink-0 text-muted-foreground">
                          {f.chars.toLocaleString()} chars
                          {f.truncated ? " · truncated" : ""}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {knowledge && knowledge.docIndex.length > 0 ? (
                <div className="p-3">
                  <h3 className="mb-1 font-normal">
                    Docs index ({knowledge.docIndex.length}), retrieval-only
                  </h3>
                  <ul className="space-y-0.5">
                    {knowledge.docIndex.map((d) => (
                      <li
                        key={d.path}
                        className="flex items-center justify-between gap-4 text-sm"
                      >
                        <span className="truncate font-mono">{d.path}</span>
                        <span className="shrink-0 truncate text-muted-foreground">
                          {d.title}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {pk.excludeFiles.length > 0 ? (
                <p className="p-3 text-sm text-muted-foreground">
                  Excluded by config: {pk.excludeFiles.join(", ")}
                </p>
              ) : null}
            </div>

            {knowledge && knowledge.rules.trim().length > 0 ? (
              <div className="text-base">
                <h3 className="mb-1 font-normal">Digest sent to the agent</h3>
                <ScrollArea className="h-64 rounded-md border bg-muted/40">
                  <pre className="whitespace-pre-wrap p-3 text-sm">
                    {knowledge.rules}
                  </pre>
                </ScrollArea>
              </div>
            ) : null}
          </>
        ) : null}
        {/*
          An explicit Close. The header `X` alone is not enough: it is a 16px
          icon in a corner, it is the last thing in the reading order, and a
          modal whose only exit is a glyph reads as one you are stuck in. See
          docs/design.md § "Every modal can be dismissed".
        */}
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Close</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Controlled dialog hosting the {@link CapabilitiesPanel}. Mounted only while
 * open — the panel fetches on mount, and there is no reason to read config on
 * every settings-menu render.
 */
export function CapabilitiesDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (next: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="xl" data-testid="capabilities-dialog">
        <DialogHeader>
          <DialogTitle>Extensions</DialogTitle>
          {/*
            Says what these DO, not what they technically are. It read "What
            the agent can reach beyond your repo. Enabling one writes .mcp.json
            in this project, so it travels with the repo" — a sentence about
            our config file, in a dialog whose reader wants to know what the
            agent will be able to do for them. The `.mcp.json` detail is real
            but it is an implementation note, and the part worth keeping is the
            consequence: the rest of the team gets it too.
          */}
          <DialogDescription>
            Extra abilities for the agent. Turning one on applies to everyone
            working in this project.
          </DialogDescription>
        </DialogHeader>
        {open ? <CapabilitiesPanel open={open} /> : null}
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Close</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
