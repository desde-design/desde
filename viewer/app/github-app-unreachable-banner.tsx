"use client"

import { Callout } from "@/components/blocks"

/**
 * The App-config-lost banner: a repository is attached, but the deployment
 * holds no working GitHub App credentials, so nothing that goes through the
 * App — builds, editing the connection — can happen.
 *
 * ONE component for every surface that meets this state (the Repository
 * settings connected view, the Deployments tab), because it is one event and
 * had started growing a second look: the Deployments tab was rendering it as
 * a grey caption reading "builds are not enabled", which named a phantom
 * feature toggle instead of the cause (Mo, 2026-08-30). Generic on purpose —
 * the deployment cannot tell WHY the App is unreachable (credentials lost in
 * a redeploy, a database moved without the data directory's config.json), and
 * the two causes have opposite remedies, so the docs page carries the
 * debugging ladder rather than this banner overselling one fix.
 */
export function GithubAppUnreachableBanner() {
  return (
    <Callout tone="warning">
      This deployment can&apos;t connect to its GitHub App, so builds and edits are
      unavailable.{" "}
      <a
        href="https://desde.design/docs/viewer/github-app#the-viewer-cant-connect-to-its-github-app"
        target="_blank"
        rel="noreferrer"
        className="underline underline-offset-2 hover:no-underline"
        data-testid="repo-github-docs-link"
      >
        How to debug and fix this
      </a>
      .
    </Callout>
  )
}
