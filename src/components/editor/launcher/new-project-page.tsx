"use client"

import { useEffect, useRef, useState } from "react"
import { Lock } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  BusyOverlay,
  CommandChip,
  Field,
  ListFrame,
  ListFrameSearch,
  OptionCard,
  OptionCardGroup,
  Stepper,
} from "@/components/blocks"
import { AddDesignSystemDialog } from "@/components/editor/design-systems/add-design-system-dialog"
import {
  DesignSystemList,
  type DesignSystemListEntry,
} from "@/components/editor/design-systems/design-system-list"
import { OpenBlockNotice } from "./open-block-notice"
import { cn } from "@/lib/utils"
import { TONE_SURFACE } from "@/lib/tone-surface"
import type { DesignSystemDeclaration } from "@/editor/core/design-system-declarations"
import type { LauncherOpenBlock } from "@/types/launcher"
import type { DesignSystemSuggestion, GitHubReposState, InspectPathResult } from "./use-launcher-api"

export type NewProjectSource = "local" | "clone"

/**
 * Mirrors `cloneUrlFor` in `editor-cli/src/server/github-repos.ts`. Duplicated
 * rather than imported because the UI bundle cannot reach into the CLI package;
 * it is one string template, and the clone route accepts any git URL anyway.
 */
function cloneUrlFor(nameWithOwner: string): string {
  return `https://github.com/${nameWithOwner}.git`
}

/**
 * One step per stepper node, and no more.
 *
 * `local` and `clone` used to be steps of their own behind the `source` node,
 * which meant the source step's Next advanced the flow without moving the
 * progress bar. Mo, 2026-08-17: *"There shouldn't be a next in a stepper that
 * doesn't go to the next step."* That is the rule — a Next that leaves the bar
 * where it was is telling the user their progress did not count.
 *
 * So picking a source and filling that source in are ONE step: the two cards
 * sit side by side and the chosen one's form renders underneath both.
 *
 * ## This reverses an earlier split, and the reasons for that split are gone
 *
 * They shared a screen once before, and it was separated because each tile
 * revealed its own form on click, which made the tiles commit-on-click (a
 * misclick popped an OS dialog) and left the local form's Continue sitting
 * between the two tiles, belonging to neither.
 *
 * Neither survives this layout. The tiles are `OptionCard` radios now, not
 * commit-on-click `ChoiceTile`s, so selecting is not committing — that is
 * exactly the distinction `docs/design.md` §1b draws. And the submit lives in
 * the page's full-bleed footer bar, below everything, so it cannot sit between
 * anything.
 */
type DialogStep = "source" | "name" | "design-systems"

/**
 * The progress bar's nodes, one per `DialogStep` and in the same order.
 *
 * They are 1:1 on purpose — see the `DialogStep` doc above. It was four nodes
 * against six states until 2026-08-17, which is exactly the shape that let a
 * Next fire without the bar moving.
 *
 * Reference folders left the wizard 2026-08-31 (Mo's call: keep creation
 * simple). The functionality lives on in the prototype's settings — the
 * launcher's per-prototype settings page and the in-editor settings menu both
 * carry a Reference folders section.
 */
const STEPPER_STEPS = [
  { id: "source", label: "Source" },
  { id: "name", label: "Name" },
  { id: "design-systems", label: "Design system" },
] as const

/** The sub-header for each step. The h1 above it never changes. */
const STEP_TITLE: Record<DialogStep, string> = {
  source: "Choose a source",
  name: "Name your project",
  "design-systems": "Add a design system",
}

/**
 * Steps the user can skip entirely. Rendered as "(optional)" beside the title
 * rather than as a leading "Optional:" in the prose, which is where it was and
 * where a skimmer misses it.
 */
const OPTIONAL_STEPS = new Set<DialogStep>(["design-systems"])

/**
 * Why this step exists, in the user's terms. Never names the product, and
 * never says "manifests" — that is our word for the artifact, not the reason
 * anyone would care about it.
 */
const STEP_DESCRIPTION: Record<DialogStep, string> = {
  source:
    "Open a prototype repository, from a folder on this machine or by cloning one.",
  name: "Configuration is stored in the repo at .desde/config.json",
  "design-systems":
    "Name the design systems this prototype uses. They are set up the next time this project boots, so the agent can build with their components instead of inventing its own.",
}

// No `stepperNodeFor` any more: every DialogStep IS a stepper node, which is
// the whole point of collapsing the source sub-steps. If a mapping function
// ever comes back here, that is the signal a step stopped matching a node.

interface NewProjectPageProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Which source form to show initially (empty-state tiles deep-link here). */
  initialSource?: NewProjectSource | null
  /** Native OS picker availability (from the launcher bootstrap). */
  folderPickerSupported: boolean
  busy: boolean
  /** Last action error — surfaced inline so it's visible over the page. */
  error?: string | null
  /**
   * The structured "cannot open this project" refusal, when the last resolved
   * path had one. Rendered in place of advancing to the naming step.
   */
  openBlock?: LauncherOpenBlock | null
  /**
   * Can this path be opened? Read-only on the server, and asked the moment a
   * path resolves rather than at the end.
   *
   * The steps between here and `onOpenPath` WRITE to the user's repo — the
   * name step mints `.desde/config.json`, the design-system step appends
   * `designSystems` declarations — so refusing at the end would mean editing a
   * repo we then decline to open. Resolves the refusal, or null.
   */
  onInspectPath: (path: string) => Promise<InspectPathResult>
  /**
   * Resolve a folder WITHOUT opening it — the dialog needs the path first
   * so it can offer the design-system step before any editor spawns.
   * `supported: false` → no native picker; caller falls back to the manual
   * path form. No `path` with `supported: true` → the user canceled.
   */
  onPickFolder: () => Promise<{ supported: boolean; path?: string }>
  /** Boot a editor on `path` and navigate to it — the dialog's final step (Skip / Add & open). */
  onOpenPath: (path: string) => Promise<void>
  /**
   * Persist the project's name into `<path>/.desde/config.json`, minting
   * its embedded identity. Runs before `onOpenPath` so the editor boots with
   * an identity already on disk rather than racing to mint one.
   */
  onSetProjectName: (path: string, name: string) => Promise<{ ok: boolean; reason?: string }>
  /** Clone `repoUrl` WITHOUT opening it — resolves the checkout path for the design-system step. */
  onClone: (repoUrl: string) => Promise<{ path?: string }>
  /**
   * The developer's GitHub repos via their own `gh` login. Optional: hosts
   * without it (and the colocated tests) simply get the URL field.
   */
  onListGitHubRepos?: () => Promise<GitHubReposState>
  /** Read-only scan for design systems `path` already depends on + imports. */
  onSuggestDesignSystems: (path: string) => Promise<DesignSystemSuggestion[]>
  /** Persist the accumulated declarations to `path`'s config (no cloning/installing here). */
  onDeclareDesignSystems: (
    path: string,
    declarations: DesignSystemDeclaration[],
  ) => Promise<{ ok: true } | { ok: false; reason: string }>
}

/**
 * Local mirror of `declarationIdentity`
 * (`src/editor/core/design-system-declarations.ts`) — duplicated rather
 * than imported because that module reads/writes the config file with
 * `node:fs/promises` at module scope, which the browser UI bundle can't
 * resolve. Keep this in sync if the core identity rule changes; it only
 * needs to distinguish pending chips in this dialog, not match the
 * server's dedupe exactly (the server re-validates on declare regardless).
 * Exported so a test can assert parity against `declarationIdentity`
 * directly (tests run in Node, where importing the fs-using core module is
 * safe — see `new-project-page.test.tsx`).
 */
export function pendingIdentity(source: DesignSystemDeclaration["source"]): string {
  if (source.kind === "installed") return source.package.trim()
  if (source.kind === "npm") return packageNameFromSpec(source.spec.trim())
  return `repo:${source.url.trim()}|${(source.ref ?? "").trim()}|${(source.subdir ?? "").trim()}`
}

function packageNameFromSpec(spec: string): string {
  if (spec.startsWith("@")) {
    const secondAt = spec.indexOf("@", 1)
    return secondAt === -1 ? spec : spec.slice(0, secondAt)
  }
  const at = spec.indexOf("@")
  return at === -1 ? spec : spec.slice(0, at)
}

function pendingLabel(decl: DesignSystemDeclaration): string {
  const { source } = decl
  if (source.kind === "installed") return source.package
  if (source.kind === "npm") return source.spec
  return source.ref ? `${source.url}#${source.ref}` : source.url
}

/**
 * New Project — choose a source (local folder via the OS picker, or a git
 * clone), then optionally declare design systems before booting a editor
 * on it. Mirrors Desde-original's create-project dialog structure; the
 * local-path text input only appears as a fallback on platforms without a
 * native picker.
 *
 * Two-step flow (Phase 3 attach/refresh, task 4): step 1 resolves a path
 * (pick / manual entry / clone) WITHOUT spawning a editor; step 2 offers
 * "Add a design system" fed by the suggest route, accumulating a local
 * `pending` list of declarations. Footer: Skip spawns immediately with no
 * declarations; Add & open declares the pending list first (boot
 * reconciliation does the actual clone/install later) and only opens on a
 * successful declare.
 */
export function NewProjectPage({
  open,
  onOpenChange,
  initialSource = null,
  folderPickerSupported,
  busy,
  error = null,
  openBlock = null,
  onInspectPath,
  onPickFolder,
  onOpenPath,
  onSetProjectName,
  onClone,
  onListGitHubRepos,
  onSuggestDesignSystems,
  onDeclareDesignSystems,
}: NewProjectPageProps) {
  const [source, setSource] = useState<NewProjectSource | null>(initialSource)
  const [repoUrl, setRepoUrl] = useState("")
  const [manualPath, setManualPath] = useState("")
  // Shows the manual-path fallback after the server reports no native picker.
  const [needManualPath, setNeedManualPath] = useState(!folderPickerSupported)
  /**
   * The last path check that did not complete, shown as a banner on the step
   * that asked. Separate from the `error` PROP, which is the parent's
   * last-action error for the flow as a whole.
   */
  const [pathError, setPathError] = useState<string | null>(null)

  // Always `source`. A deep link no longer picks a STEP, it preselects a
  // card (`source` state, seeded from `initialSource`), because picking the
  // source and filling it in are one step now.
  const [step, setStep] = useState<DialogStep>("source")
  const [chosenPath, setChosenPath] = useState<string | null>(null)
  const [projectName, setProjectName] = useState("")
  const [pending, setPending] = useState<DesignSystemDeclaration[]>([])
  const [addDialogOpen, setAddDialogOpen] = useState(false)
  /** Non-null while the add dialog is editing an existing row. */
  const [editingDeclaration, setEditingDeclaration] = useState<DesignSystemDeclaration | null>(null)
  const [suggestLoading, setSuggestLoading] = useState(false)
  const [declaring, setDeclaring] = useState(false)
  // GitHub browsing. `null` = not asked yet; the load is lazy because it
  // shells out to `gh` and most opens never reach the clone step.
  const [repos, setRepos] = useState<GitHubReposState | null>(null)
  const [repoFilter, setRepoFilter] = useState("")
  /**
   * Which way of naming a repo is on screen. `null` = the user has not picked a
   * tab, so the default is derived (see `activeCloneTab`) rather than pinned.
   *
   * The tabs only exist once `gh` has answered, and that answer lands after the
   * step is already interactive. Pinning "repos" at mount would yank a
   * half-typed URL off screen the moment the list arrived.
   */
  const [cloneTab, setCloneTab] = useState<"repos" | "url" | null>(null)
  /** "We have already shelled out" — see the effect below for why it's a ref. */
  const askedGitHubRef = useRef(false)
  /**
   * Bumped by `reset()`. A `gh` answer is applied only if the generation it
   * started in is still current, which is what keeps a result from a previous
   * open off a fresh one — see the effect below for why this replaced a
   * cleanup-based cancel.
   */
  const ghGenerationRef = useRef(0)
  /** An inspect is in flight, so the step's controls are busy. */
  const [checking, setChecking] = useState(false)

  const reset = () => {
    setSource(initialSource)
    setRepoUrl("")
    setManualPath("")
    setNeedManualPath(!folderPickerSupported)
    setPathError(null)
    // Invalidate any `gh` answer still in flight from the previous open.
    ghGenerationRef.current += 1
    // A deep link answers the source question by preselecting its card; the
    // step is the same either way.
    setStep("source")
    setChosenPath(null)
    setProjectName("")
    setPending([])
    setSuggestLoading(false)
    setDeclaring(false)
    // Cleared, not kept: the user may have run `gh auth login` since, and one
    // sub-second shell-out per dialog open is cheaper than showing them a
    // stale "not logged in" for the life of the page.
    setRepos(null)
    setRepoFilter("")
    setCloneTab(null)
    askedGitHubRef.current = false
    setChecking(false)
  }

  /**
   * Every open starts clean, and the reset happens on the way IN rather than
   * only on the way out.
   *
   * Closing does not always come through `handleOpenChange`: `LauncherPage`
   * flips `open` to false itself before spawning the editor
   * ([launcher-page.tsx](src/editor-ui/launcher-page.tsx)'s `handoffToLoader`),
   * so a failed spawn used to reopen the dialog on the previous run's path,
   * repo URL and repo list — and `askedGitHubRef` made that list impossible to
   * refresh, because "we already shelled out" was still true from last time.
   *
   * Adjust-during-render is React's sanctioned pattern for deriving state from
   * a changing prop.
   */
  const [prevOpen, setPrevOpen] = useState(open)
  if (open !== prevOpen) {
    setPrevOpen(open)
    if (open) reset()
  }

  const handleOpenChange = (next: boolean) => {
    if (!next) reset()
    onOpenChange(next)
  }

  /**
   * Step 2 — name. Prefilled from the directory's trailing segment, which is
   * almost always what the user would type anyway, so the common path is one
   * Enter press. Naming here rather than after opening means the identity is
   * on disk before the editor boots.
   */
  const enterNameStep = (path: string) => {
    setChosenPath(path)
    setPending([])
    setProjectName(path.split("/").filter(Boolean).pop() ?? "")
    setStep("name")
  }

  /**
   * The gate every resolved path passes through: pick, manual entry, clone.
   *
   * A blocked path stays on the source step, where the notice renders above
   * the two tiles, so the next action is picking a different folder rather
   * than backing out of a flow. Nothing has been written to the repo at this
   * point, which is the reason the check happens here and not at `open`.
   */
  const advanceFromPath = async (path: string) => {
    setChecking(true)
    const result = await onInspectPath(path)
    setChecking(false)
    // EITHER outcome stops the flow. A failed check used to return a bare
    // `null`, which read as "nothing blocking it", so a bad path advanced to
    // the name step and reported "Not a directory: …" there — on a step that
    // had not asked for a path.
    setPathError(result.error)
    if (result.block || result.error) return
    enterNameStep(path)
  }

  // Load suggestions once the dialog lands on step 2 for a resolved path.
  useEffect(() => {
    if (step !== "design-systems" || !chosenPath) return
    let cancelled = false
    setSuggestLoading(true)
    void onSuggestDesignSystems(chosenPath).then((result) => {
      if (cancelled) return
      setSuggestLoading(false)
      // Seed the list with what is already installed but unregistered, per the
      // brief. Merged rather than assigned: a user who typed one in while the
      // scan was still running must not lose it. Deduped on the same identity
      // the list keys on, so a package that is BOTH detected and typed appears
      // once.
      setPending((prev) => {
        const seen = new Set(prev.map((d) => pendingIdentity(d.source)))
        const seeded = result
          .map((s): DesignSystemDeclaration => ({
            source: { kind: "installed", package: s.package },
          }))
          .filter((d) => !seen.has(pendingIdentity(d.source)))
        return seeded.length === 0 ? prev : [...prev, ...seeded]
      })
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onSuggestDesignSystems is a stable useCallback from the hook
  }, [step, chosenPath])

  /**
   * Browse fills the path field; it does not advance on its own.
   *
   * Previously picking a folder jumped straight to the name step, so the path
   * you chose was never shown back to you before it was used. Now the picker
   * writes into the field and Continue is a separate, deliberate press.
   */
  const handleBrowse = async () => {
    const result = await onPickFolder()
    if (!result.supported) {
      // Server says no native picker on this platform. The field is already
      // there and typeable; just stop offering a button that cannot work.
      setNeedManualPath(true)
      return
    }
    if (result.path) setManualPath(result.path)
    // else: the user canceled the native picker, leaving the field as it was.
  }

  /**
   * Ask `gh` once per open, and only once the clone step is actually showing.
   *
   * The guard is a ref set BEFORE the call, not `repos !== null`, because the
   * result does not exist until the shell-out resolves. `onListGitHubRepos` is
   * a caller-owned callback with no memoization contract, so a parent that
   * re-renders while the promise is in flight hands us a new identity, re-runs
   * this effect, and starts another `gh` — which re-renders the parent again.
   * That is not hypothetical: the gallery fixture logs each call, and logging
   * re-renders the host, so it spun until React's update-depth limit tripped.
   *
   * `open` is a dependency even though the body ignores it, because the dialog
   * does NOT unmount when it closes. Deep-linked to the clone step
   * (`initialSource="clone"`), `step` is the same string before and after a
   * close/reopen, so keying on `step` alone meant the effect never re-ran: the
   * reset cleared `repos` and nothing refilled it, and an in-flight promise
   * from the previous open landed on the new one. Depending on `open` gives
   * every open its own run and cancels the last one's.
   */
  useEffect(() => {
    // Keyed on the clone CARD, not a clone step: the fetch should start when
    // the user asks for GitHub, and after the merge that is a selection rather
    // than a navigation.
    if (!open || source !== "clone" || askedGitHubRef.current || !onListGitHubRepos) return
    askedGitHubRef.current = true
    // Staleness is decided by the OPEN GENERATION, not by whether the user is
    // still looking at the clone card.
    //
    // This used to cancel on cleanup, which `source` now fires on every card
    // click. MEASURED: click Clone, click Local before `gh` answers, click
    // Clone again — the result was discarded, `askedGitHubRef` is only cleared
    // by `reset()` on an open false->true transition, so the effect
    // early-returned and the list sat on "Looking for repositories" for
    // the rest of that page open. The collapse to one step made that a single
    // radio click; before it, it took Next then Back.
    //
    // Letting a late answer land is correct: the user asked for it, and the
    // only result that must NOT land is one from a PREVIOUS open, which the
    // generation bump in `reset()` already rules out.
    const generation = ghGenerationRef.current
    void onListGitHubRepos().then((result) => {
      if (ghGenerationRef.current === generation) setRepos(result)
    })
    // `source`, not `step`: the guard above now keys on the clone CARD, and
    // leaving `step` here meant the effect never re-ran when the card was
    // picked, so the repo list stayed empty until some unrelated step change
    // happened to retrigger it.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onListGitHubRepos is caller-owned and unmemoized; the ref above is the real guard
  }, [source, open])

  const handleCloneSubmit = async () => {
    const url = repoUrl.trim()
    if (!url) return
    const result = await onClone(url)
    if (result.path) await advanceFromPath(result.path)
  }

  const addPending = (decl: DesignSystemDeclaration) => {
    const id = pendingIdentity(decl.source)
    setPending((prev) => (prev.some((p) => pendingIdentity(p.source) === id) ? prev : [...prev, decl]))
  }

  const removePending = (id: string) => {
    setPending((prev) => prev.filter((p) => pendingIdentity(p.source) !== id))
  }

  /** Persist the name, then open. A failed name write blocks the open — the
   *  project would otherwise boot without the identity the user just chose. */
  const persistNameThenOpen = async (path: string): Promise<void> => {
    const result = await onSetProjectName(path, projectName.trim())
    if (!result.ok) return
    await onOpenPath(path)
  }

  /**
   * The single commit point for the whole wizard: write whatever the user
   * accumulated on the optional design-system step, then open.
   *
   * The declare runs before the open and a failure blocks it, because a
   * project that boots without the grounding the user just asked for looks
   * like the request was ignored.
   *
   * This replaced a Skip / "Add & open" pair per step. With the pending items
   * visible as chips, the two buttons did the same thing whenever nothing was
   * pending, and "Skip" silently discarded a list the user had just built.
   */
  const handleFinish = async () => {
    if (!chosenPath) return
    if (pending.length > 0) {
      setDeclaring(true)
      try {
        const result = await onDeclareDesignSystems(chosenPath, pending)
        if (!result.ok) return // error surfaces via the `error` prop; do not open.
        // Cleared on success so a retry after a LATER failure (the name
        // write, the open) does not resend what is already in the config and
        // collide with itself. Without this the only way forward was to
        // remove every chip by hand.
        setPending([])
      } finally {
        setDeclaring(false)
      }
    }
    await persistNameThenOpen(chosenPath)
  }

  const repoQuery = repoFilter.trim().toLowerCase()
  const hasRepos = repos?.available === true && repos.repos.length > 0
  const visibleRepos =
    repos?.available === true
      ? repos.repos.filter(
          (repo) => !repoQuery || repo.nameWithOwner.toLowerCase().includes(repoQuery),
        )
      : []

  /**
   * The hint under the URL field doubles as where GitHub browsing explains
   * itself. `gh` missing, or present but logged out, is not an error: it is the
   * ordinary state of a machine that has never used it, so it gets one quiet
   * line naming the command that changes it rather than an alert.
   */
  const repoFieldHint =
    repos && !repos.available && repos.reason !== "failed" ? (
      <>
        {repos.reason === "not-installed" ? "Install the GitHub CLI and run " : "Run "}
        {/*
          A `CommandChip`, not a bare `<code>`: this is something the user has
          to reproduce exactly in a terminal, and selecting it by hand is a
          careful drag because a double-click stops at the first space.
        */}
        <CommandChip command="gh auth login" /> to pick from your repositories
        here.
      </>
    ) : (
      "Cloned with the git credentials already on this machine."
    )

  /**
   * The declared design systems as list rows.
   *
   * `detected` is derived from the SOURCE KIND, not from membership of the
   * suggestions array. A suggestion that has been seeded is indistinguishable
   * from one typed as `installed`, and `kind` is the thing that actually says
   * whether there are editable fields behind the row.
   */
  const designSystemEntries: DesignSystemListEntry[] = pending.map((declaration) => ({
    id: pendingIdentity(declaration.source),
    label: pendingLabel(declaration),
    detected: declaration.source.kind === "installed",
    declaration,
  }))

  const stepBusy = busy || declaring || checking

  /**
   * What the wait is FOR, for the overlay's label.
   *
   * `stepBusy` is three different waits sharing one boolean, and a bare
   * spinner over a dialog that just refused to advance is the same
   * "something is happening" the user could already infer. Naming it is the
   * difference between a spinner and progress.
   *
   * Order matches the order they can overlap in: a folder is checked before
   * design systems are declared, and `busy` is the outer open/clone.
   */
  const busyLabel = checking
    ? "Checking the folder"
    : declaring
      ? "Setting up design systems"
      : "Opening"

  /**
   * `gh` has been asked and has not answered yet.
   *
   * This is what removes the flash. The answer takes a shell-out (two, in the
   * signed-in case), and until it lands we do not know whether this step is a
   * list plus a URL box or a URL box on its own. Rendering the bare URL box in
   * the meantime meant every signed-in user watched the wrong control appear
   * and then get replaced by the right one.
   *
   * Gated on the callback existing, not just on `repos` being null: a host that
   * never offers GitHub browsing has nothing pending and must render its URL
   * field immediately.
   */
  const reposPending = !!onListGitHubRepos && repos === null

  /**
   * Before the user touches a tab, a URL already in the box means they were
   * typing one while `gh` was still answering, so that is the tab to land on.
   * Picking a row pins "repos" explicitly, so filling the URL that way does not
   * bounce them to the other tab.
   */
  const activeCloneTab = cloneTab ?? (repoUrl.trim() ? "url" : "repos")

  /**
   * One field, rendered either inside the URL tab or on its own when there is
   * no list to tab between. `autoFocus` differs: landing on the tab should put
   * the caret in the box, but the tabless case only takes focus when nothing
   * else has claimed it.
   */
  const repoUrlField = (
    <Field label="Repository URL" htmlFor="new-project-repo-url" hint={repoFieldHint}>
      <Input
        id="new-project-repo-url"
        value={repoUrl}
        onChange={(e) => setRepoUrl(e.target.value)}
        placeholder="https://github.com/owner/repo.git"
        spellCheck={false}
        disabled={stepBusy}
        autoFocus
      />
    </Field>
  )

  const repoListPanel = (
    /*
      The filter is the list's FIRST ROW, sharing the frame's border and
      dividers — the same shape as the Comments panel's search. It stays
      mounted through all three states below (`ListFrameSearch` documents
      why), and it is deliberately NOT disabled while pending: a filter typed
      early applies the moment the repos arrive.
    */
    <ListFrame>
      <ListFrameSearch
        value={repoFilter}
        onValueChange={setRepoFilter}
        placeholder="Filter repositories"
        aria-label="Filter repositories"
        disabled={stepBusy}
        data-testid="new-project-repo-filter"
        autoFocus
      />
      {reposPending ? (
        <p
          className="px-3 py-2 text-sm text-muted-foreground"
          data-testid="new-project-repo-loading"
        >
          Looking for repositories
        </p>
      ) : visibleRepos.length > 0 ? (
        <OptionCardGroup
          value={repoUrl}
          onValueChange={(next) => {
            setRepoUrl(next)
            // Pins the tab, so the derived default above cannot read this
            // freshly-filled URL as "they were typing one".
            setCloneTab("repos")
          }}
          aria-label="Your GitHub repositories"
          // No `max-h` / `overflow-y-auto`. In a 36rem dialog the list had to
          // scroll inside itself or it pushed the footer off; on a page with a
          // sticky action bar the PAGE scrolls, and a scroll region nested in a
          // scrolling page gives the user two scrollbars and a list that stops
          // moving when the wrapper ends.
        >
          {visibleRepos.map((repo) => (
            <OptionCard
              key={repo.nameWithOwner}
              value={cloneUrlFor(repo.nameWithOwner)}
              // One line per repo, so the list reads as a list. The lock
              // marks the private ones; "Public" on its own line for
              // everything else was a second row of nothing.
              title={
                <span className="flex items-center gap-1.5">
                  <span className="truncate">{repo.nameWithOwner}</span>
                  {repo.isPrivate ? (
                    <Lock className="size-3 shrink-0 text-muted-foreground" aria-label="Private" />
                  ) : null}
                </span>
              }
              disabled={stepBusy}
              data-testid={`new-project-repo-${repo.nameWithOwner}`}
            />
          ))}
        </OptionCardGroup>
      ) : (
        <p className="px-3 py-2 text-sm text-muted-foreground">
          No repositories match that filter.
        </p>
      )}
    </ListFrame>
  )

  if (!open) return null

  return (
    // `relative` and `flex-1` on the WRAPPER, not on <main>: the action bar has
    // to escape main's narrow column to be full-bleed, and the busy scrim has
    // to cover both. A positioned ancestor spanning the pair is the only way
    // to get both without the scrim leaving the bar live underneath it.
    <div className="relative flex flex-1 flex-col" data-testid="new-project-page">
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-5 px-6 py-8">
      <div className="flex flex-col gap-4">
        {/*
          Three levels, and the split is the point (Mo, 2026-08-17):
          flow name -> where you are -> what THIS step is -> why.

            <h1>      "New project" — never changes. It is what reminds you
                                       which flow you are in.
            <Stepper>                 — which of its steps you are on.
            <h2>      the step title — changes, and sits BELOW the thing that
                                       says which step it is.
            <p>       the step copy  — conditional on the step, so under it.

          The h1 used to BE the step title, which meant the one element that
          should have been an anchor was the one changing under you, and the
          stepper had a heading above it that already contradicted it.

          The general rule this follows: an element conditional on another one
          belongs underneath it.
        */}
        <h1 className="text-xl font-medium">New project</h1>
        <Stepper
          steps={STEPPER_STEPS}
          current={step}
          aria-label="New project progress"
        />
        <div className="flex flex-col gap-1">
          <h2 className="text-base font-medium">
            {STEP_TITLE[step]}
            {/*
              "(optional)" belongs on the TITLE, not buried in the first word
              of the description. It is the thing that decides whether you read
              the rest of the step at all, and both these steps used to open
              with a literal "Optional:" that a skimmer would miss.
            */}
            {OPTIONAL_STEPS.has(step) ? (
              <span className="ml-1.5 font-normal text-muted-foreground">
                (optional)
              </span>
            ) : null}
          </h2>
          <p className="text-base text-muted-foreground">{STEP_DESCRIPTION[step]}</p>
        </div>
      </div>

        {/*
          Only reachable on `source`, which is now the one step that resolves a
          path: the page hands a block down when a previous open failed, and
          `advanceFromPath` raises one when Continue inspects a typed path.
          Past this step the inspect has already passed, so there is nothing
          left to refuse.
        */}
        {openBlock && step === "source" ? (
          <OpenBlockNotice block={openBlock} />
        ) : null}

        {/*
          Failures get a banner, not a clause appended to the description.
          `pathError` is a check that did not complete on THIS step; `error` is
          the parent's last-action error. Both are post-action failures on a
          page whose heading is about something else, which is the banner case
          in docs/design.md § "Where an error goes".

          It renders under the stepper and above the form, so it is between the
          thing that failed and the controls you would retry with. The same
          `TONE_SURFACE.destructive` recipe `DialogCopy` uses — that helper is
          dialog-only, and a primitive reaching up for the `Callout` block would
          invert the layering.
        */}
        {pathError || error ? (
          <div
            role="alert"
            data-testid="new-project-error"
            className={cn(
              "rounded-md border p-3 text-base",
              TONE_SURFACE.destructive,
            )}
          >
            {pathError ?? error}
          </div>
        ) : null}

        {step === "source" ? (
          <div className="flex flex-col gap-4">
            {/*
              Side by side: the layout classes stay at the call site, and
              `separate` swaps the fused block for detached bordered cards —
              fused chrome assumes a stack, and rendered in a row it dropped
              the second card's top border and every gap (measured 2026-08-31).

              Two options, short hints, and a page's worth of width: reading
              across is one eye movement here, and it keeps the chosen source's
              form directly under both cards instead of pushing it a screen
              down.
            */}
            <OptionCardGroup
              value={source ?? undefined}
              onValueChange={(next) => setSource(next as NewProjectSource)}
              aria-label="How to open a prototype"
              separate
              className="grid grid-cols-1 sm:grid-cols-2"
            >
              <OptionCard
                value="local"
                title="Open a local folder"
                hint="A repo already on this machine."
                disabled={stepBusy}
                data-testid="new-project-local"
              />
              <OptionCard
                value="clone"
                title="Clone from GitHub"
                hint="Clone a Github repository."
                disabled={stepBusy}
                data-testid="new-project-clone"
              />
            </OptionCardGroup>

            {/*
              The chosen source's inputs, under BOTH cards rather than inside
              one. Inside a card the form would move when the selection did,
              and the card would grow into a panel; under both, the cards stay
              a stable two-up row and the form is plainly the next thing to do.

              Nothing renders until a source is picked, so the step opens as
              one question rather than a question plus a half-filled form.
            */}
            {source === "local" ? (
            <form
              className="flex flex-col gap-3"
              data-testid="new-project-local-step"
            onSubmit={(e) => {
              e.preventDefault()
              if (manualPath.trim()) void advanceFromPath(manualPath.trim())
            }}
          >
            <div className="flex items-end gap-2">
              <Field label="Folder path" htmlFor="new-project-path" className="flex-1">
                <Input
                  id="new-project-path"
                  value={manualPath}
                  onChange={(e) => setManualPath(e.target.value)}
                  placeholder="/path/to/your/repo"
                  spellCheck={false}
                  disabled={stepBusy}
                  autoFocus
                />
              </Field>
              {/*
                Hidden rather than disabled where the platform has no native
                picker: a permanently dead button is worse than no button, and
                the field beside it already accepts a typed path. macOS has one
                today (folder-picker.ts); Linux and Windows report unsupported.
              */}
              {needManualPath ? null : (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void handleBrowse()}
                  disabled={stepBusy}
                  data-testid="new-project-browse"
                >
                  Browse…
                </Button>
              )}
            </div>
          </form>
            ) : null}
            {source === "clone" ? (
            <form
              className="flex flex-col gap-3"
              data-testid="new-project-clone-step"
            onSubmit={(e) => {
              e.preventDefault()
              void handleCloneSubmit()
            }}
          >
            {/*
              Two ways in, one at a time. They used to stack: the list scrolled
              inside the dialog and the URL field sat under it, so the step was
              three blocks tall and everyone who came to pick from the list
              still had a half-filled form parked below it.

              Either way still writes the same `repoUrl`, so there is one value
              and one Clone button no matter which tab you got there from. A row
              picked on one tab shows up prefilled on the other.
            */}
            {hasRepos || reposPending ? (
              <Tabs
                value={activeCloneTab}
                onValueChange={(next) => setCloneTab(next as "repos" | "url")}
              >
                {/*
                  The strip sits tighter to its panel than to the description
                  above it otherwise, which reads as the tabs belonging to the
                  header rather than to what they switch. `Tabs` contributes
                  `gap-2` on its own, so this is on top of that.
                */}
                <TabsList aria-label="How to choose a repository" className="mb-2">
                  <TabsTrigger value="repos" data-testid="new-project-tab-repos">
                    Your repositories
                  </TabsTrigger>
                  <TabsTrigger value="url" data-testid="new-project-tab-url">
                    Paste a URL
                  </TabsTrigger>
                </TabsList>
                <TabsContent value="repos">{repoListPanel}</TabsContent>
                <TabsContent value="url">{repoUrlField}</TabsContent>
              </Tabs>
            ) : (
              repoUrlField
            )}
          </form>
            ) : null}
          </div>
        ) : step === "name" ? (
          <form
            className="flex flex-col gap-3"
            data-testid="new-project-name-step"
            onSubmit={(e) => {
              e.preventDefault()
              if (projectName.trim()) setStep("design-systems")
            }}
          >
            <Field label="Project name" htmlFor="new-project-name">
              <Input
                id="new-project-name"
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
                placeholder="My prototype"
                disabled={stepBusy}
                autoFocus
              />
            </Field>
            {chosenPath ? (
              <p
                dir="rtl"
                className="truncate text-left text-xs text-muted-foreground"
                title={chosenPath}
              >
                {"\u200e" + chosenPath}
              </p>
            ) : null}
          </form>
        ) : (
          <div
            className="flex flex-col gap-3"
            data-testid="new-project-design-systems-step"
          >
            {/*
              A LIST with an Add button under it, not chips plus a permanent
              inline form (Mo, 2026-08-17). The tinted `bg-muted/40` ground went
              with the inline form: it existed to say "sub-task" when the add
              flow had its own action row sitting a few pixels from the page's.
              The add flow is a modal now, so there is no second action row to
              tell apart and nothing left for the tint to disambiguate.
            */}
            <DesignSystemList
              entries={designSystemEntries}
              loading={suggestLoading}
              busy={stepBusy}
              onAdd={() => {
                setEditingDeclaration(null)
                setAddDialogOpen(true)
              }}
              onEdit={(entry) => {
                setEditingDeclaration(entry.declaration)
                setAddDialogOpen(true)
              }}
              onRemove={removePending}
            />
          </div>
        )}

      </main>

      {/*
        The action bar mirrors the top nav: the BAR is full-bleed, because its
        border and its ground have to reach both window edges, and its CONTENTS
        ride the same `mx-auto max-w-2xl px-6` column <main> uses above. Those
        column classes are duplicated on purpose and are coupled to main's —
        change one and change the other, or the buttons stop lining up with the
        form.

        `sticky bottom-0` so the actions stay reachable on the long steps. The
        clone step lists every repo the user has; without this, Clone sits below
        the fold on any account with more than a handful.
      */}
      <footer className="sticky bottom-0 z-40 shrink-0 border-t bg-background">
        <div className="mx-auto flex w-full max-w-2xl items-center justify-end gap-2 px-6 py-3">
          {step === "source" ? (
            <>
              <Button
                variant="ghost"
                onClick={() => handleOpenChange(false)}
                disabled={stepBusy}
              >
                Cancel
              </Button>
              {/*
                One button, and it does the work of the step rather than
                advancing to a screen that does. There is no "Next" here any
                more: a Next that leaves the progress bar where it was is
                telling the user their progress did not count.

                It stays DISABLED until a source is picked and that source's
                field has a value, so it never looks like the way forward
                before it is.
              */}
              {source === "clone" ? (
                <Button
                  onClick={() => void handleCloneSubmit()}
                  disabled={stepBusy || !repoUrl.trim()}
                  data-testid="new-project-clone-submit"
                >
                  {stepBusy ? "Cloning…" : "Clone"}
                </Button>
              ) : (
                <Button
                  // Through the inspect gate, same as the form's own submit.
                  // The footer button is the path almost everyone takes; only
                  // pressing Enter in the field goes through onSubmit, so
                  // routing one and not the other would leave the check
                  // mostly unrun.
                  onClick={() => manualPath.trim() && void advanceFromPath(manualPath.trim())}
                  disabled={stepBusy || !source || !manualPath.trim()}
                  data-testid="new-project-local-continue"
                >
                  Continue
                </Button>
              )}
            </>
          ) : step === "name" ? (
            <>
              <Button
                variant="ghost"
                // Back goes to the previous NODE, which is the whole source
                // step now: there is no separate local/clone screen behind it.
                onClick={() => setStep("source")}
                disabled={stepBusy}
              >
                Back
              </Button>
              <Button
                onClick={() => setStep("design-systems")}
                disabled={stepBusy || !projectName.trim()}
                data-testid="new-project-name-continue"
              >
                Continue
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="ghost"
                onClick={() => setStep("name")}
                disabled={stepBusy}
                data-testid="new-project-back"
              >
                Back
              </Button>
              <Button
                onClick={() => void handleFinish()}
                disabled={stepBusy}
                data-testid="new-project-open"
              >
                {stepBusy ? "Opening" : "Open project"}
              </Button>
            </>
          )}
        </div>
      </footer>

      {/*
        `z-50`, overriding BusyOverlay's own `z-10`. Being the last child is NOT
        enough here: the footer is `sticky z-40`, and a positioned sibling with
        a higher z-index paints above a later one whatever the document order.
        MEASURED before the fix — `document.elementFromPoint` at the footer's
        centre returned the footer, so the scrim covered the form and left the
        action bar bright underneath it.

        The buttons carry their own `disabled` regardless: this is a paint, not
        a focus trap, so without that they stay tabbable behind the scrim.

        `absolute inset-0` needs a positioned ancestor, which is the wrapper
        above. In the dialog it came free from `DialogContent`'s `fixed`.
      */}
      {stepBusy ? (
        <BusyOverlay label={busyLabel} className="z-50 rounded-none" />
      ) : null}

      <AddDesignSystemDialog
        open={addDialogOpen}
        onOpenChange={setAddDialogOpen}
        initial={editingDeclaration}
        busy={stepBusy}
        onSubmit={(declaration) => {
          // Editing replaces in place: the identity is derived from the source,
          // so a changed spec mints a new id and the old row would otherwise
          // survive beside its own replacement.
          if (editingDeclaration) removePending(pendingIdentity(editingDeclaration.source))
          addPending(declaration)
          return true
        }}
      />
    </div>
  )
}
