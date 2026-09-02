/**
 * Phase 5 of tasks/editor-detached-sessions.md — pure transition
 * detector for the toast-on-completion notifier.
 *
 * The detached chat sessions UI keeps a cached list of
 * `ChatSessionSummary` rows in `useChatSessions`. When a background
 * session completes (its status flips from `in-flight` to `idle` or
 * `failed`), we want to surface a toast so the user — who may be
 * looking at a different session, or have the picker closed
 * altogether — knows their long-running prompt landed.
 *
 * This module is the diff engine: given the previous summary list and
 * the freshly-fetched one, return one entry per session that just
 * finished. The hook owns the prev/next bookkeeping and the debounce;
 * this module is pure so the rules are easy to test in isolation.
 *
 * Rules:
 *   - Only `in-flight` → `idle` or `in-flight` → `failed` fires a toast.
 *   - First refetch (empty prev) NEVER fires toasts — we have no
 *     in-flight baseline to transition from.
 *   - Sessions missing from `next` (e.g. swept to `cancelled` by
 *     restart-clear; listing filters those) do NOT fire toasts.
 *     `cancelled` is not a "completion" the user is waiting on.
 *   - Pre-Phase-5 records without a status field are treated as
 *     `idle` (matches listing semantics) — they can't be the "from"
 *     side of a transition.
 *
 * Order: preserves the order of `next` (listing is updatedAt-desc;
 * most recently completed comes first).
 */

import type { ChatSessionSummary } from "./session-store"

export interface SessionStatusTransition {
  sessionId: string
  /**
   * The prompt of the turn that just finished — see
   * `latestPromptFromSummary`. NOT the session's first message; that
   * is what the switcher shows, and using it here named the wrong
   * turn.
   */
  preview: string
  /** Status the session transitioned TO. Always a terminal-for-the-turn state. */
  toStatus: "idle" | "failed"
  /** statusReason at the new state, if any (failed → the error message). */
  statusReason?: string
  /**
   * Phase 5 — rate-limit classification. Present only on `toStatus
   * === 'failed'`. `rate-limited` means the chat handler detected
   * an Anthropic 429 (or similar) in the error message — the toast
   * surface uses this to render a distinct "Rate limited" toast
   * with optional countdown.
   */
  failureKind?: "rate-limited" | "other"
  /**
   * Phase 5 — best-effort retry-after window in seconds. Present
   * only when `failureKind === 'rate-limited'` AND the provider's
   * error message included a parseable hint. UI surfaces this as
   * "Try again in Ns" in the toast description.
   */
  retryAfterSeconds?: number
}

/**
 * Toast previews are cut to the same width the store cuts a first
 * message to, so a 200-char last message can't stretch the toast.
 */
const PREVIEW_MAX = 60

/**
 * The prompt of the MOST RECENT turn — what the user just asked for.
 *
 * This used to read `firstUserMessagePreview`, the session's opening
 * message, and it named the wrong turn every time a session ran more
 * than one. Mo hit a cost ceiling on a turn where he had typed
 * "hello" and got a toast quoting a prompt from earlier in that
 * session. The transition being announced is a TURN finishing, so the
 * label has to be that turn's prompt.
 *
 * `formatSessionLabel` (chat-session-menu.tsx) deliberately does the
 * opposite and leads with the FIRST message: a session's name in the
 * switcher should stay put as the conversation goes on. The two
 * ladders disagree on purpose.
 *
 * Falls back to the first message, then to a `Session abc123` stub, so
 * an empty or malformed session still names something recognisable.
 */
export function latestPromptFromSummary(summary: ChatSessionSummary): string {
  const last = summary.lastUserMessagePreview
  if (typeof last === "string" && last.length > 0) return last.slice(0, PREVIEW_MAX)
  const first = summary.firstUserMessagePreview
  if (typeof first === "string" && first.length > 0) return first.slice(0, PREVIEW_MAX)
  return `Session ${summary.sessionId.slice(0, 6)}`
}

/**
 * Diff `prev` → `next` and return the set of sessions that just
 * transitioned from `in-flight` to a terminal state.
 *
 * Caller is responsible for holding the prev reference across refetches
 * and for the debounce window — this function is pure and synchronous.
 */
export function detectSessionStatusTransitions(
  prev: ChatSessionSummary[],
  next: ChatSessionSummary[],
): SessionStatusTransition[] {
  // First-fetch guard: an empty `prev` means we have no baseline to
  // transition FROM. Without this, a session that's already idle on
  // mount would look like a transition. (It wouldn't currently —
  // toStatus from undefined fails the in-flight check — but the
  // explicit guard documents intent and protects against future
  // changes to the "absent prev status means in-flight" rule.)
  if (prev.length === 0) return []

  const prevById = new Map<string, ChatSessionSummary>()
  for (const s of prev) prevById.set(s.sessionId, s)

  const out: SessionStatusTransition[] = []
  for (const s of next) {
    const before = prevById.get(s.sessionId)
    if (!before) continue
    if (before.status !== "in-flight") continue
    if (s.status !== "idle" && s.status !== "failed") continue
    out.push({
      sessionId: s.sessionId,
      preview: latestPromptFromSummary(s),
      toStatus: s.status,
      ...(s.statusReason ? { statusReason: s.statusReason } : {}),
      ...(s.status === "failed" && s.statusFailureKind
        ? { failureKind: s.statusFailureKind }
        : {}),
      ...(s.status === "failed" && s.statusRetryAfterSeconds !== undefined
        ? { retryAfterSeconds: s.statusRetryAfterSeconds }
        : {}),
    })
  }
  return out
}
