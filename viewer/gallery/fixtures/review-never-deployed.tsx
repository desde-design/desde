import { NeverDeployed } from "../../app/review/[slug]/never-deployed"
import type { ProjectSummary } from "../../app/review/[slug]/page"
import { Scenario } from "../harness/scenario"
import { ME_SIGNED_IN, SAMPLE_USER } from "../harness/fixture-data"
import { ok } from "@/components/gallery/fetch-override"
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
 * The two states below are the whole point of the page and are worth being
 * able to look at side by side. The page is the same for both; only the
 * ACTION differs, because only one of these people can do anything about it.
 * A Viewer gets a way back and nothing else, which is honest rather than
 * grudging: there is genuinely nothing for them to do here.
 */

const UNDEPLOYED: ProjectSummary = {
  id: "1f0c9d2e-4b7a-4c1d-9e83-2a6f5b0c7d41",
  slug: "acme-checkout",
  name: "Acme Checkout",
  activeDeploymentId: null,
  access: "all-members",
}

/** A signed-in EDITOR: can manage, so the repo-connect action is offered. */
const ME_EDITOR = { ...ME_SIGNED_IN, user: { ...SAMPLE_USER, role: "editor" as const } }

/** A signed-in VIEWER: cannot build, so only the way back is offered. */
const ME_VIEWER = { ...ME_SIGNED_IN, user: { ...SAMPLE_USER, role: "viewer" as const } }

/**
 * `useBuildAccess` asks two questions: the caller's role (`/api/v1/me`) and
 * whether this deployment has a GitHub App at all
 * (`/api/v1/github/installations`). Both are answered here so the button
 * state is the fixture's decision rather than a fetch that happens to fail.
 */
const GITHUB_CONFIGURED = ok({ configured: true, installations: [] })

export const REVIEW_NEVER_DEPLOYED_SURFACE: SurfaceEntry = {
  id: "review-never-deployed",
  title: "Review — never deployed",
  kind: "page",
  sourceFile: "viewer/app/review/[slug]/never-deployed.tsx",
  states: [
    {
      id: "review-never-deployed/can-manage",
      label: "Editor — offered the way to fix it",
      render: () => {
        setGalleryConfig({})
        return (
          <Scenario
            routes={{
              "/api/v1/me": ok(ME_EDITOR),
              "/api/v1/github/installations": GITHUB_CONFIGURED,
            }}
          >
            <NeverDeployed project={UNDEPLOYED} />
          </Scenario>
        )
      },
    },
    {
      id: "review-never-deployed/viewer-role",
      label: "Viewer — can look, cannot build, and is not teased with a button",
      render: () => {
        setGalleryConfig({})
        return (
          <Scenario
            routes={{
              "/api/v1/me": ok(ME_VIEWER),
              "/api/v1/github/installations": GITHUB_CONFIGURED,
            }}
          >
            <NeverDeployed project={UNDEPLOYED} />
          </Scenario>
        )
      },
    },
  ],
}
