import { NeverDeployed } from "../../app/review/[slug]/never-deployed"
import type { ProjectSummary } from "../../app/review/[slug]/page"
import { Scenario } from "../harness/scenario"
import {
  ME_SIGNED_IN,
  SAMPLE_BUILD_LOG,
  SAMPLE_FAILED_BUILD_LOG,
  SAMPLE_PROJECT,
  SAMPLE_REPO_CONFIG,
  SAMPLE_USER,
  sampleDeployment,
  sampleRunningBuildSteps,
} from "../harness/fixture-data"
import { fail, ok, type FetchOverrideResult } from "@/components/gallery/fetch-override"
import { setGalleryConfig } from "../harness/shims/server-config"
import type { SurfaceEntry } from "@/components/gallery/types"

/**
 * What a project nobody has built yet shows on its own review route.
 *
 * Added 2026-09-01 with the page itself. Before that this state had no
 * screen at all: the review route 404'd for an undeployed project, and the
 * dashboard rendered its card as a DISABLED control, which says "you are not
 * allowed" about something that is merely empty (Mo).
 *
 * Since 2026-09-10 the page also shows the FIRST BUILD (Mo). A first connect
 * starts building on the server and the Add dialog sends the reader here, so
 * this is where that build is watched: running with its log, failed with the
 * log open, or Deploy for a connected repository with no build. The states
 * below are every answer `decideNeverDeployedView` can give, plus the Viewer,
 * who gets a way back and nothing else. That is honest rather than grudging:
 * there is genuinely nothing for them to do here.
 */

const UNDEPLOYED: ProjectSummary = {
  id: "1f0c9d2e-4b7a-4c1d-9e83-2a6f5b0c7d41",
  slug: "acme-checkout",
  name: "Acme Checkout",
  activeDeploymentId: null,
  access: "all-members",
}

/** A signed-in EDITOR: can manage, so the build states are shown. */
const ME_EDITOR = { ...ME_SIGNED_IN, user: { ...SAMPLE_USER, role: "editor" as const } }

/** A signed-in VIEWER: cannot build, so only the way back is offered. */
const ME_VIEWER = { ...ME_SIGNED_IN, user: { ...SAMPLE_USER, role: "viewer" as const } }

/**
 * The page reads four endpoints: the caller's role (`/me`), whether this
 * deployment has a GitHub App at all (`/github/installations`), the project
 * record for its `repoConfig`, and the newest build. All four are answered
 * here so every state is the fixture's decision rather than a fetch that
 * happens to fail or a baseline default that happens to fit.
 */
const GITHUB_CONFIGURED = ok({ configured: true, installations: [] })
const PROJECT_PATH = `/api/v1/projects/${UNDEPLOYED.id}`
const DEPLOYMENTS_PATH = `${PROJECT_PATH}/deployments`

function project(hasRepo: boolean) {
  return ok({
    ...SAMPLE_PROJECT,
    id: UNDEPLOYED.id,
    slug: UNDEPLOYED.slug,
    name: UNDEPLOYED.name,
    activeDeploymentId: null,
    activeDeployment: null,
    ...(hasRepo ? { repoConfig: SAMPLE_REPO_CONFIG } : {}),
  })
}

function managerRoutes({
  hasRepo = true,
  deployments = [] as ReturnType<typeof sampleDeployment>[],
  projectResponse,
}: {
  hasRepo?: boolean
  deployments?: ReturnType<typeof sampleDeployment>[]
  projectResponse?: FetchOverrideResult
} = {}): Record<string, FetchOverrideResult> {
  return {
    "/api/v1/me": ok(ME_EDITOR),
    "/api/v1/github/installations": GITHUB_CONFIGURED,
    [PROJECT_PATH]: projectResponse ?? project(hasRepo),
    [DEPLOYMENTS_PATH]: ok({ deployments }),
  }
}

function state(routes: Record<string, FetchOverrideResult>) {
  setGalleryConfig({})
  return (
    <Scenario routes={routes}>
      <NeverDeployed project={UNDEPLOYED} />
    </Scenario>
  )
}

export const REVIEW_NEVER_DEPLOYED_SURFACE: SurfaceEntry = {
  id: "review-never-deployed",
  title: "Review — never deployed",
  kind: "page",
  sourceFile: "viewer/app/review/[slug]/never-deployed.tsx",
  states: [
    {
      id: "review-never-deployed/viewer-role",
      label: "Viewer — can look, cannot build, and is offered nothing",
      render: () =>
        state({
          "/api/v1/me": ok(ME_VIEWER),
          "/api/v1/github/installations": GITHUB_CONFIGURED,
        }),
    },
    {
      id: "review-never-deployed/connect",
      label: "Editor — no repository yet, offered the way to connect one",
      render: () => state(managerRoutes({ hasRepo: false })),
    },
    {
      id: "review-never-deployed/deploy",
      label: "Editor — repository connected, no build yet, offered Deploy",
      readyWhen: '[data-testid="first-deploy-button"]',
      render: () => state(managerRoutes()),
    },
    {
      id: "review-never-deployed/building",
      label: "Editor — the first build is running (the loader, not a still picture), log closed",
      render: () =>
        state(
          managerRoutes({
            deployments: [
              sampleDeployment({
                id: "dep-420",
                status: "building",
                commitSha: null,
                commitMessage: null,
                buildLog: SAMPLE_BUILD_LOG.split("\n").slice(0, 6).join("\n"),
                steps: sampleRunningBuildSteps(),
              }),
            ],
          }),
        ),
    },
    {
      id: "review-never-deployed/failed",
      label: "Editor — the first build failed, log open, offered Try again",
      readyWhen: '[data-testid="first-deploy-button"]',
      render: () =>
        state(
          managerRoutes({
            deployments: [
              sampleDeployment({
                id: "dep-421",
                status: "failed",
                commitSha: null,
                commitMessage: null,
                buildLog: SAMPLE_FAILED_BUILD_LOG,
              }),
            ],
          }),
        ),
    },
    {
      id: "review-never-deployed/built-elsewhere",
      label: "Editor — a finished build this page did not watch, offered the link (no reload loop)",
      render: () => state(managerRoutes({ deployments: [sampleDeployment({ id: "dep-422" })] })),
    },
    {
      id: "review-never-deployed/load-failed",
      label: "Editor — the project record failed to load",
      render: () =>
        state(managerRoutes({ projectResponse: fail(500, "Couldn't load the prototype.") })),
    },
  ],
}
