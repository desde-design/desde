"use client"

/**
 * Phase 1 of the assistant-ui chat migration.
 *
 * Renders the 5 non-conversational `ChatMessage` kinds as a vertical
 * strip of overlay banners, sitting OUTSIDE the assistant-ui thread
 * (spec decision #1). Only `error`, `queued`, `overwrite_warning`,
 * `rate_limit_warning`, and `api_retry` messages render here.
 * `user` / `assistant` messages are silently ignored so the caller
 * can safely pass the full `chat.messages` array.
 *
 * Visuals are ported verbatim from `MessageRow` in
 * `editor-chat-panel.tsx` (including the `formatResetTime` helper)
 * so that Phase 2's flag-gated panel swap produces no visual
 * regression on these status rows.
 */

import { useState, type ReactNode } from "react"
import { Loader2, X } from "lucide-react"
import { Alert } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { ChatMessage } from "@/hooks/useEditorChat"

// ---------------------------------------------------------------------------
// Tone
// ---------------------------------------------------------------------------
//
// Every banner below picks a NAMED `Alert` variant and writes no tint of its
// own. The recipe lives in `src/lib/tone-surface.ts` and reaches these banners
// only through `alertVariants`; see docs/design.md § "Banners".
//
// This file is where the rule came from. Of the eight banner states here, six
// hand-wrote `border-x/40 bg-x/10 text-x`, one (queued) wrote nothing and so
// rendered on `default`'s neutral card ground, and only the error banner named
// a variant. Because `Alert` shipped no warning/success/info variants,
// hand-writing was the only way to get a tone, so every new banner started
// white and stayed white unless its author remembered the incantation.

// ---------------------------------------------------------------------------
// Shared banner geometry
// ---------------------------------------------------------------------------

/**
 * The gutter that keeps banner text clear of the dismiss control.
 *
 * `DismissibleBanner` positions an `icon-xs` Button over the banner's
 * top-right corner, outside the Alert's own box, so the Alert has no way to
 * reserve the space itself. Every banner carries the gutter whether or not
 * `onDismiss` was passed: the alternative is text that reflows the moment a
 * caller supplies the handler.
 */
const BANNER_BASE = "mb-2 pr-7"

/**
 * The `Alert` variants these banners use.
 *
 * Named here so the dismiss control can be given the matching text colour —
 * see `DismissibleBanner`. Every banner still chooses its own variant; this
 * type is what keeps the two lists from drifting into unrelated strings.
 */
type BannerTone = "destructive" | "warning" | "success" | "info"

// ---------------------------------------------------------------------------
// Time-formatting helper — ported from editor-chat-panel.tsx
// ---------------------------------------------------------------------------

/**
 * Humanise the rate-limit `resetsAt` epoch-ms for the inline banner.
 * Renders as relative ("in 12s", "in 4m") for windows under an hour,
 * falls back to a clock time for longer windows. Defensive against
 * past timestamps / NaN — those collapse to "shortly" so the banner
 * never lies about timing.
 */
export function formatResetTime(resetsAtMs: number): string {
  if (!Number.isFinite(resetsAtMs)) return "shortly"
  const deltaMs = resetsAtMs - Date.now()
  if (deltaMs <= 0) return "shortly"
  const deltaSec = Math.round(deltaMs / 1000)
  // Words, not unit letters (Mo, 2026-08-18, whose own phrasing said
  // "38 mins"). `38m` is a token from a log line; these sentences are read
  // once, at a glance, by someone deciding whether to wait.
  if (deltaSec < 60) {
    return `in ${deltaSec} ${deltaSec === 1 ? "second" : "seconds"}`
  }
  if (deltaSec < 3600) {
    const mins = Math.round(deltaSec / 60)
    return `in ${mins} ${mins === 1 ? "min" : "mins"}`
  }
  const d = new Date(resetsAtMs)
  return `at ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`
}

// ---------------------------------------------------------------------------
// Per-kind banner components — ported from MessageRow in editor-chat-panel
// ---------------------------------------------------------------------------

/** The turn failed. Destructive: nothing continues until the user retries. */
function ErrorBanner({ message }: { message: Extract<ChatMessage, { kind: "error" }> }) {
  return (
    <Alert variant="destructive" className={BANNER_BASE}>
      {message.reason}
    </Alert>
  )
}

/**
 * Queued behind the in-flight cap.
 *
 * `info`, not `default`. This was the one white banner in the chat, and it is
 * the one Mo saw when he asked for the banners to be made consistent
 * (2026-08-14). Stacked above two amber warnings it read as an oversight
 * rather than as a decision, which is what a lone untinted box among tinted
 * ones always reads as.
 *
 * `info` rather than `warning` because nothing has gone wrong and nothing is
 * at risk: the turn will start on its own, and the user is being told to wait,
 * not asked to judge anything. Spending the warning colour here would leave a
 * real recoverable problem beside it looking identical.
 *
 * So `default` now means genuinely neutral chrome, and no banner uses it. That
 * is the honest end state: if a banner is worth showing, it is worth naming
 * what kind of thing it is.
 */
function QueuedBanner({
  message,
}: {
  message: Extract<ChatMessage, { kind: "queued" }>
}) {
  const posLabel =
    message.queuePosition > 1
      ? ` (position ${message.queuePosition} in line)`
      : ""
  return (
    <Alert variant="info" className={cn(BANNER_BASE, "flex items-center gap-1.5")}>
      <Loader2 className="size-2.5 animate-spin" aria-hidden="true" />
      <span>Waiting for an open chat slot{posLabel}</span>
    </Alert>
  )
}

function OverwriteWarningBanner({
  message,
}: {
  message: Extract<ChatMessage, { kind: "overwrite_warning" }>
}) {
  const conflictHint = message.conflictingSessionPrompt
    ? ` made by "${message.conflictingSessionPrompt}"`
    : " made by another chat session"
  /*
   * "Review in the save dialog" was WRONG and is gone (Mo asked, 2026-08-18:
   * "what is the save dialog this banner is referring to? I just want to make
   * sure this isn't incorrect").
   *
   * TRACED, and it is incorrect three times over. `SaveProgressDialog` is
   * driven by `editing.saving` / `editing.conflict` — the DIRECT-MANIPULATION
   * save path — and its conflict is the edit pipeline's external-edit
   * conflict, a different thing entirely. This banner comes from the CHAT
   * path: `edit_overwrite_warning` lands in `useEditorChat`, which pushes a
   * message and does nothing else. Nothing sets `editing.conflict`, the banner
   * carries no click target, and no sequence of clicks opens that dialog from
   * here. The type's own doc comment claims it "provides the entry point to
   * the save-dialog conflict UI"; no such entry point was ever built.
   *
   * So the copy now points at what actually exists. The write landed (that is
   * the auto-apply contract), so the file on disk is the thing to look at, and
   * in branch mode the user's own git diff is where the previous version still
   * is. Naming the other session is the useful half — it says whose work was
   * covered over.
   */
  return (
    <Alert variant="warning" className={BANNER_BASE}>
      {/* One span, not four loose children. Alert's base is a grid, so every
          inline child becomes its own ROW: without this wrapper the sentence
          rendered as a stack of fragments with the filename on its own line.
          The banners that pass `flex` avoid it by accident; a flowing
          sentence is one grid cell and should say so. */}
      <span>
        <span className="font-normal">Heads up</span>: this edit to{" "}
        <code className="rounded bg-warning/20 px-1 text-code">{message.file}</code>{" "}
        wrote over changes{conflictHint}. Both edits are in the file now, so
        check it reads the way you want.
      </span>
    </Alert>
  )
}

/**
 * Claude's own usage limit, on the account whose credentials this editor is
 * using — a subscription or an API key. It is not a limit the editor imposes,
 * and the copy says whose it is, because "rate limit" alone leaves the reader
 * wondering which of the two things in front of them ran out.
 *
 * Rewritten 2026-08-18 (Mo). What it used to say:
 *
 *     Rate limit rejected (output_tokens). Resets in 38m. Utilization 100%.
 *     Credit overage: rejected. Waiting for the limit to clear.
 *
 * Three separate failures in one line. **"rejected" was the SDK's word for a
 * request that was refused**, printed as though the reader shared that
 * vocabulary — Mo read it and asked whether it meant the limit was reached,
 * which is exactly what it means and never what it said. **`output_tokens`**
 * is which of Claude's sub-limits ran out, and nothing the reader can act on.
 * And **"Utilization 100%"** restated the rejection in a second dialect.
 *
 * What survives is what changes what the reader does: whether they are near
 * the limit or past it, when it clears, and whether the turn is still going.
 * The percentage stays only in the approaching case, where it is the
 * difference between "finish this thought" and "stop now".
 */
function RateLimitWarningBanner({
  message,
}: {
  message: Extract<ChatMessage, { kind: "rate_limit_warning" }>
}) {
  const isRejected = message.status === "rejected"
  /*
   * "Try again in 38 mins when the limit resets" (Mo's wording, 2026-08-18),
   * not "Limits reset in 38 mins". The reset is a fact about the account; what
   * the reader wants is what to do and when, and the same clause carries both.
   *
   * `formatResetTime` returns a leading "in …" / "at …", so the sentence reads
   * "Try again in 38 mins" or "Try again at 4:15 PM" without a second branch.
   *
   * The approaching case gets no such line: nothing has failed there, so there
   * is nothing to try again.
   */
  const retryHint =
    message.resetsAt !== undefined
      ? ` Try again ${formatResetTime(message.resetsAt)} when the limit resets.`
      : ""
  const resetHint =
    message.resetsAt !== undefined
      ? ` Limits reset ${formatResetTime(message.resetsAt)}.`
      : ""
  // Only while approaching. Past the limit the number is always 100 and adds
  // nothing to a sentence that already says the limit is reached.
  const usedHint =
    !isRejected && message.utilization !== undefined
      ? ` (${Math.round(message.utilization * 100)}% used)`
      : ""
  // The extra-credit pool a claude.ai subscription draws on once the base
  // limit is gone. It belongs in the rejection sentence, because "reached, and
  // nothing left to fall back on" is a different situation from "reached".
  const noCredits =
    message.overageStatus === "rejected"
      ? " and there are no extra credits available"
      : ""
  const body = isRejected
    ? `The model request has been denied. The usage limit for this Claude account has been reached${noCredits}.${retryHint}`
    : `The usage limit for this Claude account is nearly reached${usedHint}.${resetHint} This turn is still running.`
  // Two severities, two named variants. Rejected means the request did not go
  // through, so it is destructive; approaching means the turn is still running
  // and the user can still finish, so it is a warning.
  //
  // This used to be `variant="default"` plus a hand-written warning tint,
  // joined with `[].join(" ")`. A raw join is not merged by tailwind-merge, so
  // a base class and its override could both survive into the class list and
  // the winner was decided by CSS source order rather than by the call. `cn()`
  // merges, which is the only reason the composition below is safe to read at
  // face value.
  return (
    <Alert
      variant={isRejected ? "destructive" : "warning"}
      className={cn(BANNER_BASE, "flex items-start gap-1.5")}
    >
      <Loader2
        className="mt-1 size-2.5 shrink-0 animate-spin"
        aria-hidden="true"
      />
      <span>{body}</span>
    </Alert>
  )
}

function ApiRetryBanner({
  message,
}: {
  message: Extract<ChatMessage, { kind: "api_retry" }>
}) {
  const isRateLimit = message.errorStatus === 429
  const label = isRateLimit
    ? "Rate limit hit, waiting before retry"
    : "Transient API error, retrying"
  const delaySec = Math.max(1, Math.round(message.retryDelayMs / 1000))
  // Warning, not destructive: the call failed but the retry is already in
  // flight, so the turn is still expected to finish.
  return (
    <Alert
      variant="warning"
      className={cn(BANNER_BASE, "flex items-start gap-1.5")}
    >
      <Loader2
        className="mt-1 size-2.5 shrink-0 animate-spin"
        aria-hidden="true"
      />
      <span>
        <span className="font-normal">{label}</span> ({message.attempt}/
        {message.maxRetries}). Resuming in ~{delaySec}s.
      </span>
    </Alert>
  )
}

/**
 * The one banner that carries an action rather than only reporting state.
 *
 * Shown when the user's own message referenced something a disabled capability
 * would handle (a pasted Figma URL). Enabling posts a catalog id and nothing
 * else; the spec lives in source.
 *
 * The copy never promises more than it delivers: a capability needing a secret
 * is written to config immediately but stays inert until the variable is
 * exported and the Editor restarts, so the success state says exactly that
 * instead of "Enabled!".
 */
function CapabilityGapBanner({
  message,
  onEnable,
}: {
  message: Extract<ChatMessage, { kind: "capability_gap" }>
  onEnable?: (capabilityId: string) => Promise<{ ok: boolean; envMissing?: string | null }>
}) {
  const [state, setState] = useState<"idle" | "busy" | "done" | "failed">("idle")
  const [envMissing, setEnvMissing] = useState<string | null>(null)

  const enable = async () => {
    if (!onEnable) return
    setState("busy")
    const result = await onEnable(message.capabilityId)
    if (!result.ok) {
      setState("failed")
      return
    }
    setEnvMissing(result.envMissing ?? null)
    setState("done")
  }

  if (state === "done") {
    // Renamed from `needsExport` 2026-08-18: nothing is exported any more.
    // A key is entered in Extensions, and it takes effect on the next message
    // rather than after a restart.
    const needsKey = envMissing ?? (!message.envReady ? message.requiresEnv : null)
    // Success: the write landed. The copy below still says what is missing,
    // but the action the user took did complete.
    return (
      <Alert
        variant="success"
        className={cn(BANNER_BASE, "flex items-start gap-1.5")}
      >
        {/*
          No tick (Mo, 2026-08-18). The sentence opens with "Figma enabled" on
          a green ground; a check mark beside it is the same fact told twice.
          The spinners on the queued / rate-limit / retry banners stay — those
          say something the words do not, that the thing is still happening.
        */}
        <span className="flex flex-col gap-1">
          <span>
            <span className="font-normal">{message.label} enabled.</span>{" "}
            {needsKey
              ? "It stays inactive until an API key is added, in Settings under Extensions."
              : message.activation === "cli-restart"
                ? "Restart the Editor to start using it."
                : "Active from your next message."}
          </span>

        </span>
      </Alert>
    )
  }

  // Info: nothing failed. The agent noticed a link it cannot read and is
  // offering a capability the user never asked for.
  return (
    <Alert
      variant="info"
      className={cn(BANNER_BASE, "flex items-start gap-1.5")}
    >
      {/*
        No icon (Mo, 2026-08-18). It was a generic puzzle piece next to a
        sentence that already names the extension, so it identified nothing and
        only pushed the copy in.
      */}
      <span className="flex flex-1 flex-col gap-1">
        {/*
          The action is a LINK at the end of the sentence, not a button under
          it (Mo, 2026-08-18). This banner is an offer the user never asked
          for. A button — filled or outlined — sits on its own line and reads
          as the thing they are supposed to press next; a link finishes the
          sentence that explains why it is there.

          `variant="link"` on a `Button`, not a bare `<a>`: there is no href to
          go to, it runs a handler, and the repo bans raw interactive elements
          under `src/components/**`. `h-auto p-0` strips the button box so it
          sits on the text baseline, and `text-current` keeps it the banner's
          own colour rather than the primary teal.

          The "Also needs an API key" line is gone with it. It warned about a
          requirement before the user had chosen to care, and the success state
          below says the same thing at the moment it starts mattering.
        */}
        <span>
          <span className="font-normal">{message.label} isn&apos;t enabled</span>: the
          agent can&apos;t read that link without it.{" "}
          <Button
            variant="link"
            size="xs"
            disabled={state === "busy" || !onEnable}
            onClick={() => void enable()}
            className="h-auto p-0 align-baseline text-current underline"
            data-testid={`capability-gap-enable-${message.capabilityId}`}
          >
            {state === "busy" ? <Loader2 className="animate-spin" /> : null}
            Enable {message.label}
          </Button>
        </span>
        {state === "failed" ? (
          <span className="text-2xs text-destructive">
            Couldn&apos;t enable it. Try the Extensions panel in the settings menu.
          </span>
        ) : null}
      </span>
    </Alert>
  )
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

interface ChatStatusBannersProps {
  /**
   * The full `chat.messages` array. User / assistant messages are silently
   * ignored — only the 5 status kinds produce rendered output.
   */
  messages: ChatMessage[]
  /**
   * Dismiss a banner by message id. Omitted → banners render with no dismiss
   * control, exactly as before this prop existed.
   *
   * Every kind is dismissible, including the self-clearing ones (`queued`,
   * `api_retry`): a banner the user has read is noise whether or not it would
   * eventually clear itself, and a control that appears on only some banners
   * is harder to learn than one that is always there.
   */
  onDismiss?: (id: string) => void
  /**
   * Enables a curated capability by id. Omitted ⇒ the gap banner still
   * explains the gap but offers no button, which is the correct degradation
   * for a surface that cannot act.
   */
  onEnableCapability?: (
    capabilityId: string,
  ) => Promise<{ ok: boolean; envMissing?: string | null }>
}

/**
 * Wraps one banner with an optional dismiss control, positioned over the
 * banner's top-right. With no `onDismiss` the children render bare, so the
 * no-dismiss path adds no wrapper element at all.
 *
 * ## The X takes the banner's colour (Mo, 2026-08-18)
 *
 * The control sits OUTSIDE the `Alert`'s box — it has to, because the Alert's
 * base is a grid and a positioned child would claim a grid row. So it inherits
 * nothing from the tone, and `variant="ghost"` paints it `text-foreground`:
 * a near-black X on amber, red or teal copy, which reads as a different
 * element bolted onto the banner rather than part of it.
 *
 * `tone` puts the matching foreground on the WRAPPER and the button takes
 * `text-current`, so one class name is all that has to stay in step with
 * `TONE_SURFACE`. The wrapper is `contents`-free and paints nothing itself, so
 * setting a colour on it costs nothing and reaches only the button — the Alert
 * inside sets its own.
 */
const DISMISS_TONE: Record<BannerTone, string> = {
  destructive: "text-destructive",
  // `text-warning-strong`, not `text-warning` — the same substitution
  // `TONE_SURFACE` makes, and for the same reason: base amber is too light to
  // read on an amber tint.
  warning: "text-warning-strong",
  success: "text-success",
  info: "text-info",
}

function DismissibleBanner({
  id,
  tone,
  onDismiss,
  children,
}: {
  id: string
  tone: BannerTone
  onDismiss?: (id: string) => void
  children: ReactNode
}) {
  if (!onDismiss) return <>{children}</>
  return (
    <div className={cn("relative", DISMISS_TONE[tone])}>
      {children}
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Dismiss message"
        // `text-current` so the colour comes from the wrapper above, and
        // `hover:text-current` because `ghost`'s hover state would otherwise
        // reset it to the neutral foreground on the way past.
        className="absolute top-1 right-1 text-current opacity-60 hover:text-current hover:opacity-100"
        onClick={() => onDismiss(id)}
      >
        <X />
      </Button>
    </div>
  )
}

/**
 * Renders a vertical strip of status banners for the non-conversational
 * message kinds. Designed to sit OUTSIDE the assistant-ui thread (above the
 * editor or below the viewport) so the runtime's timeline stays clean.
 * Returns `null` when there are no status messages to render.
 */
export function ChatStatusBanners({
  messages,
  onDismiss,
  onEnableCapability,
}: ChatStatusBannersProps) {
  const statusMessages = messages.filter(
    (m): m is Extract<
      ChatMessage,
      {
        kind:
          | "error"
          | "queued"
          | "overwrite_warning"
          | "rate_limit_warning"
          | "api_retry"
          | "capability_gap"
      }
    > =>
      m.kind === "capability_gap" ||
      m.kind === "error" ||
      m.kind === "queued" ||
      m.kind === "overwrite_warning" ||
      m.kind === "rate_limit_warning" ||
      m.kind === "api_retry",
  )

  if (statusMessages.length === 0) return null

  return (
    <div data-testid="chat-status-banners">
      {statusMessages.map((m) => {
        // `tone` is decided HERE and the banner picks its own `Alert` variant
        // below, so the two have to agree by hand. That is deliberate rather
        // than tidy: hoisting the variant up would mean every banner returning
        // bare children and the dispatch owning six sets of layout classes,
        // which trades one duplicated word for a much larger coupling. Two of
        // these are conditional on the message and must stay in step.
        const tone: BannerTone =
          m.kind === "error"
            ? "destructive"
            : m.kind === "queued"
              ? "info"
              : m.kind === "overwrite_warning"
                ? "warning"
                : m.kind === "rate_limit_warning"
                  ? m.status === "rejected"
                    ? "destructive"
                    : "warning"
                  : m.kind === "api_retry"
                    ? "warning"
                    : "info"
        const banner =
          m.kind === "capability_gap" ? (
            <CapabilityGapBanner message={m} onEnable={onEnableCapability} />
          ) : m.kind === "error" ? (
            <ErrorBanner message={m} />
          ) : m.kind === "queued" ? (
            <QueuedBanner message={m} />
          ) : m.kind === "overwrite_warning" ? (
            <OverwriteWarningBanner message={m} />
          ) : m.kind === "rate_limit_warning" ? (
            <RateLimitWarningBanner message={m} />
          ) : (
            <ApiRetryBanner message={m} />
          )
        return (
          <DismissibleBanner key={m.id} id={m.id} tone={tone} onDismiss={onDismiss}>
            {banner}
          </DismissibleBanner>
        )
      })}
    </div>
  )
}
