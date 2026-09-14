"use client"

import { Button } from "@/components/ui/button"
import { Callout } from "@/components/blocks"

/**
 * Why a push is not going to produce a deployment, said on the tab where
 * someone goes looking for the deployment that never arrived.
 *
 * Two different causes, one shape, because the reader's question is the same
 * in both: I pushed, where is it?
 *
 *  - `off` — auto-deploy is switched off for this connection. A choice
 *    somebody made, and reversible in the repository settings.
 *  - `unreachable` — the deployment is on a local address, so GitHub was
 *    never given a webhook at all (see `server/webhook-reachability.ts`).
 *    Nothing about this one is a setting: the stored auto-deploy flag can
 *    read "On" while this is true, which is exactly the trap this banner
 *    exists to close.
 *
 * The action rides INSIDE the banner (Mo, 2026-09-14). There is already a
 * Deploy control in the repo section above, and that is deliberate rather
 * than an oversight: the one up there is an icon with no context, and this
 * one appears at the moment the reader has just learned that waiting will
 * not work. A reason with no way to act on it is half a message.
 */
export function AutoDeployBanner({
  reason,
  deploy,
}: {
  reason: "off" | "unreachable"
  /**
   * Omitted for a reader who cannot start a build. The explanation still
   * renders: knowing why nothing happened is useful even without the button,
   * and offering a control that refuses on click is the failure this panel
   * already has a rule about.
   */
  deploy?: {
    onDeploy: () => void
    /** The reason a build cannot start right now, or null. Carries to `title`. */
    blocked: string | null
    busy: boolean
  }
}) {
  return (
    <Callout tone="info" data-testid="auto-deploy-banner">
      <p>
        {reason === "unreachable"
          ? "A push will not rebuild this prototype. GitHub cannot reach a local address, so this deployment was set up without a push webhook."
          : "Auto-deploy is off for this connection, so a push will not rebuild this prototype."}
      </p>
      {deploy ? (
        /* Underneath the text, left-aligned with it: the sentence is what the
           reader came for, and a button beside it would compete with the
           first line for the eye. */
        <Button
          size="xs"
          variant="outline"
          className="mt-2"
          onClick={deploy.onDeploy}
          disabled={Boolean(deploy.blocked)}
          busy={deploy.busy}
          title={deploy.blocked ?? undefined}
          data-testid="auto-deploy-banner-deploy"
        >
          Deploy
        </Button>
      ) : null}
    </Callout>
  )
}
