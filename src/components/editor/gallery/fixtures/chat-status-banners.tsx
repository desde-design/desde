"use client"

import { useEffect } from "react"
import { ChatStatusBanners } from "@/components/editor/chat-status-banners"
import type { ChatMessage } from "@/hooks/useEditorChat"
import type { SurfaceEntry, SurfaceRenderContext } from "../types"
import { clickLikeUser, runDrivenInteraction, waitForElement } from "./dom-interaction"
import { InlineFrame } from "./inline-frame"

/**
 * The six non-conversational `ChatMessage` kinds, each rendered on its own.
 *
 * `ChatStatusBanners` takes the WHOLE `chat.messages` array and silently
 * ignores `user`/`assistant` entries, so a fixture is just the one status
 * message it wants to look at. Every payload below is shaped from the union in
 * `src/hooks/useEditorChat.ts` — these banners are the surface a designer sees
 * when something has gone sideways mid-turn, which is exactly the category
 * this catalog exists to expose.
 *
 * `resetsAt` is computed relative to now rather than hardcoded: the banner
 * renders it through `formatResetTime`, which collapses any past timestamp to
 * "shortly". A frozen epoch would therefore show the wrong copy the moment it
 * went stale, and the screenshot would stop matching the live product.
 */

const OVERWRITE: ChatMessage = {
  kind: "overwrite_warning",
  id: "msg-overwrite",
  file: "src/components/PricingCard.vue",
  hashAtRead: "a1b2c3d4",
  hashAtWrite: "9f8e7d6c",
  conflictingSessionId: "sess-bbbb2222",
  conflictingSessionPrompt: "Make the pricing cards use the brand accent",
}

const CAPABILITY_GAP: ChatMessage = {
  kind: "capability_gap",
  id: "msg-capability-gap",
  capabilityId: "figma",
  label: "Figma",
  detail: "https://figma.com/design/abc123/Checkout",
  requiresEnv: "FIGMA_API_KEY",
  envReady: false,
  activation: "next-message",
}

function banners(
  message: ChatMessage,
  ctx: SurfaceRenderContext,
  dismissible = true,
  onEnableCapability?: (
    capabilityId: string,
  ) => Promise<{ ok: boolean; envMissing?: string | null }>,
) {
  return (
    <InlineFrame>
      <ChatStatusBanners
        messages={[message]}
        onDismiss={dismissible ? (id) => ctx.log("onDismiss", id) : undefined}
        onEnableCapability={onEnableCapability}
      />
    </InlineFrame>
  )
}

/**
 * The gap banner's SUCCESS state lives behind its own `useState`: it is only
 * reachable by clicking "Enable Figma" and letting `onEnable` resolve. There
 * is no prop that sets it, so this fixture drives the real click, which is the
 * only honest way to see the `success` tone.
 *
 * The ready gate is the export hint, which appears only in the done branch.
 */
// Was `… code`, matching the `export FIGMA_API_KEY=…` line the success
// banner used to print. That line is gone (2026-08-18) — a key is entered in
// Extensions now — so the state is ready when the success Alert itself is up.
const CAPABILITY_ENABLED = '[data-testid="chat-status-banners"] [role="alert"]'

function CapabilityEnabledFixture({ ctx }: { ctx: SurfaceRenderContext }) {
  useEffect(() => {
    let cancelled = false
    runDrivenInteraction(async () => {
      const enable = await waitForElement(() =>
        document.querySelector<HTMLButtonElement>(
          '[data-testid="capability-gap-enable-figma"]',
        ),
      )
      if (cancelled || !enable) return
      clickLikeUser(enable)
    })
    return () => {
      cancelled = true
    }
  }, [])

  return banners(CAPABILITY_GAP, ctx, true, async (capabilityId) => {
    ctx.log("onEnableCapability", capabilityId)
    // Resolves with the key still missing, which is the honest half of this
    // banner: config is written, nothing works until the variable is exported.
    return { ok: true, envMissing: "FIGMA_API_KEY" }
  })
}

export const CHAT_STATUS_BANNERS_SURFACE: SurfaceEntry = {
  id: "chat-status-banners",
  title: "Chat status banners",
  kind: "inline",
  sourceFile: "src/components/editor/chat-status-banners.tsx",
  states: [
    {
      id: "chat-status-banners/error",
      label: "Turn failed",
      render: (ctx) =>
        banners(
          {
            kind: "error",
            id: "msg-error",
            // Verbatim from `describeVendorStop` in run-chat-turn-sdk.ts. It said
            // "The model stopped before finishing: max_tokens reached." until
            // 2026-08-18 — a request parameter's name, shown to someone who
            // never set one.
            reason:
              "The reply hit its length limit and stopped partway. Ask for the rest, or ask for it in smaller pieces.",
          },
          ctx,
        ),
    },
    {
      id: "chat-status-banners/queued",
      label: "Queued behind the in-flight cap",
      render: (ctx) => banners({ kind: "queued", id: "msg-queued", queuePosition: 2 }, ctx),
    },
    {
      id: "chat-status-banners/overwrite-warning",
      label: "Another session overwrote this file",
      render: (ctx) => banners(OVERWRITE, ctx),
    },
    {
      id: "chat-status-banners/overwrite-warning-no-dismiss",
      label: "Overwrite warning, no dismiss control",
      render: (ctx) => banners(OVERWRITE, ctx, false),
    },
    {
      id: "chat-status-banners/rate-limit-approaching",
      label: "Usage limit nearly reached",
      render: (ctx) =>
        banners(
          {
            kind: "rate_limit_warning",
            id: "msg-rate-warn",
            status: "allowed_warning",
            rateLimitType: "output_tokens",
            resetsAt: Date.now() + 4 * 60_000,
            utilization: 0.92,
          },
          ctx,
        ),
    },
    {
      id: "chat-status-banners/rate-limit-rejected",
      label: "Usage limit reached, request denied",
      render: (ctx) =>
        banners(
          {
            kind: "rate_limit_warning",
            id: "msg-rate-rejected",
            status: "rejected",
            rateLimitType: "output_tokens",
            resetsAt: Date.now() + 38 * 60_000,
            utilization: 1,
            overageStatus: "rejected",
          },
          ctx,
        ),
    },
    {
      id: "chat-status-banners/api-retry",
      label: "Retrying after a 429",
      render: (ctx) =>
        banners(
          {
            kind: "api_retry",
            id: "msg-retry",
            retryDelayMs: 4000,
            attempt: 2,
            maxRetries: 5,
            errorStatus: 429,
          },
          ctx,
        ),
    },
    {
      id: "chat-status-banners/capability-gap",
      label: "A capability the agent needs isn't enabled",
      render: (ctx) =>
        banners(CAPABILITY_GAP, ctx, true, async (capabilityId) => {
          ctx.log("onEnableCapability", capabilityId)
          return { ok: true, envMissing: null }
        }),
    },
    {
      id: "chat-status-banners/capability-enabled",
      label: "Capability enabled, key still missing",
      readyWhen: CAPABILITY_ENABLED,
      render: (ctx) => <CapabilityEnabledFixture ctx={ctx} />,
    },
    {
      id: "chat-status-banners/stacked",
      label: "Several at once",
      render: (ctx) => (
        <InlineFrame>
          <ChatStatusBanners
            messages={[
              { kind: "queued", id: "msg-queued", queuePosition: 1 },
              OVERWRITE,
              {
                kind: "api_retry",
                id: "msg-retry",
                retryDelayMs: 8000,
                attempt: 3,
                maxRetries: 5,
                errorStatus: 529,
              },
            ]}
            onDismiss={(id) => ctx.log("onDismiss", id)}
          />
        </InlineFrame>
      ),
    },
  ],
}
