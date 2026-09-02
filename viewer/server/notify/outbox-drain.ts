/**
 * Outbox drain loop — periodically claims pending `NotificationOutbox` rows
 * and delivers them via `processIntent` (`mention-email.ts`).
 *
 * Claim-before-process is what makes delivery exactly-once even with
 * multiple ticks (or, later, multiple processes) racing the same row:
 * `StorageAdapter.claimNotification` atomically flips pending→sending and
 * returns `false` to every caller after the first, so a row already picked
 * up by one tick is invisible to the next.
 */

import type { EmailProvider } from "./email-provider"
import type { ReloadableEmailProvider } from "./reloadable-email-provider"
import type { ViewerConfig } from "../config"
import type { NotificationOutbox, Project, StorageAdapter } from "../storage/types"
import {
  processIntent,
  type MentionComment,
  type MentionRecipient,
  type ProcessIntentDeps,
} from "./mention-email"

/**
 * Human-readable project name for the mention-email subject/body.
 * `projectId` is a UUID in production — never render it directly. Falls back
 * to the project's slug, then to the raw id if the project record is
 * somehow gone (e.g. deleted between comment creation and drain). Exported
 * so the fallback chain is unit-testable independent of `StorageAdapter`
 * cascade-delete semantics.
 */
export function resolveProjectName(project: Pick<Project, "name" | "slug"> | null, projectId: string): string {
  return project?.name || project?.slug || projectId
}

/** How many pending rows one tick claims-and-processes at most. */
const BATCH_SIZE = 20

/** Default interval between drain ticks when the caller doesn't override it. */
const DEFAULT_INTERVAL_MS = 5_000

export interface OutboxDrainDeps {
  storage: StorageAdapter
  /** Null when `VIEWER_SMTP_HOST` is unset — the drain no-ops until configured. */
  /** Reloadable: SMTP can be turned on from the settings page mid-process. */
  email: ReloadableEmailProvider | null
  config: ViewerConfig
}

async function getRecipients(storage: StorageAdapter, ids: string[]): Promise<MentionRecipient[]> {
  const out: MentionRecipient[] = []
  for (const id of ids) {
    const participant = await storage.getParticipant(id)
    if (participant) out.push({ email: participant.email, name: participant.displayName, participantId: participant.id })
  }
  return out
}

/**
 * Builds the `ProcessIntentDeps` for one outbox row. Always resolves the
 * PARENT comment via `commentId` — for a reply notification (`replyId` set)
 * v1 sends the parent comment's context; surfacing the reply's own body in
 * the email is a nice-to-have left for a follow-up (see task-4 brief).
 */
function buildProcessIntentDeps(
  storage: StorageAdapter,
  email: EmailProvider,
  config: ViewerConfig,
  intent: NotificationOutbox,
): ProcessIntentDeps {
  return {
    intent: { id: intent.id, commentId: intent.commentId, recipientIds: intent.recipientIds },
    getComment: async (commentId): Promise<MentionComment | null> => {
      const comment = await storage.getComment(commentId)
      if (!comment) return null
      // `Comment.projectId` is optional in the shared bridge type (not always
      // present on bridge-facing payloads) but every StorageAdapter impl
      // populates it on stored comments; the outbox row's own `projectId`
      // is the belt-and-suspenders fallback.
      const projectId = comment.projectId ?? intent.projectId
      // `projectId` is a UUID in production — never render it directly.
      // Resolve the human-readable name (falling back to slug, then the raw
      // id if the project record is somehow gone) for the subject/body.
      const project = await storage.getProject(projectId)
      return {
        id: comment.id,
        number: comment.number,
        body: comment.body,
        authorName: comment.author.displayName,
        projectId,
        projectName: resolveProjectName(project, projectId),
        // Powers the "View comment" CTA's deep link (`/review/<slug>`, the
        // review-surface route — see mention-email.ts's `mentionEmail`).
        // Falls back to the raw id in the same rare case as
        // `resolveProjectName` (project record gone) — an unresolvable
        // slug there means the CTA link 404s, same as `projectName`
        // rendering a UUID would have, but never something worse.
        projectSlug: project?.slug ?? projectId,
      }
    },
    getRecipients: (ids) => getRecipients(storage, ids),
    send: (to, subject, html, opts) => email.send(to, subject, html, opts),
    setStatus: (id, status) => storage.setNotificationStatus(id, status),
    baseUrl: config.publicUrl,
    isUnsubscribed: (recipient, projectId) =>
      recipient.participantId ? storage.isOptedOut(recipient.participantId, projectId) : Promise.resolve(false),
    unsubscribe: config.unsubscribeSecret
      ? { secret: config.unsubscribeSecret, endpoint: `${config.publicUrl}/api/v1/unsubscribe` }
      : undefined,
  }
}

/**
 * Process one batch of pending notifications. Exported so tests can invoke a
 * single drain pass directly instead of racing a real interval timer.
 */
export async function runOutboxDrainTick(deps: OutboxDrainDeps): Promise<void> {
  // `isConfigured`, not just presence: the provider is always there once the
  // server is running, and answers for itself whether SMTP is set. It can
  // change mid-process now that the settings page can turn mail on.
  if (!deps.email?.isConfigured()) return
  const email = deps.email

  // Everything below (including the initial list/claim calls) is inside this
  // try: `listPendingNotifications`/`claimNotification` can throw too — a
  // busy/locked SQLite handle, a storage IO error, a corrupt
  // `recipient_ids` JSON.parse — and this function is invoked as
  // `void runOutboxDrainTick(deps)` from a `setInterval` callback with no
  // caller able to catch a rejection. An uncaught rejection there is an
  // unhandled rejection at the process level, which crashes the whole
  // process on Node >=15. A single bad tick must log and let the NEXT tick
  // proceed, never take the process down or wedge the loop.
  try {
    const pending = await deps.storage.listPendingNotifications(BATCH_SIZE)
    for (const notification of pending) {
      const claimed = await deps.storage.claimNotification(notification.id)
      if (!claimed) continue // lost the race (or already processed) — never send twice

      try {
        await processIntent(buildProcessIntentDeps(deps.storage, email, deps.config, notification))
      } catch (err) {
        console.error(`[viewer] outbox drain: failed to process notification ${notification.id}:`, err)
        // Best-effort: leave the row in a terminal state rather than stuck at
        // "sending" forever (which `listPendingNotifications` would never
        // surface again for a retry).
        try {
          await deps.storage.setNotificationStatus(notification.id, "error")
        } catch {
          // Row may already be terminal, or storage itself is failing — nothing
          // more this tick can do; the next tick will pick up other rows.
        }
      }
    }
  } catch (err) {
    console.error("[viewer] outbox drain: tick failed (listing/claiming pending notifications):", err)
  }
}

/**
 * Starts the periodic drain. Returns a stop function; safe to call once at
 * shutdown. Logs once at start when no `EmailProvider` is configured — ticks
 * themselves no-op silently rather than repeating the warning every interval.
 */
export function startOutboxDrain(deps: OutboxDrainDeps & { intervalMs?: number }): () => void {
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS
  if (!deps.email?.isConfigured()) {
    console.log("[viewer] outbox drain idle: no email provider configured (VIEWER_SMTP_HOST unset)")
  }
  const timer = setInterval(() => {
    // Belt-and-braces alongside the try/catch inside runOutboxDrainTick
    // itself: even if a future change reintroduces an unguarded throw path,
    // this `.catch` keeps it from becoming an unhandled rejection here.
    void runOutboxDrainTick(deps).catch((err) => {
      console.error("[viewer] outbox drain tick failed:", err)
    })
  }, intervalMs)
  return () => clearInterval(timer)
}
