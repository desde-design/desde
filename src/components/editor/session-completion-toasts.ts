/**
 * Copy for the background-chat-session completion toasts.
 *
 * A background session finishing is announced by a toast. The toast has to
 * answer two questions: WHICH session, and WHAT happened. `preview` answers
 * the first — it is the session's FIRST user message, so it names the session
 * the way the tab strip does.
 *
 * It was being used to answer the second question too. `statusReason` is
 * spread onto a transition only when the server reports one, so a failure with
 * no reason produced a toast whose entire description was an old prompt. Mo hit
 * exactly that on a cost ceiling: a toast reading "Move the chevron to the
 * right", which was neither what he had just asked for nor what went wrong.
 *
 * Two rules follow, and they are what this module exists to hold:
 *
 * 1. The preview is always quoted. It reads as a quotation of a prompt rather
 *    than as prose the product is addressing to you — which matters most on a
 *    long session, where the first message may be an hour old.
 * 2. A failure always states a reason. "The server did not say why" is a worse
 *    message than a real reason and a far better one than silence, because the
 *    silence was being filled by the prompt.
 *
 * The builder is pure and returns a list of toasts for the surface to fire, so
 * both rules are testable without rendering the editor.
 */

import type { SessionStatusTransition } from "@/editor/agent-chat/session-status-transitions"

/**
 * `statusReason` is unbounded text from the chat handler — a long model error
 * or a stack trace would otherwise stretch the description to fill the
 * viewport. Adjust this knob if the design language ever wants a multi-line
 * toast.
 */
const TOAST_REASON_MAX = 140

/** How many previews a collapsed stack spells out before it says "…". */
const COLLAPSED_PREVIEW_CAP = 3

/**
 * Above this many transitions in one debounce window, sessions are collapsed
 * into one toast per outcome instead of one toast each, so a burst of
 * completions can't paper the screen.
 */
const COLLAPSE_ABOVE = 3

export interface SessionToast {
  level: "success" | "warning" | "error"
  title: string
  description?: string
}

function truncateReason(reason: string): string {
  if (reason.length <= TOAST_REASON_MAX) return reason
  return `${reason.slice(0, TOAST_REASON_MAX - 1)}…`
}

/**
 * Humanise the retry-after window. Seconds under a minute, rounded minutes
 * above it. No cap handling needed — the classifier already caps at 3600s.
 */
function formatRetryAfter(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  return `${Math.round(seconds / 60)}m`
}

/** A session's first user message, quoted. See rule 1 in the file comment. */
function askedFor(preview: string): string {
  return `“${preview}”`
}

/** See rule 2 in the file comment: never the preview alone. */
function failureDescription(t: SessionStatusTransition): string {
  const reason = t.statusReason
    ? truncateReason(t.statusReason)
    : "the server did not say why"
  return `${askedFor(t.preview)} · ${reason}`
}

function rateLimitedDescription(t: SessionStatusTransition): string {
  if (t.retryAfterSeconds === undefined) return askedFor(t.preview)
  return `${askedFor(t.preview)}, try again in ${formatRetryAfter(t.retryAfterSeconds)}`
}

function stack(items: string[]): string {
  return (
    items.slice(0, COLLAPSED_PREVIEW_CAP).join("; ") +
    (items.length > COLLAPSED_PREVIEW_CAP ? "…" : "")
  )
}

/**
 * Turn one debounced batch of session transitions into the toasts to fire.
 *
 * Up to `COLLAPSE_ABOVE` transitions get one toast each, so the user sees
 * which session finished. Above that, each outcome collapses into a single
 * toast. Rate-limited failures keep their own stack in the collapsed case as
 * well — lumping them in with generic failures buried the one affordance that
 * tells the user the work is recoverable.
 */
export function buildSessionCompletionToasts(
  transitions: readonly SessionStatusTransition[],
): SessionToast[] {
  const failures = transitions.filter((t) => t.toStatus === "failed")
  const successes = transitions.filter((t) => t.toStatus === "idle")
  const toasts: SessionToast[] = []

  if (transitions.length <= COLLAPSE_ABOVE) {
    for (const t of successes) {
      toasts.push({
        level: "success",
        title: "Chat session done",
        description: askedFor(t.preview),
      })
    }
    for (const t of failures) {
      toasts.push(
        t.failureKind === "rate-limited"
          ? {
              level: "warning",
              title: "Chat session rate-limited",
              description: rateLimitedDescription(t),
            }
          : {
              level: "error",
              title: "Chat session failed",
              description: failureDescription(t),
            },
      )
    }
    return toasts
  }

  if (successes.length > 0) {
    toasts.push({
      level: "success",
      title: `${successes.length} chat sessions done`,
      description: stack(successes.map((t) => askedFor(t.preview))),
    })
  }
  const rateLimited = failures.filter((t) => t.failureKind === "rate-limited")
  const other = failures.filter((t) => t.failureKind !== "rate-limited")
  if (rateLimited.length > 0) {
    toasts.push({
      level: "warning",
      title:
        rateLimited.length === 1
          ? "Chat session rate-limited"
          : `${rateLimited.length} chat sessions rate-limited`,
      description: stack(rateLimited.map(rateLimitedDescription)),
    })
  }
  if (other.length > 0) {
    toasts.push({
      level: "error",
      title:
        other.length === 1
          ? "Chat session failed"
          : `${other.length} chat sessions failed`,
      description: stack(other.map(failureDescription)),
    })
  }
  return toasts
}
