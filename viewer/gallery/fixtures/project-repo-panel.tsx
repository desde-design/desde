"use client"

import { useEffect, useState } from "react"
import { AddPrototypeSource } from "../../app/add-prototype-source"
import { GITHUB_APP_SETUP_INTRO, GithubAccessSetupStep } from "../../app/github-app-setup-card"
import { ProjectRepoPanel } from "../../app/project-repo-panel"
import {
  ME_SIGNED_IN,
  ME_SIGNED_IN_EMAIL_ONLY,
  ME_SIGNED_OUT,
  SAMPLE_INSTALLATIONS_RESPONSE,
  SAMPLE_PROJECT,
  SAMPLE_REPO_CONFIG,
  SAMPLE_REPOS,
} from "../harness/fixture-data"
import { DialogFrame, Scenario } from "../harness/scenario"
import { fail, NETWORK_ERROR, ok, PENDING } from "@/components/gallery/fetch-override"
import {
  clickLikeUser,
  findButtonByText,
  findByText,
  runDrivenInteraction,
  setNativeValue,
  waitForElement,
} from "@/components/gallery/dom-interaction"
import type { SurfaceEntry, SurfaceRenderContext } from "@/components/gallery/types"

/**
 * The connect-a-repo panel — `review-shell.tsx` mounts it in a `Dialog` titled
 * "Repository settings" (renamed from `Repo: {project.name}`, Mo 2026-08-29).
 *
 * The audit found 45 distinct states. Most of the spread comes from two axes
 * that repeat at nearly every wizard step (a "Cancel" button that only shows
 * up when editing an existing connection, and a "your access was checked N
 * ago" note that only depends on a timestamp being present) rather than from
 * 45 different visual ideas. This fixture keeps one state per visual idea and
 * says, in place, which axis it collapsed and why — per the harness's
 * "collapse near-duplicates" rule. Skipped entirely:
 * `wizard-build-form-blank-guard` (the audit found no supported interaction
 * that reaches it — `buildFields` is always set before that stage renders).
 *
 * `useCurrentUser` (`/api/v1/me`) is fetched by the panel itself, independent
 * of the project fetch — so every state below sets it explicitly rather than
 * relying on which branch happens to run first.
 */

const PID = SAMPLE_PROJECT.id
const REPO_DIALOG_TITLE = "Repository settings"
/**
 * The create wizard's title, on every fresh-connect state below (Mo,
 * 2026-08-29: both steps of adding a project are titled "Add
 * project"). The settings-flavoured states — connected views, the edit
 * form, signed-out/read-only — keep "Repository settings", matching which
 * host actually shows each state.
 */
const ADD_DIALOG_TITLE = "Add project"
const REPOS_PATH = `/api/v1/github/installations/${SAMPLE_INSTALLATIONS_RESPONSE.installations[0].id}/repos`
/**
 * The branch picker's endpoint, for the repo the build form lands on.
 *
 * A LONGER key than `REPOS_PATH` on purpose, and that is what makes it work:
 * the route table matches by prefix and resolves longest-first, so without an
 * explicit entry here `/repos/acme/widget/branches` is swallowed by the
 * `/repos` mock, `parseBranchesResponse` reads no `branches` array, and the
 * form quietly falls back to the text input — the exact state the picker was
 * added to replace, showing green in the gallery.
 */
const BRANCHES_PATH = `${REPOS_PATH}/${SAMPLE_REPOS[0].owner}/${SAMPLE_REPOS[0].name}/branches`
const BRANCHES_OK = ok({ configured: true, branches: ["main", "feat/new-nav", "release/2026-08"] })

/**
 * A small wrapper rather than an inline route entry at every call site, kept
 * for the shape (every state that touches `repoConfig` builds its route
 * table the same way) — not, any more, because the panel needs a second
 * endpoint alongside it. Task 12 dropped `ProjectRepoPanel`'s own `/members`
 * fetch entirely (authority is the caller's role now, not a membership row —
 * see `READ_ONLY_USER`'s doc comment), so this used to also mock
 * `/api/v1/projects/:id/members` and no longer does.
 */
function projectRoutes(repoConfig: unknown) {
  return {
    [`/api/v1/projects/${PID}`]: ok({ ...SAMPLE_PROJECT, repoConfig }),
  }
}

/**
 * Signed in with the `viewer` instance role (viewer-membership Task 12:
 * authority is role-based now, not project membership — see
 * `derivePanelAccess`'s `canManage` param in `project-repo-utils.ts`). An
 * `editor` or `admin` account gets the mutating controls regardless of
 * whether they're on this project's access list at all, so the read-only
 * view needs a `viewer`-role account specifically, not merely a non-member.
 */
const READ_ONLY_USER = {
  id: "user-dana",
  provider: "github" as const,
  email: "dana@example.com",
  displayName: "Dana Whitfield",
  avatarUrl: "https://avatars.githubusercontent.com/u/3?v=4",
  role: "viewer" as const,
  createdAt: "2026-07-20T10:00:00.000Z",
}

/** Covers the Auto-deploy "Off" row without a dedicated state — the "On"
 * variant is already the default in `SAMPLE_REPO_CONFIG`, shown on the
 * manager's connected view below. (The summary is a key-value list since
 * 2026-08-29; the badges this constant used to toggle are gone.) */
const REPO_CONFIG_NO_AUTO_DEPLOY = { ...SAMPLE_REPO_CONFIG, autoDeploy: false }

const INSTALLATIONS_NOT_CONFIGURED = ok({ configured: false, installations: [] })
/**
 * What `GET /api/v1/setup/github/manifest` answers the Admin whose wizard
 * renders the setup card inline. Every not-configured state where an Admin is
 * signed in must mock this route: the baseline fallback (`json({})`) would
 * hand the card a `state`/`manifest` of `undefined` and the form would build
 * a broken `action` URL.
 */
const SAMPLE_MANIFEST_RESPONSE = ok({
  manifest: {
    name: "Desde Viewer (viewer.example.dev)",
    url: "https://viewer.example.dev",
    redirect_url: "https://viewer.example.dev/api/v1/setup/github/callback",
    setup_url: "https://viewer.example.dev",
    public: false,
  },
  state: "gallery-fixture-state",
})
/** `configured: true`, but the caller isn't asking what's IN the list — used
 * wherever a state just needs Edit/the wizard to see the App as configured. */
const INSTALLATIONS_CONFIGURED_EMPTY = ok({ ...SAMPLE_INSTALLATIONS_RESPONSE, installations: [] })
const INSTALLATIONS_STALE = ok({ ...SAMPLE_INSTALLATIONS_RESPONSE, installations: [], installationsStale: true })
/** The full two-installation, snapshot-age-stamped body — reused wherever the
 * fixture needs a real installation to click through into the repo picker. */
const INSTALLATIONS_POPULATED = ok(SAMPLE_INSTALLATIONS_RESPONSE)

/** Everything a fresh (no existing repoConfig) manager wizard needs to reach the
 * installation picker, and past it into the repo picker once clicked. */
const FRESH_WIZARD_ROUTES = {
  "/api/v1/me": ok(ME_SIGNED_IN),
  ...projectRoutes(null),
  "/api/v1/github/installations": INSTALLATIONS_POPULATED,
  [REPOS_PATH]: ok({ configured: true, repos: SAMPLE_REPOS }),
  [BRANCHES_PATH]: BRANCHES_OK,
}

// ---------------------------------------------------------------------------
// Driven-interaction plumbing. Every wizard/dialog step below is reached by
// clicking through the SAME UI a user would — none of these steps has a prop
// that jumps straight to it. Scoped to `[role="dialog"]` throughout: the
// panel always renders inside `DialogFrame`'s real Dialog here, and an
// unscoped query would also match `[data-slot="list-row"]` / `[role="dialog"]`
// elements from any ambient gallery chrome around this fixture.
// ---------------------------------------------------------------------------

function dialogRoot(): ParentNode {
  return document.querySelector('[role="dialog"]') ?? document
}

/** Select-then-commit (2026-08-29): the pickers are radio cards now, so
 * advancing a step is two clicks — the card, then the footer's Next. */
async function pickInstallationRow(isCancelled: () => boolean): Promise<boolean> {
  const card = await waitForElement(
    () => findByText<HTMLLabelElement>('[data-slot="option-card"]', /acme/, dialogRoot()),
    { isCancelled },
  )
  if (isCancelled() || !card) return false
  clickLikeUser(card)
  const next = await waitForElement(() => findButtonByText(/^Next$/, dialogRoot()), { isCancelled })
  if (isCancelled() || !next) return false
  clickLikeUser(next)
  return true
}

async function pickRepoRow(isCancelled: () => boolean): Promise<boolean> {
  const card = await waitForElement(
    () => findByText<HTMLLabelElement>('[data-slot="option-card"]', /ai-gateway-prototype/, dialogRoot()),
    { isCancelled },
  )
  if (isCancelled() || !card) return false
  clickLikeUser(card)
  const next = await waitForElement(() => findButtonByText(/^Next$/, dialogRoot()), { isCancelled })
  if (isCancelled() || !next) return false
  clickLikeUser(next)
  return true
}

/** Installation → repo, landing on the build form. Shared by every
 * build-form fixture below so each one only adds what makes IT distinct. */
async function reachFreshBuildForm(isCancelled: () => boolean): Promise<boolean> {
  if (!(await pickInstallationRow(isCancelled))) return false
  if (!(await pickRepoRow(isCancelled))) return false
  return true
}

/** The outer "Disconnect" ghost button — present before the confirm dialog
 * opens, when it's the only element with this text. */
function BaseDialog({
  ctx,
  routes,
  title = REPO_DIALOG_TITLE,
  children,
}: {
  ctx: SurfaceRenderContext
  routes: Record<string, ReturnType<typeof ok> | ReturnType<typeof fail> | typeof PENDING | typeof NETWORK_ERROR>
  title?: string
  children?: React.ReactNode
}) {
  // The Add-project states render the REAL step-two body — the
  // GitHub-repo/Upload tabs (`AddPrototypeSource`) — not the bare panel.
  // The first cut mounted only the panel here and the gallery silently
  // showed an Add dialog with no tabs (Mo, 2026-08-29: "I don't see the
  // tabs"). Derived from the title because the title is already what marks
  // an add-flow state, at every call site.
  const isAddFlow = title === ADD_DIALOG_TITLE
  // The hosts' App-setup STEP, mirrored (Mo, 2026-08-29: the setup is its
  // own dialog view, not content inside the tabbed screen) — same state,
  // same title switch, same `GithubAccessSetupStep`.
  const [settingUpGithub, setSettingUpGithub] = useState(false)
  return (
    <DialogFrame
      title={settingUpGithub ? "Set up GitHub access" : title}
      description={
        settingUpGithub
          ? GITHUB_APP_SETUP_INTRO
          : isAddFlow
            ? "Where the project comes from: a GitHub repository, or a build you upload."
            : undefined
      }
      onOpenChange={(open) => ctx.log("onOpenChange", open)}
    >
      <Scenario routes={routes}>
        {/* `onClose` mirrors what every real host passes — without it the
            footer's Cancel/Close (gated on the prop) never renders here and
            the gallery shows a dialog the product no longer has. */}
        {settingUpGithub ? (
          <GithubAccessSetupStep
            onBack={() => setSettingUpGithub(false)}
            onClose={() => ctx.log("onClose")}
            returnTo={`/?connect=${PID}`}
          />
        ) : isAddFlow ? (
          <AddPrototypeSource
            projectId={PID}
            onClose={() => ctx.log("onClose")}
            returnPath={`/?connect=${PID}`}
            onSetUpGithub={() => setSettingUpGithub(true)}
            onUploaded={() => ctx.log("onUploaded")}
          />
        ) : (
          <ProjectRepoPanel
            projectId={PID}
            onClose={() => ctx.log("onClose")}
            onSetUpGithub={() => setSettingUpGithub(true)}
          />
        )}
      </Scenario>
      {children}
    </DialogFrame>
  )
}

/** Clicks the Upload tab. While the GitHub tab is active there is exactly one
 * button reading "Upload" — the trigger; the submit only mounts after. */
function WizardUploadTabFixture({ ctx }: { ctx: SurfaceRenderContext }) {
  useEffect(() => {
    let cancelled = false
    const isCancelled = () => cancelled
    runDrivenInteraction(async () => {
      const trigger = await waitForElement(
        () => findButtonByText(/^Upload$/, dialogRoot()),
        { isCancelled },
      )
      if (isCancelled() || !trigger) return
      clickLikeUser(trigger)
    })
    return () => {
      cancelled = true
    }
  }, [])
  return (
    <BaseDialog
      ctx={ctx}
      title={ADD_DIALOG_TITLE}
      routes={{
        "/api/v1/me": ok(ME_SIGNED_IN),
        ...projectRoutes(null),
        "/api/v1/github/installations": INSTALLATIONS_POPULATED,
      }}
    />
  )
}

/** Clicks through the not-configured empty state into the App-setup form. */
function WizardGithubSetupFixture({ ctx }: { ctx: SurfaceRenderContext }) {
  useEffect(() => {
    let cancelled = false
    const isCancelled = () => cancelled
    runDrivenInteraction(async () => {
      const btn = await waitForElement(
        () => findButtonByText(/^Set up GitHub access$/, dialogRoot()),
        { isCancelled },
      )
      if (isCancelled() || !btn) return
      clickLikeUser(btn)
    })
    return () => {
      cancelled = true
    }
  }, [])
  return (
    <BaseDialog
      ctx={ctx}
      title={ADD_DIALOG_TITLE}
      routes={{
        "/api/v1/me": ok(ME_SIGNED_IN),
        ...projectRoutes(null),
        "/api/v1/github/installations": INSTALLATIONS_NOT_CONFIGURED,
        "/api/v1/setup/github/manifest": SAMPLE_MANIFEST_RESPONSE,
      }}
    />
  )
}

function WizardLoadingReposFixture({ ctx }: { ctx: SurfaceRenderContext }) {
  useEffect(() => {
    let cancelled = false
    runDrivenInteraction(async () => {
      await pickInstallationRow(() => cancelled)
    })
    return () => {
      cancelled = true
    }
  }, [])
  return (
    <BaseDialog
      ctx={ctx}
      title={ADD_DIALOG_TITLE}
      routes={{
        "/api/v1/me": ok(ME_SIGNED_IN),
        ...projectRoutes(null),
        "/api/v1/github/installations": INSTALLATIONS_POPULATED,
        [REPOS_PATH]: PENDING,
      }}
    />
  )
}

function WizardNoReposFixture({ ctx }: { ctx: SurfaceRenderContext }) {
  useEffect(() => {
    let cancelled = false
    runDrivenInteraction(async () => {
      await pickInstallationRow(() => cancelled)
    })
    return () => {
      cancelled = true
    }
  }, [])
  return (
    <BaseDialog
      ctx={ctx}
      title={ADD_DIALOG_TITLE}
      routes={{
        "/api/v1/me": ok(ME_SIGNED_IN),
        ...projectRoutes(null),
        "/api/v1/github/installations": INSTALLATIONS_POPULATED,
        [REPOS_PATH]: ok({ configured: true, repos: [] }),
      }}
    />
  )
}

function WizardRepoPickerFixture({ ctx }: { ctx: SurfaceRenderContext }) {
  useEffect(() => {
    let cancelled = false
    runDrivenInteraction(async () => {
      await pickInstallationRow(() => cancelled)
    })
    return () => {
      cancelled = true
    }
  }, [])
  return <BaseDialog ctx={ctx} title={ADD_DIALOG_TITLE} routes={FRESH_WIZARD_ROUTES} />
}

function BuildFormFreshFixture({ ctx }: { ctx: SurfaceRenderContext }) {
  useEffect(() => {
    let cancelled = false
    runDrivenInteraction(async () => {
      await reachFreshBuildForm(() => cancelled)
    })
    return () => {
      cancelled = true
    }
  }, [])
  return <BaseDialog ctx={ctx} title={ADD_DIALOG_TITLE} routes={FRESH_WIZARD_ROUTES} />
}

/**
 * All four fields invalid at once, rather than the audit's four separate
 * states — `Field`'s error rendering is identical from field to field, so one
 * state showing every error line together demonstrates the pattern better
 * than four screens that differ by which single line is red.
 */
function BuildFormErrorsFixture({ ctx }: { ctx: SurfaceRenderContext }) {
  useEffect(() => {
    let cancelled = false
    runDrivenInteraction(async () => {
      if (!(await reachFreshBuildForm(() => cancelled))) return
      const branch = await waitForElement(() => document.getElementById("repo-branch") as HTMLInputElement | null, { isCancelled: () => cancelled })
      const install = document.getElementById("repo-install-command") as HTMLInputElement | null
      const build = document.getElementById("repo-build-command") as HTMLInputElement | null
      const output = document.getElementById("repo-output-dir") as HTMLInputElement | null
      if (cancelled || !branch || !install || !build || !output) return
      // Argument-injection-shaped branch (leading `-`), whitespace-only
      // commands, and a leading-slash output dir — one failure mode per field.
      setNativeValue(branch, "-invalid..branch")
      setNativeValue(install, " ")
      setNativeValue(build, " ")
      setNativeValue(output, "/etc/escape")
    })
    return () => {
      cancelled = true
    }
  }, [])
  return <BaseDialog ctx={ctx} title={ADD_DIALOG_TITLE} routes={FRESH_WIZARD_ROUTES} />
}

function BuildFormEmptyFieldGapFixture({ ctx }: { ctx: SurfaceRenderContext }) {
  useEffect(() => {
    let cancelled = false
    runDrivenInteraction(async () => {
      if (!(await reachFreshBuildForm(() => cancelled))) return
      const branch = await waitForElement(() => document.getElementById("repo-branch") as HTMLInputElement | null, { isCancelled: () => cancelled })
      if (cancelled || !branch) return
      setNativeValue(branch, "")
    })
    return () => {
      cancelled = true
    }
  }, [])
  return <BaseDialog ctx={ctx} title={ADD_DIALOG_TITLE} routes={FRESH_WIZARD_ROUTES} />
}

function BuildFormSubmittingFixture({ ctx }: { ctx: SurfaceRenderContext }) {
  useEffect(() => {
    let cancelled = false
    runDrivenInteraction(async () => {
      if (!(await reachFreshBuildForm(() => cancelled))) return
      const submit = await waitForElement(() => findButtonByText(/^Connect$/, dialogRoot()), { isCancelled: () => cancelled })
      if (cancelled || !submit) return
      clickLikeUser(submit)
    })
    return () => {
      cancelled = true
    }
  }, [])
  return (
    <BaseDialog
      ctx={ctx}
      title={ADD_DIALOG_TITLE}
      routes={{ ...FRESH_WIZARD_ROUTES, [`PUT /api/v1/projects/${PID}/repo`]: PENDING }}
    />
  )
}

function BuildFormSubmitErrorFixture({ ctx }: { ctx: SurfaceRenderContext }) {
  useEffect(() => {
    let cancelled = false
    runDrivenInteraction(async () => {
      if (!(await reachFreshBuildForm(() => cancelled))) return
      const submit = await waitForElement(() => findButtonByText(/^Connect$/, dialogRoot()), { isCancelled: () => cancelled })
      if (cancelled || !submit) return
      clickLikeUser(submit)
    })
    return () => {
      cancelled = true
    }
  }, [])
  return (
    <BaseDialog
      ctx={ctx}
      title={ADD_DIALOG_TITLE}
      routes={{
        ...FRESH_WIZARD_ROUTES,
        /* Plain words (Mo, 2026-08-30: "default branch's remote is a bit
           technical") — the dialog renders a 422's prose verbatim, so what
           this mock says is exactly what the reviewer grades. */
        [`PUT /api/v1/projects/${PID}/repo`]: fail(422, "That branch was not found in the repository."),
      }}
    />
  )
}

export const PROJECT_REPO_PANEL_SURFACE: SurfaceEntry = {
  id: "project-repo-panel",
  title: "Repo dialog",
  kind: "modal",
  sourceFile: "viewer/app/project-repo-panel.tsx",
  states: [
    {
      id: "project-repo-panel/loading",
      label: "Loading",
      render: (ctx) => (
        <BaseDialog
          ctx={ctx}
          routes={{
            "/api/v1/me": PENDING,
            ...Object.fromEntries(Object.entries(projectRoutes(null)).map(([path]) => [path, PENDING])),
          }}
        />
      ),
    },
    {
      id: "project-repo-panel/load-error",
      label: "Couldn't load repo settings",
      render: (ctx) => (
        <BaseDialog
          ctx={ctx}
          routes={{ "/api/v1/me": ok(ME_SIGNED_IN), [`/api/v1/projects/${PID}`]: NETWORK_ERROR }}
        />
      ),
    },
    {
      // The audit lists 4 signed-out variants (auth on/off × connected/not).
      // Auth-disabled swaps one line of copy for another; "connected" swaps
      // in `ConnectedInfoCard`, which is already the subject of the
      // can-manage-connected state below. This is the one that most reviewers
      // hit — signed out, auth configured, nothing connected yet.
      id: "project-repo-panel/signed-out",
      label: "Signed out",
      render: (ctx) => (
        <BaseDialog ctx={ctx} routes={{ "/api/v1/me": ok(ME_SIGNED_OUT), ...projectRoutes(null) }} />
      ),
    },
    {
      // viewer-membership Fix wave 4 (codex round-4): the signed-out CTA
      // used to key off `authEnabled` (GitHub-only), so a deployment with no
      // GitHub App but email sign-in configured showed the "not configured"
      // copy here instead of a working "Sign in" link. `authEnabled: false`
      // + `emailSignInEnabled: true` is exactly that deployment shape.
      id: "project-repo-panel/signed-out-email-only",
      label: "Signed out — email sign-in only, no GitHub App (CTA still offered)",
      render: (ctx) => (
        <BaseDialog
          ctx={ctx}
          routes={{
            "/api/v1/me": ok({ user: null, authEnabled: false, signInUrl: null, emailSignInEnabled: true }),
            ...projectRoutes(null),
          }}
        />
      ),
    },
    {
      id: "project-repo-panel/read-only-no-repo",
      label: "Read-only (viewer role) — no repo connected",
      render: (ctx) => (
        <BaseDialog
          ctx={ctx}
          routes={{ "/api/v1/me": ok({ user: READ_ONLY_USER, authEnabled: true }), ...projectRoutes(null) }}
        />
      ),
    },
    {
      // Also covers the Auto-deploy "Off" row — see
      // `REPO_CONFIG_NO_AUTO_DEPLOY`'s comment above.
      id: "project-repo-panel/read-only-connected",
      label: "Read-only (viewer role) — repo connected, no controls",
      render: (ctx) => (
        <BaseDialog
          ctx={ctx}
          routes={{
            "/api/v1/me": ok({ user: READ_ONLY_USER, authEnabled: true }),
            ...projectRoutes(REPO_CONFIG_NO_AUTO_DEPLOY),
          }}
        />
      ),
    },
    {
      // Lands straight on the settings form (the auto-edit effect fires the
      // moment `configured: true` resolves) — there is no read-only card for
      // this caller any more. Also the "Save is disabled until something
      // changes" state: the form is pre-filled from the saved connection and
      // untouched, so the button has nothing to write. Absorbed the old
      // `wizard-build-form-edit` state, which reached this same render
      // through a `clickEdit` driver that had silently become a no-op.
      id: "project-repo-panel/can-manage-connected",
      label: "Can manage — connected, App configured (lands on the settings form, Save disabled until dirty)",
      readyWhen: '[role="dialog"] [data-slot="field"]',
      render: (ctx) => (
        <BaseDialog
          ctx={ctx}
          routes={{
            "/api/v1/me": ok(ME_SIGNED_IN),
            ...projectRoutes(SAMPLE_REPO_CONFIG),
            [BRANCHES_PATH]: BRANCHES_OK,
            "/api/v1/github/installations": INSTALLATIONS_CONFIGURED_EMPTY,
          }}
        />
      ),
    },
    {
      id: "project-repo-panel/can-manage-connected-app-not-configured",
      label: "Can manage — connected, but the App config was lost (banner names the fix, Close only)",
      render: (ctx) => (
        <BaseDialog
          ctx={ctx}
          routes={{
            "/api/v1/me": ok(ME_SIGNED_IN),
            ...projectRoutes(SAMPLE_REPO_CONFIG),
            [BRANCHES_PATH]: BRANCHES_OK,
            "/api/v1/github/installations": INSTALLATIONS_NOT_CONFIGURED,
          }}
        />
      ),
    },
    {
      // viewer-membership Fix wave 4 (codex round-4): a member signed in via
      // invite/magic link on this SMTP-only instance manages their connected
      // repo exactly like a GitHub-signed-in caller — `derivePanelAccess`
      // never looked at `authEnabled` to begin with, so this state is a
      // regression guard for the fix above, not a state that was ever
      // showing the wrong thing.
      id: "project-repo-panel/signed-in-email-only-instance",
      label: "Signed in via invite/magic link, no GitHub App on this instance",
      render: (ctx) => (
        <BaseDialog
          ctx={ctx}
          routes={{
            "/api/v1/me": ok(ME_SIGNED_IN_EMAIL_ONLY),
            ...projectRoutes(SAMPLE_REPO_CONFIG),
            "/api/v1/github/installations": INSTALLATIONS_NOT_CONFIGURED,
          }}
        />
      ),
    },
    {
      // The audit's "visual gap" state, closed 2026-08-29 and repurposed to
      // prove the fix: the installations check FAILS (`githubConfigured`
      // stays `null`), and instead of the old silent dead end — a disabled
      // Edit with no explanation — the card now shows the failure and a
      // footer Retry. (The pure still-loading variant is the same card with
      // just Close, transient, not worth a state.)
      id: "project-repo-panel/can-manage-connected-github-unknown",
      label: "Can manage — connected, GitHub status check failed (error shown, Retry offered)",
      render: (ctx) => (
        <BaseDialog
          ctx={ctx}
          routes={{
            "/api/v1/me": ok(ME_SIGNED_IN),
            ...projectRoutes(SAMPLE_REPO_CONFIG),
            [BRANCHES_PATH]: BRANCHES_OK,
            "/api/v1/github/installations": NETWORK_ERROR,
          }}
        />
      ),
    },
    {
      // Fresh connect vs. editing-a-connection ("Cancel" shown) look
      // identical apart from that one ghost button — not worth a second
      // state. This is the fresh-connect shape, which is also how a brand
      // new project reaches the wizard at all (no repo → no Cancel target).
      //
      // The old "no App means no way in" gap is closed (2026-08-29): the
      // Add-project dialog wraps this panel in a GitHub-repo/Upload tab
      // pair (`AddPrototypeSource`, rendered by `BaseDialog` for every
      // add-flow state here), so a deployment with no GitHub App can still
      // take a project through the Upload tab.
      id: "project-repo-panel/wizard-not-configured",
      label: "Wizard: GitHub not set up — empty state, Admin offered the setup step",
      readyWhen: '[role="dialog"] [data-slot="empty-state"]',
      render: (ctx) => (
        <BaseDialog
          ctx={ctx}
          title={ADD_DIALOG_TITLE}
          routes={{
            "/api/v1/me": ok(ME_SIGNED_IN),
            ...projectRoutes(null),
            "/api/v1/github/installations": INSTALLATIONS_NOT_CONFIGURED,
            "/api/v1/setup/github/manifest": SAMPLE_MANIFEST_RESPONSE,
          }}
        />
      ),
    },
    {
      id: "project-repo-panel/wizard-upload-tab",
      label: "Wizard: the Upload tab — a build instead of a repository",
      readyWhen: '[data-testid="upload-bundle-submit"]',
      render: (ctx) => <WizardUploadTabFixture ctx={ctx} />,
    },
    {
      // The step behind that empty state's button: the deployment-wide App
      // setup as its OWN dialog view — its own title, no tabs (Mo,
      // 2026-08-29: another step in the flow).
      id: "project-repo-panel/wizard-not-configured-setup",
      label: "Wizard: GitHub not set up — Admin clicked Set up GitHub access (own step)",
      readyWhen: '[data-slot="option-card"]',
      render: (ctx) => <WizardGithubSetupFixture ctx={ctx} />,
    },
    {
      // The same deployment state seen by someone who cannot fix it: the
      // wizard says who can (an Admin, from Settings) instead of offering a
      // flow the server would refuse.
      id: "project-repo-panel/wizard-not-configured-non-admin",
      label: "Wizard: GitHub not set up — seen by an Editor",
      readyWhen: '[role="dialog"]',
      render: (ctx) => (
        <BaseDialog
          ctx={ctx}
          title={ADD_DIALOG_TITLE}
          routes={{
            "/api/v1/me": ok(ME_SIGNED_IN_EMAIL_ONLY),
            ...projectRoutes(null),
            "/api/v1/github/installations": INSTALLATIONS_NOT_CONFIGURED,
          }}
        />
      ),
    },
    {
      id: "project-repo-panel/wizard-loading-installations",
      label: "Wizard: checking GitHub App installations",
      render: (ctx) => (
        <BaseDialog
          ctx={ctx}
          title={ADD_DIALOG_TITLE}
          routes={{ "/api/v1/me": ok(ME_SIGNED_IN), ...projectRoutes(null), "/api/v1/github/installations": PENDING }}
        />
      ),
    },
    {
      id: "project-repo-panel/wizard-installations-error",
      label: "Wizard: checking installations — request failed",
      render: (ctx) => (
        <BaseDialog
          ctx={ctx}
          title={ADD_DIALOG_TITLE}
          routes={{
            "/api/v1/me": ok(ME_SIGNED_IN),
            ...projectRoutes(null),
            "/api/v1/github/installations": NETWORK_ERROR,
          }}
        />
      ),
    },
    {
      id: "project-repo-panel/wizard-installations-stale",
      label: "Wizard: sign in again to refresh GitHub access",
      render: (ctx) => (
        <BaseDialog
          ctx={ctx}
          title={ADD_DIALOG_TITLE}
          routes={{ "/api/v1/me": ok(ME_SIGNED_IN), ...projectRoutes(null), "/api/v1/github/installations": INSTALLATIONS_STALE }}
        />
      ),
    },
    {
      // Carries `installationsSyncedAt`, so this also demonstrates the
      // "checked N ago" note — the audit's separate no-note variant is the
      // same layout minus one sentence.
      id: "project-repo-panel/wizard-no-installations",
      label: "Wizard: no GitHub App installations found",
      render: (ctx) => (
        <BaseDialog
          ctx={ctx}
          title={ADD_DIALOG_TITLE}
          routes={{
            "/api/v1/me": ok(ME_SIGNED_IN),
            ...projectRoutes(null),
            "/api/v1/github/installations": INSTALLATIONS_CONFIGURED_EMPTY,
          }}
        />
      ),
    },
    {
      id: "project-repo-panel/wizard-installation-picker",
      label: "Wizard: choose an installation",
      render: (ctx) => (
        <BaseDialog
          ctx={ctx}
          title={ADD_DIALOG_TITLE}
          routes={{
            "/api/v1/me": ok(ME_SIGNED_IN),
            ...projectRoutes(null),
            "/api/v1/github/installations": INSTALLATIONS_POPULATED,
          }}
        />
      ),
    },
    {
      // `:not(.font-medium)` is what tells this apart from the installation
      // picker's own heading, which shares `text-xs text-muted-foreground`
      // but adds `font-medium` — both stages render before either has a
      // `data-slot` or test id to key off.
      id: "project-repo-panel/wizard-loading-repos",
      label: "Wizard: loading repositories for the chosen installation",
      /* The wait is `ProjectLoader` since 2026-08-29, not a line of grey
         text, so this waits on the loader's own slot. The old selector
         matched on CLASS SHAPE — `p.text-xs.text-muted-foreground:not(
         .font-medium)` — which is a description of styling rather than of
         the thing, and it broke the moment the styling changed. */
      readyWhen: '[role="dialog"] [data-testid="project-loader"]',
      render: (ctx) => <WizardLoadingReposFixture ctx={ctx} />,
    },
    {
      id: "project-repo-panel/wizard-no-repos",
      label: "Wizard: installation has no repos granted",
      readyWhen: '[role="dialog"] [data-slot="empty-state"]',
      render: (ctx) => <WizardNoReposFixture ctx={ctx} />,
    },
    {
      id: "project-repo-panel/wizard-repo-picker",
      label: "Wizard: choose a repository (mix of public/private)",
      /* The private marker is an `OptionCard` hint since the radio-card
         rework (2026-08-29), not a Badge — wait on the cards themselves. */
      readyWhen: '[role="dialog"] [data-slot="option-card"]',
      render: (ctx) => <WizardRepoPickerFixture ctx={ctx} />,
    },
    {
      id: "project-repo-panel/wizard-build-form",
      label: "Wizard build form: freshly picked repo, valid, idle",
      readyWhen: '[role="dialog"] [data-slot="field"]',
      render: (ctx) => <BuildFormFreshFixture ctx={ctx} />,
    },
    {
      id: "project-repo-panel/wizard-build-form-errors",
      label: "Wizard build form: every field invalid",
      readyWhen: '[role="dialog"] p.text-xs.text-destructive',
      render: (ctx) => <BuildFormErrorsFixture ctx={ctx} />,
    },
    {
      // The other documented visual gap: an emptied required field fails
      // validation and disables Submit, but the Field's error line is gated
      // on the value being non-empty, so no red text explains why.
      id: "project-repo-panel/wizard-build-form-empty-field-gap",
      label: "Wizard build form: cleared field — Submit disabled, no visible reason (visual gap)",
      readyWhen: '[role="dialog"] button:disabled',
      render: (ctx) => <BuildFormEmptyFieldGapFixture ctx={ctx} />,
    },
    {
      id: "project-repo-panel/wizard-build-form-submitting",
      label: "Wizard build form: submitting",
      readyWhen: '[role="dialog"] button:disabled',
      render: (ctx) => <BuildFormSubmittingFixture ctx={ctx} />,
    },
    {
      id: "project-repo-panel/wizard-build-form-submit-error",
      label: "Wizard build form: submit failed",
      readyWhen: '[role="dialog"] [role="status"]',
      render: (ctx) => <BuildFormSubmitErrorFixture ctx={ctx} />,
    },
  ],
}
