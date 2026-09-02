"use client"

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react"
import { RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { DialogFooter } from "@/components/ui/dialog"
import { Switch } from "@/components/ui/switch"
import {
  Callout,
  EmptyState,
  Field,
  OptionCard,
  OptionCardGroup,
  ProjectLoader,
} from "@/components/blocks"
import { cn } from "@/lib/utils"
import { LoadFailure } from "./load-failure"
import { GithubAppUnreachableBanner } from "./github-app-unreachable-banner"
import { failureMessage, fetchJson } from "./api-client"
import {
  accessFlowDestination,
  clearGithubCheckMarker,
  decideAccessFlowCheck,
  githubAccessFlowHref,
  githubCheckInstallationId,
  isGithubCheckReturn,
} from "./github-access-flow"
import { useCurrentUser } from "./use-current-user"
import { canManageProjects } from "./instance-role"
import {
  buildFieldsAreValid,
  buildFieldsEqual,
  buildFieldsFromConfig,
  buildRepoConnectRequestBody,
  defaultBuildFields,
  deriveConnectFlowStage,
  derivePanelAccess,
  isProjectRepoConfigView,
  parseBranchesResponse,
  parseInstallationsResponse,
  parseReposResponse,
  repoRefFromConfig,
  validateBuildFields,
  type BuildFieldsDraft,
  type GithubInstallationView,
  type GithubRepoView,
  type ProjectRepoConfigView,
  type RepoRef,
} from "./project-repo-utils"

export interface ProjectRepoPanelProps {
  projectId: string
  /**
   * Closes the dialog hosting this panel.
   *
   * The panel renders its OWN `DialogFooter` (2026-08-29, Mo: "all the
   * buttons should be at the bottom with the Close"), because its actions are
   * per-state and the host cannot know them. The host therefore stops
   * rendering a footer of its own — two footers, one with the actions and one
   * with Close, is exactly the split this replaces.
   */
  onClose?: () => void
  /**
   * Where the GitHub-access flow should return to.
   *
   * Supplied by the HOST, because only the host knows the URL that reopens
   * its own dialog: the review screen's is `?repo=1`, and a dialog held in
   * local state would otherwise be shut when the reader lands back. Defaults
   * to the current URL, which is right for a host whose dialog is not
   * addressable — they come back to the same page with it closed, which is
   * worse than reopening but better than the dashboard.
   */
  returnPath?: string
  /**
   * The wizard's not-configured screen offers Admins a "Set up GitHub
   * access" button that calls this — the HOST then shows the App-setup step
   * (`GithubAccessSetupStep`) as its own dialog view (Mo, 2026-08-29:
   * another step in the flow, not content inside this screen). Without it,
   * Admins get the same "an Admin can set it up from Settings" sentence as
   * everyone else.
   */
  onSetUpGithub?: () => void
  className?: string
}

/**
 * Connect-a-repo panel (Phase 3c-1 Task 5). Follows `project-members.tsx`'s
 * data-fetching/loading/error pattern: this component owns all of its own
 * state and fetches independently of whatever else is mounted alongside it
 * (`review-shell.tsx` mounts it in a `Dialog`, same as `ProjectMembers`).
 *
 * Six states the phase plan calls out as MUST-be-distinct, and how each is
 * produced here:
 *
 * 1. App not configured on this deployment — `githubConfigured === false`,
 *    surfaced via `deriveConnectFlowStage`'s `"not-configured"` kind.
 * 2. Configured but no installation — `"no-installations"` kind.
 * 3. Installation present but no repos in it — `"no-repos"` kind, kept
 *    visually and textually distinct from #2 (the fix differs: grant repo
 *    access vs. install the App at all).
 * 4. Repo connected — a caller who can manage lands straight on the settings
 *    form. The read-only card survives only while `githubConfigured` is
 *    `false` (App config lost after the repo was connected) or still
 *    unknown; there is nothing an edit could save there, so it carries no
 *    Edit button — just the banner naming the fix, and Close.
 *
 *    There is NO Disconnect and NO "Change repo" (Mo, 2026-08-21: neither has
 *    a use case anyone could name). The server's `DELETE /repo` route still
 *    exists and still works; nothing in the UI calls it. Both controls are in
 *    git if they are wanted back.
 * 5. Not signed in — `access === "signed-out"`.
 * 6. Signed in but the role can't manage — `access === "read-only"`; no
 *    mutating control is ever rendered in this branch, since the API 403s them.
 *
 * **Who may manage (viewer-membership): the caller's INSTANCE role — `admin`
 * or `editor` — not project membership.** See `canManage` below.
 *
 * This panel carries NO build controls. Deploy, Upload a build and the build
 * log live on the review screen's Deployments tab (Mo, 2026-08-21: settings
 * should hold no build info and no way to build). If you are looking for the
 * escape hatch that uploads a bundle without a connected repo, it is there.
 */
export function ProjectRepoPanel({
  projectId,
  onClose,
  returnPath,
  onSetUpGithub,
  className,
}: ProjectRepoPanelProps) {
  const { user, loading: currentUserLoading, signInUrl, emailSignInEnabled } = useCurrentUser()

  /**
   * The GitHub App's slug, for the install URL.
   *
   * `https://github.com/settings/installations` only LISTS what you have
   * already installed; `https://github.com/apps/<slug>/installations/new` is
   * the page that installs this App. The combined action needs the second
   * one, so the slug the installations endpoint already returned stops being
   * discarded (2026-08-29).
   */
  const [appSlug, setAppSlug] = useState<string | null>(null)
  /**
   * True when this page load is the return leg of the combined flow (see
   * `github-access-flow.ts`). Read once, in a lazy initializer, and the
   * marker is stripped off the URL by the effect below so a refresh is an
   * ordinary visit.
   */
  const [checkingAfterSignIn, setCheckingAfterSignIn] = useState(
    () => typeof window !== "undefined" && isGithubCheckReturn(window.location.search),
  )
  /**
   * The account the flow was about, when it was about one. See
   * `githubCheckInstallationId` for why the refreshed list cannot answer this.
   */
  const [pendingInstallationId] = useState<number | null>(() =>
    typeof window === "undefined" ? null : githubCheckInstallationId(window.location.search),
  )
  const [projectLoaded, setProjectLoaded] = useState(false)
  const [repoConfig, setRepoConfig] = useState<ProjectRepoConfigView | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [githubConfigured, setGithubConfigured] = useState<boolean | null>(null)
  const [installations, setInstallations] = useState<GithubInstallationView[] | null>(null)
  const [installationsStale, setInstallationsStale] = useState(false)
  const [installationsError, setInstallationsError] = useState<string | null>(null)


  const [selectedInstallationId, setSelectedInstallationId] = useState<number | null>(null)
  const [repos, setRepos] = useState<GithubRepoView[] | null>(null)
  const [reposError, setReposError] = useState<string | null>(null)
  const [selectedRepo, setSelectedRepo] = useState<GithubRepoView | null>(null)

  // `null` = showing the connected-info card (or nothing, if unconnected —
  // see the render logic below, which forces "fresh" whenever there's no
  // repoConfig yet). `"fresh"` = the from-scratch installation→repo→build
  // wizard. `"edit"` = build-fields only, pre-filled from the EXISTING
  // connection, no picker (the common "just change the branch" case).
  const [flowMode, setFlowMode] = useState<"fresh" | "edit" | null>(null)
  const [buildFields, setBuildFields] = useState<BuildFieldsDraft | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)


  const loadProject = useCallback(async () => {
    try {
      const projectRes = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}`)
      if (!projectRes.ok) throw new Error(`GET project ${projectRes.status}`)
      const projectBody = (await projectRes.json()) as { repoConfig?: unknown }
      setRepoConfig(isProjectRepoConfigView(projectBody.repoConfig) ? projectBody.repoConfig : null)
      setProjectLoaded(true)
      setLoadError(null)
    } catch (err) {
      setLoadError(failureMessage(err))
    }
  }, [projectId])

  useEffect(() => {
    void loadProject()
  }, [loadProject])

  // Who may manage this connection is the caller's INSTANCE role — `admin` or
  // `editor` — not project membership (viewer-membership). The shared
  // predicate (`./instance-role.ts`), mirroring the server's
  // `hasProjectManageAuthority`; a `ProjectMember` row decides readability of
  // an `invited` project, never authority.
  const canManage = canManageProjects(user?.role)
  const access = derivePanelAccess({ currentUserLoading, signedIn: !!user, canManage })

  /**
   * Branch names for the repo the form is about, or null when we have none.
   *
   * Null is not "no branches" — it is "no list to offer", and the form falls
   * back to a free-text input. A picker is better when we can enumerate (Mo,
   * 2026-08-21: "we can know the branches"), but the fallback has to stay:
   * the route answers `configured: false` where no GitHub App is set up, and
   * a repo can be perfectly buildable while the branches call fails.
   */
  const [branches, setBranches] = useState<string[] | null>(null)

  const loadInstallations = useCallback(async () => {
    setInstallationsError(null)
    try {
      const {
        configured,
        appSlug: slug,
        installations: list,
        stale,
        // `fetchJson` + `failureMessage`, not a hand-built `GET … ${status}`
        // string: that ladder is how a raw URL ended up in a banner Mo had
        // to ask the meaning of (2026-08-29). `failureMessage` renders the
        // server's prose when there is any, and a human sentence otherwise.
      } = parseInstallationsResponse(await fetchJson("/api/v1/github/installations"))
      setAppSlug(slug)
      setGithubConfigured(configured)
      setInstallations(configured ? list : [])
      setInstallationsStale(configured && stale)
    } catch (err) {
      setInstallationsError(failureMessage(err))
      // A fetch failure must not be mistaken for "the App genuinely isn't
      // configured" — `githubConfigured` stays whatever it already was
      // (most likely `null`, still "unknown") rather than being forced to
      // `false`, so the not-configured messaging doesn't fire on a
      // transient network error.
    }
  }, [])

  // A caller who can manage needs to know `githubConfigured` up front to decide whether to
  // even offer a Connect/Edit control — fetched once per mount, regardless
  // of whether a repo is already connected (Edit is gated on this too).
  useEffect(() => {
    if (access === "can-manage" && githubConfigured === null) {
      void loadInstallations()
    }
  }, [access, githubConfigured, loadInstallations])

  // A project with no connection yet always shows the wizard directly
  // (no separate "Connect a repo" click first) — see the class doc comment.
  useEffect(() => {
    if (access === "can-manage" && repoConfig === null && flowMode === null) {
      setFlowMode("fresh")
    }
  }, [access, repoConfig, flowMode])

  const loadRepos = useCallback(async (installationId: number) => {
    setReposError(null)
    try {
      const { repos: list } = parseReposResponse(
        await fetchJson(`/api/v1/github/installations/${encodeURIComponent(String(installationId))}/repos`),
      )
      setRepos(list)
    } catch (err) {
      setReposError(failureMessage(err))
    }
  }, [])

  useEffect(() => {
    if (flowMode === "fresh" && selectedInstallationId !== null && repos === null) {
      void loadRepos(selectedInstallationId)
    }
  }, [flowMode, selectedInstallationId, repos, loadRepos])

  /**
   * The last leg of the combined flow: signed in, came back, and now what?
   *
   * Every branch lives in `decideAccessFlowCheck`, which is pure and tested;
   * this effect only carries out the answer. That split is deliberate, not
   * tidiness: the logic has been wrong twice, and both times an effect that
   * did nothing looked exactly like an effect that had correctly decided to
   * do nothing.
   *
   * It sits here rather than beside its state because it needs the repo list,
   * and a hook cannot be declared after this component's first early return.
   */
  useEffect(() => {
    if (!checkingAfterSignIn) return

    const decision = decideAccessFlowCheck({
      installations,
      installationsStale,
      pendingInstallationId,
      flowMode,
      access,
      selectedInstallationId,
      repos,
    })
    if (decision.action === "wait") return

    if (decision.action === "select") {
      setSelectedInstallationId(decision.installationId)
      setRepos(null)
      return
    }

    // The marker comes off HERE, not on the first pass. Clearing it earlier
    // would lose the check if the reader reloads while a fetch is still in
    // flight; leaving it on through a failure means a reload retries, which
    // is what someone staring at an error would expect.
    clearGithubCheckMarker()
    setCheckingAfterSignIn(false)

    if (decision.action === "continueToGithub") {
      const destination = accessFlowDestination(decision, appSlug)
      // Null means neither an installation page nor an App slug, so there is
      // nowhere to send them and the screen already says so. Stopping is the
      // whole handling.
      if (destination) window.location.href = destination
    }
  }, [
    checkingAfterSignIn,
    installations,
    installationsStale,
    appSlug,
    pendingInstallationId,
    flowMode,
    access,
    selectedInstallationId,
    repos,
  ])

  const resetWizardSelections = useCallback(() => {
    setSelectedInstallationId(null)
    setRepos(null)
    setReposError(null)
    setSelectedRepo(null)
    setBuildFields(null)
    setSubmitError(null)
  }, [])

  /**
   * A caller who can manage, with a connected repo, lands ON the settings form.
   *
   * It used to land on a read-only card with an Edit button beside it, so
   * changing a branch cost a click through a wizard step. Mo, 2026-08-21,
   * comparing against the original Desde settings dialog: "it allowed
   * you to change branch, etc." There, the fields WERE the dialog.
   *
   * Guarded on `flowMode === null` so it fires once after load and never
   * yanks someone out of a flow they chose: "Change repo" sets `"fresh"`,
   * and this leaves that alone.
   *
   * Still falls through to the read-only card when GitHub is unconfigured,
   * because there is nothing an edit could save.
   */
  useEffect(() => {
    if (flowMode !== null) return
    if (!repoConfig || access !== "can-manage" || githubConfigured !== true) return
    setBuildFields(buildFieldsFromConfig(repoConfig))
    setSubmitError(null)
    setFlowMode("edit")
  }, [flowMode, repoConfig, access, githubConfigured])

  /**
   * The repo the branch list should describe: the connection being edited, or
   * the one just picked in the wizard.
   *
   * `GithubRepoView` carries no installation id of its own — it was fetched
   * FOR an installation — so the picked case reads it from
   * `selectedInstallationId`.
   */
  const branchSource = useMemo(() => {
    if (flowMode === "edit" && repoConfig) {
      return { installationId: repoConfig.installationId, owner: repoConfig.owner, name: repoConfig.name }
    }
    if (selectedRepo && selectedInstallationId !== null) {
      return { installationId: selectedInstallationId, owner: selectedRepo.owner, name: selectedRepo.name }
    }
    return null
  }, [flowMode, repoConfig, selectedRepo, selectedInstallationId])

  useEffect(() => {
    if (!branchSource) {
      setBranches(null)
      return
    }
    let cancelled = false
    const { installationId, owner, name } = branchSource
    void fetch(
      `/api/v1/github/installations/${installationId}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/branches`,
    )
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (cancelled) return
        const parsed = body ? parseBranchesResponse(body) : null
        // An empty list is as good as no list: nothing to pick from, so the
        // input serves better than a Select with no options.
        setBranches(parsed && parsed.branches.length > 0 ? parsed.branches : null)
      })
      .catch(() => {
        if (!cancelled) setBranches(null)
      })
    return () => {
      cancelled = true
    }
  }, [branchSource])

  const cancelWizard = useCallback(() => {
    resetWizardSelections()
    // Back to the settings form when a repo is connected, since that IS the
    // steady state now. `null` would drop to the read-only card, which no
    // longer exists for a caller who can manage.
    if (repoConfig) {
      setBuildFields(buildFieldsFromConfig(repoConfig))
      setFlowMode("edit")
      return
    }
    setFlowMode("fresh")
  }, [repoConfig, resetWizardSelections])

  const pickInstallation = useCallback((id: number) => {
    setSelectedInstallationId(id)
    setRepos(null)
    setSelectedRepo(null)
  }, [])

  const pickRepo = useCallback((repo: GithubRepoView) => {
    setSelectedRepo(repo)
    setBuildFields(defaultBuildFields(repo))
  }, [])

  const handleConnect = useCallback(
    async (repo: RepoRef) => {
      if (!buildFields) return
      const errors = validateBuildFields(buildFields)
      if (!buildFieldsAreValid(errors)) return
      setSubmitting(true)
      setSubmitError(null)
      try {
        const res = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/repo`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(buildRepoConnectRequestBody(repo, buildFields)),
        })
        const body: unknown = await res.json().catch(() => null)
        if (!res.ok) {
          const message =
            body !== null && typeof body === "object" && typeof (body as { error?: unknown }).error === "string"
              ? (body as { error: string }).error
              : `Couldn't connect that repository (HTTP ${res.status})`
          setSubmitError(message)
          return
        }
        resetWizardSelections()
        setFlowMode(null)
        await loadProject()
      } catch (err) {
        setSubmitError(err instanceof Error ? err.message : String(err))
      } finally {
        setSubmitting(false)
      }
    },
    [buildFields, projectId, resetWizardSelections, loadProject],
  )

  // `members` is the reliable "has the initial load completed" signal —
  // `repoConfig` legitimately STAYS `null` forever for a project that's
  // simply never been connected, so it can't be used as a loading flag
  // (that would spin forever on the single most common case).
  if (access === "loading" || (!projectLoaded && loadError === null)) {
    return <ProjectLoader size={80} label="Loading" className={cn("py-6", className)} />
  }

  if (loadError) {
    return (
      <div className={cn("flex flex-col gap-3", className)}>
        <LoadFailure size="sm" title="Couldn't load repo settings" description={loadError} />
        {onClose ? (
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={onClose}>
              Close
            </Button>
          </DialogFooter>
        ) : null}
      </div>
    )
  }

  // --- State 5: not signed in ---------------------------------------------
  // Whether to offer a CTA follows the same `signInUrl`/`emailSignInEnabled`
  // ladder `AccountMenu` and `TokensPanel` use (viewer-membership) — NOT
  // `authEnabled`, which means only "GitHub sign-in is configured" and says
  // nothing about whether some OTHER method (email) exists on this deployment.
  if (access === "signed-out") {
    const canSignIn = signInUrl !== null || emailSignInEnabled
    const signInHref = emailSignInEnabled ? "/signin" : signInUrl
    return (
      <div className={cn("flex flex-col gap-3", className)}>
        {repoConfig ? (
          <ConnectedRepoSummary repoConfig={repoConfig} />
        ) : (
          <EmptyState size="sm" title="No repository connected" description="Connect one to build this project from source." />
        )}
        {/* Reason left of the buttons, buttons right, and a footer Close so
            the header X is never the only way out (Mo, 2026-08-29). */}
        <DialogFooter className="sm:items-center">
          <p className="mr-auto min-w-0 text-xs text-muted-foreground">
            {canSignIn
              ? "Sign in as an editor or admin to manage this."
              : "Sign-in isn't configured on this viewer, so repo connections can't be managed here."}
          </p>
          {onClose ? (
            <Button variant="outline" size="sm" onClick={onClose}>
              Close
            </Button>
          ) : null}
          {canSignIn ? (
            <Button asChild size="sm">
              {/* `?? undefined`: `canSignIn` above already rules out
                  `signInHref` being null here. */}
              <a href={signInHref ?? undefined}>Sign in</a>
            </Button>
          ) : null}
        </DialogFooter>
      </div>
    )
  }

  // --- State 6: signed in, but the role can't manage — read-only, no controls ---
  if (access === "read-only") {
    return (
      <div className={cn("flex flex-col gap-3", className)}>
        {repoConfig ? (
          <ConnectedRepoSummary repoConfig={repoConfig} />
        ) : (
          <EmptyState
            size="sm"
            title="No repository connected"
            description="Only editors and admins can connect a repository."
          />
        )}
        {onClose ? (
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={onClose}>
              Close
            </Button>
          </DialogFooter>
        ) : null}
      </div>
    )
  }

  // --- Can-manage: connected-info view (no wizard active) ----------------------
  // Only reachable while the App is missing or its status is still unknown:
  // whenever `githubConfigured === true`, the auto-edit effect above has
  // already replaced this view with the settings form. The Edit button that
  // used to sit here was therefore disabled in EVERY reachable case — a
  // leftover of the pre-2026-08-21 flow where this card was the landing for
  // everyone (Mo, 2026-08-29: "why is there an edit button"). Removed; the
  // banner below carries the fix instead.
  if (flowMode === null && repoConfig) {
    return (
      <div className={cn("flex flex-col gap-3", className)}>
        <ConnectedRepoSummary repoConfig={repoConfig} />
        {githubConfigured === false ? <GithubAppUnreachableBanner /> : null}
        {githubConfigured === null && installationsError ? (
          /* The status check itself failed, so whether editing is possible is
             unknown — lead with what that MEANS before the failure itself,
             and offer the retry, instead of the silent dead end the gallery
             audit flagged as a visual gap. */
          <Callout tone="destructive">
            Couldn&apos;t check GitHub access, so whether these settings can be edited is
            unknown. {installationsError}
          </Callout>
        ) : null}
        <DialogFooter className="sm:items-center">
          {onClose ? (
            <Button variant="outline" size="sm" onClick={onClose}>
              Close
            </Button>
          ) : null}
          {githubConfigured === null && installationsError ? (
            <Button size="sm" onClick={() => void loadInstallations()}>
              <RefreshCw /> Retry
            </Button>
          ) : null}
        </DialogFooter>
      </div>
    )
  }

  // --- Can-manage: the wizard (fresh connect, or editing an existing one) -----
  const stage = deriveConnectFlowStage({
    configured: githubConfigured !== false,
    initialRepoRef: flowMode === "edit" && repoConfig ? repoRefFromConfig(repoConfig) : null,
    installations,
    installationsStale,
    selectedInstallationId,
    repos,
    selectedRepo,
  })

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <ConnectWizard
        onClose={onClose}
        returnPath={returnPath}
        onSetUpGithub={onSetUpGithub}
        stage={stage}
        mode={flowMode === "edit" ? "edit" : "fresh"}
        canCancel={repoConfig !== null}
        installationsError={installationsError}
        reposError={reposError}
        buildFields={buildFields}
        savedBuildFields={repoConfig ? buildFieldsFromConfig(repoConfig) : null}
        branches={branches}
        submitting={submitting}
        submitError={submitError}
        onRetryInstallations={() => void loadInstallations()}
        onRetryRepos={() => {
          if (selectedInstallationId !== null) void loadRepos(selectedInstallationId)
        }}
        onPickInstallation={pickInstallation}
        onBackToInstallations={() => {
          setSelectedInstallationId(null)
          setRepos(null)
          setSelectedRepo(null)
        }}
        onPickRepo={pickRepo}
        onBackToRepos={() => {
          setSelectedRepo(null)
          setBuildFields(null)
        }}
        onChangeBuildFields={setBuildFields}
        onSubmit={(repo) => void handleConnect(repo)}
        onCancel={cancelWizard}
      />

    </div>
  )
}

/**
 * The account list's escape hatch. It replaced the "last read N ago" age
 * note (Mo, 2026-08-29): the age answered "might refreshing help?", but the
 * question the reader actually arrives with is "why isn't my account here?"
 * — so the note asks that, and the link IS the refresh. The list is a
 * snapshot taken at sign-in and no credential is stored to re-query with
 * (see the server's `caller-installations.ts`), so the linked flow signs in
 * again and returns here.
 */
function RefreshAccessNote({ href }: { href: string }) {
  return (
    <p className="text-2xs text-muted-foreground">
      Not seeing an account?{" "}
      <a href={href} className="underline underline-offset-2 hover:text-foreground">
        Refresh GitHub access
      </a>{" "}
      to update the list.
    </p>
  )
}

/**
 * A plain key-value list, not a card (Mo, 2026-08-29: "this card is
 * unnecessary — just have a key value pair list in the normal font size, not
 * mono font"). The border, the icon and the badges were decoration around
 * six facts; the labels carry the structure on their own. Body size
 * throughout, values in the UI font — a deliberate exception to the
 * mono-for-paths rule, by the same instruction.
 */
function ConnectedRepoSummary({ repoConfig }: { repoConfig: ProjectRepoConfigView }) {
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-base">
      <dt className="text-muted-foreground">Repository</dt>
      <dd className="truncate">
        {repoConfig.owner}/{repoConfig.name}
      </dd>
      <dt className="text-muted-foreground">Branch</dt>
      <dd className="truncate">{repoConfig.branch}</dd>
      <dt className="text-muted-foreground">Install</dt>
      <dd className="truncate">{repoConfig.installCommand}</dd>
      <dt className="text-muted-foreground">Build</dt>
      <dd className="truncate">{repoConfig.buildCommand}</dd>
      <dt className="text-muted-foreground">Output</dt>
      <dd className="truncate">{repoConfig.outputDir}</dd>
      <dt className="text-muted-foreground">Auto-deploy</dt>
      <dd>{repoConfig.autoDeploy ? "On" : "Off"}</dd>
    </dl>
  )
}

interface ConnectWizardProps {
  stage: ReturnType<typeof deriveConnectFlowStage>
  /**
   * `"edit"` means `stage`'s `build-form` (if reached) came from
   * `initialRepoRef` — the installation/repo picker was never run this
   * time, so there is no picker state to "go back" to. `"fresh"` means the
   * repo on `build-form` (if reached) was actually picked via the wizard,
   * so `onBackToRepos` is meaningful. Only `build-form` branches on this;
   * every earlier stage is picker-driven and therefore always `"fresh"`.
   */
  mode: "fresh" | "edit"
  canCancel: boolean
  installationsError: string | null
  reposError: string | null
  buildFields: BuildFieldsDraft | null
  /**
   * What is currently SAVED, for the dirty check. Null in fresh mode, where
   * there is nothing saved to differ from.
   */
  savedBuildFields: BuildFieldsDraft | null
  /** Names to offer in the branch picker, or null to fall back to a text input. */
  branches: string[] | null
  submitting: boolean
  submitError: string | null
  onRetryInstallations: () => void
  onRetryRepos: () => void
  onPickInstallation: (id: number) => void
  onBackToInstallations: () => void
  onPickRepo: (repo: GithubRepoView) => void
  onBackToRepos: () => void
  onChangeBuildFields: (fields: BuildFieldsDraft) => void
  onSubmit: (repo: RepoRef) => void
  onCancel: () => void
}

/**
 * One footer for every wizard state: Cancel, then the state's own action —
 * so the primary sits rightmost, the way every other dialog in the product
 * ends (Cancel, then Create / Save / Delete). It briefly rendered the other
 * way around, which put Cancel to the primary's right and nowhere else.
 *
 * Cancel closes the DIALOG. It is the renamed "Close" the hosts used to carry
 * (Mo, 2026-08-29: "replace close with Cancel") — in a footer that also holds
 * actions, "Close" reads as a fourth thing you might do rather than as the
 * way out of the ones beside it. `type="button"` because the build-form and
 * the setup card render this footer inside a `<form>`, where a bare button
 * is a submit.
 *
 * `start` is the left-parked slot (Mo, 2026-08-29: "keep buttons to the
 * right, you can leave the description on the left of the button"): wizard
 * back-navigation ghosts and the caption explaining the primary go here,
 * left-aligned, while the committing buttons stay right.
 */
function WizardFooter({
  onClose,
  start,
  children,
}: {
  onClose?: () => void
  start?: ReactNode
  children?: ReactNode
}) {
  return (
    <DialogFooter className="sm:items-center">
      {start ? <div className="mr-auto flex min-w-0 items-center gap-2">{start}</div> : null}
      {onClose ? (
        <Button type="button" variant="outline" size="sm" onClick={onClose}>
          Cancel
        </Button>
      ) : null}
      {children}
    </DialogFooter>
  )
}

function ConnectWizard({
  stage,
  mode,
  canCancel,
  onClose,
  installationsError,
  reposError,
  buildFields,
  savedBuildFields,
  branches,
  submitting,
  submitError,
  onRetryInstallations,
  onRetryRepos,
  onPickInstallation,
  onBackToInstallations,
  onPickRepo,
  onBackToRepos,
  onChangeBuildFields,
  onSubmit,
  onCancel,
  returnPath,
  onSetUpGithub,
}: ConnectWizardProps & {
  onClose?: () => void
  returnPath?: string
  onSetUpGithub?: () => void
}) {
  /*
    Where the sign-in leg should return to: this exact page, as it stands.

    Read from `window.location` rather than passed in, because the panel is
    mounted from three different dialogs on two different routes and none of
    them knows the reader's current URL better than the browser does. On the
    server it is "/" — the value is only ever used inside an `href` the reader
    has to click, so a first-render placeholder costs nothing, and the server
    re-validates whatever arrives anyway (`safeReturnPath`).
  */
  const currentPath =
    typeof window === "undefined"
      ? "/"
      : `${window.location.pathname}${window.location.search}`
  const flowReturnPath = returnPath ?? currentPath

  const { user } = useCurrentUser()
  const isAdmin = user?.role === "admin"

  /**
   * The picker steps select locally and commit from the footer (Mo,
   * 2026-08-29: radio cards plus an action button, not rows that commit on
   * click — an `OptionCard` is what tells the reader a click only selects).
   * Committing is `onPickInstallation` / `onPickRepo`, fired by Next; these
   * hold the not-yet-committed choice, and fall back to the first option so
   * Next is never dead on open.
   */
  const [pendingInstallationId, setPendingInstallationId] = useState<number | null>(null)
  const [pendingRepoId, setPendingRepoId] = useState<number | null>(null)
  // --- State 1: App not configured on this deployment ---------------------
  // Branches on the caller's instance role, because the fix differs: an Admin
  // can create the App right here (the setup card is the whole flow — its
  // submit navigates this tab to github.com), while anyone else can only ask.
  // The role check is a UX courtesy; `requireOperator` on the manifest route
  // is the real gate, and the card renders the server's refusal if they
  // disagree.
  if (stage.kind === "not-configured") {
    const canOfferSetup = isAdmin && onSetUpGithub !== undefined
    return (
      <>
        {/* An empty state with a button; the setup itself is the HOST's own
            step, reached through `onSetUpGithub` (Mo, 2026-08-29: "think of
            it as another step in the flow", not content inside this
            screen). The App is deployment-wide, so this wizard only states
            the fact and hands over. */}
        <EmptyState
          size="sm"
          title="GitHub isn't set up on this viewer"
          description={
            canOfferSetup
              ? "A GitHub App is needed to reach GitHub repositories. It is set up once."
              : "A GitHub App is needed to reach GitHub repositories. An Admin can set it up from Settings."
          }
        />
        <WizardFooter
          onClose={onClose}
          start={
            canCancel ? (
              <Button size="sm" variant="ghost" onClick={onCancel}>
                Back
              </Button>
            ) : undefined
          }
        >
          {canOfferSetup ? (
            <Button size="sm" onClick={onSetUpGithub}>
              Set up GitHub access
            </Button>
          ) : null}
        </WizardFooter>
      </>
    )
  }

  if (stage.kind === "loading-installations") {
    return (
      <>
        <div className="flex flex-col gap-2">
          {/* The house wait, not a line of grey text (Mo, 2026-08-29: "this
              should have a loading spinner"). Same treatment the settings
              panels and the review rail got — this one was missed because it
              says "Checking" rather than "Loading", so the audit's grep for
              `>Loading<` walked straight past it.

              No label: the dialog title above already says what is being waited
              on (docs/design.md, "don't repeat the noun the surface already
              carries"). */}
          <ProjectLoader size={80} className="py-6" />
          {installationsError ? <Callout tone="destructive">{installationsError}</Callout> : null}
        </div>
        {/* Retry lives in the footer with Cancel, right-aligned, like every
            other state's action (Mo, 2026-08-29) — it was a left-aligned
            button floating under the banner. */}
        <WizardFooter onClose={onClose}>
          {installationsError ? (
            <Button size="sm" onClick={onRetryInstallations}>
              <RefreshCw /> Retry
            </Button>
          ) : null}
        </WizardFooter>
      </>
    )
  }

  // --- Phase 3c-1b: the caller's installation snapshot is stale/absent ----
  // Distinct from "no installations": nothing is wrong on GitHub's side, we
  // simply have no current snapshot of what this account can see. The
  // snapshot is captured during sign-in, so signing in again IS the refresh
  // — there is no stored credential to re-query with, by design.
  if (stage.kind === "installations-stale") {
    return (
      <>
        <EmptyState
          size="sm"
          title="Your GitHub access needs refreshing"
          description="Which repositories you can connect is read from GitHub when you sign in, and this account's is missing or out of date. Refreshing reads it again."
        />
        <WizardFooter
          onClose={onClose}
          start={
            canCancel ? (
              <Button size="sm" variant="ghost" onClick={onCancel}>
                Back
              </Button>
            ) : undefined
          }
        >
          {/* "Refresh", matching the title's verb (Mo, 2026-08-29) — the
              sibling states keep "Connect GitHub access", because there the
              same flow GRANTS access rather than re-reading it. */}
          <Button asChild size="sm">
            <a href={githubAccessFlowHref(flowReturnPath)}>Refresh GitHub access</a>
          </Button>
        </WizardFooter>
      </>
    )
  }

  if (stage.kind === "no-installations") {
    return (
      /*
        Reworked 2026-08-29, after Mo asked what an "installation" is — which
        is the finding: it is GitHub's noun, and docs/design.md's
        four-question test rules out printing a term the reader did not
        choose.

        REFRESH IS GONE, and that was a correctness fix. The set of accounts
        this viewer can read is captured during the OAuth callback and the
        provider token is never stored
        (`server/auth/github-auth-provider.ts`), so nothing can re-query on
        the reader's behalf. There is no silent refresh to offer — Mo asked,
        and the answer is that re-authenticating IS the refresh. The button
        says that rather than "Sign in with GitHub", which told an
        already-signed-in person to sign in.

        The age note went with it. It only ever answered "might refreshing
        help?", and when refreshing is the single action on screen that is a
        question nobody needs answered.
      */
      <>
        <EmptyState
          size="sm"
          title="No repositories to connect"
          description="Repositories are read through a GitHub App. Connecting signs you in to GitHub, and takes you there to grant access if the App doesn't have it yet."
        />
        <WizardFooter
          onClose={onClose}
          start={
            canCancel ? (
              <Button size="sm" variant="ghost" onClick={onCancel}>
                Back
              </Button>
            ) : undefined
          }
        >
          {/* ONE action (Mo, 2026-08-29). It signs in, comes back, and
              continues to GitHub only if there is still nothing to connect —
              see `github-access-flow.ts`. Two buttons asked the reader to
              know which of those their situation needed, which the screen
              cannot tell them because it does not know either. */}
          <Button asChild size="sm">
            <a href={githubAccessFlowHref(flowReturnPath)}>Connect GitHub access</a>
          </Button>
        </WizardFooter>
      </>
    )
  }

  if (stage.kind === "installation-picker") {
    // Falls back to the first account so Next is live on open; guarded
    // against a pending id that a refreshed list no longer contains.
    const selectedInstallation =
      pendingInstallationId !== null && stage.installations.some((i) => i.id === pendingInstallationId)
        ? pendingInstallationId
        : (stage.installations[0]?.id ?? null)
    return (
      <>
        <div className="flex flex-col gap-1.5">
          {/* "account", not "installation" (Mo, 2026-08-29). Each option shows
              `inst.accountLogin` — an account or organisation name — so the
              heading names what the options actually are.

              Radio cards, not rows that commit on click (Mo, 2026-08-29):
              a click selects, the footer's Next commits, which is the same
              decision shape as every other picker dialog in the product. */}
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Choose an account</p>
          <OptionCardGroup
            value={selectedInstallation !== null ? String(selectedInstallation) : undefined}
            onValueChange={(v) => setPendingInstallationId(Number(v))}
            aria-label="Choose an account"
          >
            {stage.installations.map((inst) => (
              <OptionCard key={inst.id} value={String(inst.id)} title={inst.accountLogin} />
            ))}
          </OptionCardGroup>
          <RefreshAccessNote href={githubAccessFlowHref(flowReturnPath)} />
        </div>
        <WizardFooter
          onClose={onClose}
          start={
            canCancel ? (
              <Button size="sm" variant="ghost" onClick={onCancel}>
                Back
              </Button>
            ) : undefined
          }
        >
          <Button
            size="sm"
            disabled={selectedInstallation === null}
            onClick={() => selectedInstallation !== null && onPickInstallation(selectedInstallation)}
          >
            Next
          </Button>
        </WizardFooter>
      </>
    )
  }

  if (stage.kind === "loading-repos") {
    return (
      <>
        <div className="flex flex-col gap-2">
          <ProjectLoader size={80} label="Loading" className="py-6" />
          {reposError ? <Callout tone="destructive">{reposError}</Callout> : null}
        </div>
        <WizardFooter
          onClose={onClose}
          /* Back-navigation only once the load has FAILED (Mo, 2026-08-29:
             "why does this have choose a different account" on a plain
             loading screen) — while the spinner is up the state resolves on
             its own in a moment, and a stray ghost button under it read as
             part of the screen rather than as an escape from a failure. */
          start={
            reposError ? (
              <Button size="sm" variant="ghost" onClick={onBackToInstallations}>
                Back
              </Button>
            ) : undefined
          }
        >
          {reposError ? (
            <Button size="sm" onClick={onRetryRepos}>
              <RefreshCw /> Retry
            </Button>
          ) : null}
        </WizardFooter>
      </>
    )
  }

  // --- State 3: the account is connected but shares no repositories --------
  if (stage.kind === "no-repos") {
    return (
      /*
        Same rework as `no-installations`, for the same reason: the repo list
        is filtered against a set captured at sign-in too
        (`filterReposForCaller`), so nothing here can be refreshed without
        re-authenticating either.
      */
      <>
        <EmptyState
          size="sm"
          title="No repositories shared with this account"
          description="The GitHub App hasn't been given access to any repository on this account. Granting access takes you to GitHub to choose repositories."
        />
        <WizardFooter
          onClose={onClose}
          start={
            <Button size="sm" variant="ghost" onClick={onBackToInstallations}>
              Back
            </Button>
          }
        >
          {/* ONE action (Mo, 2026-08-29). It signs in, comes back, and
              continues to GitHub only if there is still nothing to connect —
              see `github-access-flow.ts`. Two buttons asked the reader to
              know which of those their situation needed, which the screen
              cannot tell them because it does not know either.

              The account travels with it. On THIS screen the refreshed list
              always comes back non-empty (the account is in it), so the
              return leg has to ask about this account's repositories rather
              than about the list. Without the id it stops here every time.

              "Grant repo access", the same name Settings › GitHub gives the
              same GitHub page (Mo, 2026-08-29: not "Connect GitHub access"
              — here the job is changing what the App may see). */}
          <Button asChild size="sm">
            <a href={githubAccessFlowHref(flowReturnPath, stage.installationId)}>Grant repo access</a>
          </Button>
        </WizardFooter>
      </>
    )
  }

  if (stage.kind === "repo-picker") {
    const selectedRepoId =
      pendingRepoId !== null && stage.repos.some((r) => r.id === pendingRepoId)
        ? pendingRepoId
        : (stage.repos[0]?.id ?? null)
    const pendingRepo = stage.repos.find((r) => r.id === selectedRepoId) ?? null
    return (
      <>
        <div className="flex flex-col gap-1.5">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Choose a repository</p>
          {/* Capped so an account with hundreds of repositories scrolls this
              list instead of growing the dialog past the viewport. */}
          <div className="max-h-80 overflow-y-auto">
            <OptionCardGroup
              value={selectedRepoId !== null ? String(selectedRepoId) : undefined}
              onValueChange={(v) => setPendingRepoId(Number(v))}
              aria-label="Choose a repository"
            >
              {stage.repos.map((repo) => (
                <OptionCard
                  key={repo.id}
                  value={String(repo.id)}
                  title={repo.fullName}
                  hint={repo.private ? "Private" : undefined}
                />
              ))}
            </OptionCardGroup>
          </div>
        </div>
        {/* Plain "Back" to the account step (Mo, 2026-08-29) — every
            step-back ghost carries the same name; where it goes is the
            previous step. */}
        <WizardFooter
          onClose={onClose}
          start={
            <Button size="sm" variant="ghost" onClick={onBackToInstallations}>
              Back
            </Button>
          }
        >
          <Button
            size="sm"
            disabled={pendingRepo === null}
            onClick={() => pendingRepo !== null && onPickRepo(pendingRepo)}
          >
            Next
          </Button>
        </WizardFooter>
      </>
    )
  }

  // stage.kind === "build-form"
  if (!buildFields) return null
  const errors = validateBuildFields(buildFields)
  /*
    Valid AND changed. A Save that is live on an untouched form invites a
    write that changes nothing, and gives no signal about whether what you
    just typed registered (Mo, 2026-08-21).

    Only when something is SAVED to differ from. A fresh connect has no
    baseline, and requiring a change there would refuse a perfectly good
    connection that accepts every default — which is the common case.
  */
  const dirty = savedBuildFields === null || !buildFieldsEqual(buildFields, savedBuildFields)
  const canSubmit = !submitting && dirty && buildFieldsAreValid(errors)

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
        {stage.repo.owner}/{stage.repo.name}
      </p>

      {/*
        A picker when the branches are known, a text input when they are not.
        The fallback is not defensive padding: the route answers
        `configured: false` where no GitHub App is set up, and the call can
        fail on a repo that is otherwise perfectly buildable.

        The CURRENT value joins the options when the list does not contain it.
        Otherwise editing a connection whose branch has since been deleted
        renders a Select showing nothing, silently discarding a value the form
        is about to save.
      */}
      <Field label="Branch" htmlFor="repo-branch" error={buildFields.branch.length > 0 ? errors.branch : null}>
        {branches ? (
          <Select
            value={buildFields.branch}
            onValueChange={(branch) => onChangeBuildFields({ ...buildFields, branch })}
          >
            <SelectTrigger id="repo-branch" className="w-full">
              <SelectValue placeholder="Choose a branch" />
            </SelectTrigger>
            <SelectContent>
              {(branches.includes(buildFields.branch) || !buildFields.branch
                ? branches
                : [buildFields.branch, ...branches]
              ).map((branch) => (
                <SelectItem key={branch} value={branch}>
                  {branch}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <Input
            id="repo-branch"
            value={buildFields.branch}
            onChange={(e) => onChangeBuildFields({ ...buildFields, branch: e.target.value })}
          />
        )}
      </Field>

      <Field
        label="Install command"
        htmlFor="repo-install-command"
        error={buildFields.installCommand.length > 0 ? errors.installCommand : null}
      >
        <Input
          id="repo-install-command"
          value={buildFields.installCommand}
          onChange={(e) => onChangeBuildFields({ ...buildFields, installCommand: e.target.value })}
        />
      </Field>

      <Field
        label="Build command"
        htmlFor="repo-build-command"
        error={buildFields.buildCommand.length > 0 ? errors.buildCommand : null}
      >
        <Input
          id="repo-build-command"
          value={buildFields.buildCommand}
          onChange={(e) => onChangeBuildFields({ ...buildFields, buildCommand: e.target.value })}
        />
      </Field>

      <Field
        label="Output dir"
        htmlFor="repo-output-dir"
        error={buildFields.outputDir.length > 0 ? errors.outputDir : null}
      >
        <Input
          id="repo-output-dir"
          value={buildFields.outputDir}
          onChange={(e) => onChangeBuildFields({ ...buildFields, outputDir: e.target.value })}
        />
      </Field>

      <label className="flex items-center gap-2 text-sm">
        <Switch
          size="sm"
          checked={buildFields.autoDeploy}
          onCheckedChange={(checked) => onChangeBuildFields({ ...buildFields, autoDeploy: checked === true })}
        />
        Auto-deploy on push
      </label>

      {submitError ? <Callout tone="destructive">{submitError}</Callout> : null}

      {/*
        Cancel then Save, right aligned, the way every dialog in the product
        ends (Mo, 2026-08-21). Cancel closes the dialog; the old edit-mode
        "Back", which reverted the fields and stayed open, went with the
        one-footer pass (2026-08-29) — a second escape next to Cancel asked
        the reader to know which kind of leaving each one meant.

        "Change repo" is gone: repointing a project at a different repository
        is closer to creating a new project than editing this one, and Mo's
        read is that nobody does it.

        Step-back ghosts are all named plain "Back" (Mo, 2026-08-29) — where
        they go is the previous step, and naming the destination made each
        one read as a different kind of control. Fresh mode only: a first
        connect walks account to repo to form; edit mode arrived here
        directly from its connection and has no picker behind it.
      */}
      <WizardFooter
        onClose={onClose}
        start={
          mode === "fresh" ? (
            <Button size="sm" variant="ghost" onClick={onBackToRepos}>
              Back
            </Button>
          ) : undefined
        }
      >
        <Button size="sm" disabled={!canSubmit} busy={submitting} onClick={() => onSubmit(stage.repo)}>
          {submitting ? "Saving" : mode === "edit" ? "Save" : "Connect"}
        </Button>
      </WizardFooter>
    </div>
  )
}
