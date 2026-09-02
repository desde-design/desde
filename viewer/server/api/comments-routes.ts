import { Router } from "express"
import type { Comment, CommentAuthor, CommentPosition, CommentReply } from "@/types/bridge"
import type { AppDeps } from "../create-app"
import {
  canReadProject,
  loadProjectReadPolicy,
  makeProjectMembership,
  requireProjectRead,
  requireProjectWrite,
  resolveReadContext,
  type ReadContext,
} from "../auth/authorize"
import type { CommentChangeBus } from "../comments/change-bus"
import type { StorageAdapter } from "../storage/types"
import { NotFoundError } from "../storage/errors"
import {
  MAX_CONCURRENT_STREAMS_PER_CLIENT,
  clientKeyFor,
  createConcurrencyLimiter,
  createFixedWindowCounter,
} from "../rate-limit"
import { isProjectInsider } from "./field-visibility"
import { upsertAuthorParticipant } from "./participants-routes"
import { MAX_EMAIL_CHARS, MAX_NAME_CHARS } from "./validate-email"

const MAX_BODY_CHARS = 10_000
const MAX_SELECTOR_CHARS = 2_000
const MAX_PAGE_CHARS = 2_000
const MAX_URL_CHARS = 2_048
const MAX_MENTIONS = 20
const MAX_TAB_PANEL_IDS = 20
const MAX_TAB_PANEL_ID_CHARS = 200
const MAX_REPLIES_PER_COMMENT = 500

/**
 * Ceiling on how many mention notifications ONE project may enqueue per
 * hour, counted in RECIPIENTS (not requests) because that is what turns into
 * outbound mail from the operator's SMTP identity.
 *
 * Sized against the real workflow: a busy review is a few dozen mentions a
 * day, so 200/hour never fires for a human. It exists because `MAX_MENTIONS`
 * caps one request at 20 and nothing capped the number of requests — the
 * audit measured 5 repeats of a 20-recipient comment producing 100 emails
 * with no dedup and no throttle. Per PROJECT, not per IP: the outbound
 * reputational cost belongs to the project, and an attacker rotating IPs
 * must not multiply it (the per-IP HTTP limiter in `../rate-limit.ts` is the
 * other half of this, not a substitute for it).
 */
const MAX_MENTION_RECIPIENTS_PER_PROJECT_PER_HOUR = 200

/**
 * Validates a client-supplied author.
 *
 * `skip` is passed when the caller is AUTHENTICATED: `resolveWriteAuthor`
 * then derives authorship server-side and discards this object entirely, so
 * validating it means rejecting a request over the shape of a field that is
 * about to be thrown away. That surfaced for real when the Editor started
 * writing through a machine token — it had to invent a `displayName`, an
 * `email` and a `photoURL` it does not have, discovering each one from a
 * separate 400 that reads like a bug in the Editor rather than a contract
 * detail. An authenticated caller may now omit `author` altogether.
 *
 * Anonymous callers are unchanged: for them the author IS the record, so it
 * must still be well-formed.
 */
function validateAuthor(a: unknown, skip = false): string | null {
  if (skip) return null
  return validateAuthorShape(a)
}

function validateAuthorShape(a: unknown): string | null {
  if (typeof a !== "object" || a === null) return "author is required"
  const { uid, displayName, email, photoURL } = a as Record<string, unknown>
  if (typeof uid !== "string" || uid.length === 0 || uid.length > MAX_NAME_CHARS) return "author.uid is invalid"
  if (typeof displayName !== "string" || displayName.trim().length === 0 || displayName.length > MAX_NAME_CHARS)
    return "author.displayName is required"
  if (typeof email !== "string" || email.length > MAX_EMAIL_CHARS) return "author.email is invalid"
  if (typeof photoURL !== "string" || photoURL.length > MAX_URL_CHARS) return "author.photoURL is invalid"
  return null
}

function validatePosition(p: unknown): string | null {
  if (typeof p !== "object" || p === null) return "position is required"
  const { anchorSelector, page, anchorX, anchorY, tabPanelIds } = p as Record<string, unknown>
  if (typeof anchorSelector !== "string" || anchorSelector.length === 0 || anchorSelector.length > MAX_SELECTOR_CHARS)
    return "position.anchorSelector is invalid"
  if (typeof page !== "string" || page.length === 0 || page.length > MAX_PAGE_CHARS) return "position.page is invalid"
  if (anchorX !== undefined && typeof anchorX !== "number") return "position.anchorX is invalid"
  if (anchorY !== undefined && typeof anchorY !== "number") return "position.anchorY is invalid"
  if (
    tabPanelIds !== undefined &&
    (!Array.isArray(tabPanelIds) ||
      tabPanelIds.length > MAX_TAB_PANEL_IDS ||
      tabPanelIds.some((x) => typeof x !== "string" || x.length > MAX_TAB_PANEL_ID_CHARS))
  )
    return "position.tabPanelIds is invalid"
  return null
}

function validateBodyText(b: unknown): string | null {
  if (typeof b !== "string" || b.trim().length === 0) return "body is required"
  if (b.length > MAX_BODY_CHARS) return `body exceeds ${MAX_BODY_CHARS} characters`
  return null
}

function validateMentions(m: unknown): string | null {
  if (m === undefined) return null
  if (!Array.isArray(m) || m.length > MAX_MENTIONS || m.some((x) => typeof x !== "string" || x.length > MAX_EMAIL_CHARS))
    return "mentions is invalid"
  return null
}

/**
 * Reconstructs `position` field-by-field from the validated raw payload,
 * rather than persisting the raw object as-is. Storage spreads its input
 * wholesale (`StoredCommentInput`), so without this an attacker (or just a
 * chatty client) can smuggle arbitrary extra keys — e.g. a same-shaped
 * `evil` key, or an oversized `tabPanelIds` bypassing the array-length
 * check by nesting — into what gets stored and echoed back to every other
 * viewer of the same comment. Only known fields survive.
 */
function sanitizePosition(raw: Record<string, unknown>): CommentPosition {
  const { anchorX, anchorY, tabPanelIds } = raw
  return {
    anchorSelector: raw.anchorSelector as string,
    page: raw.page as string,
    ...(typeof anchorX === "number" ? { anchorX } : {}),
    ...(typeof anchorY === "number" ? { anchorY } : {}),
    ...(Array.isArray(tabPanelIds) ? { tabPanelIds: tabPanelIds as string[] } : {}),
  }
}

/** Same treatment as `sanitizePosition`, for `author` — see that doc comment. */
function sanitizeAuthor(raw: Record<string, unknown>): CommentAuthor {
  return {
    uid: raw.uid as string,
    displayName: (raw.displayName as string).trim(),
    email: raw.email as string,
    photoURL: raw.photoURL as string,
  }
}

/**
 * Resolves the author identity for a comment/reply WRITE. The client-sent
 * `author` field documents `user:<id>` as a verified identity (vs the
 * self-declared, spoofable `viewer:<uuid>`) but until now nothing checked
 * that claim server-side — any caller could send `uid: "user:<anything>"`
 * and it stored, and propagated into the participant directory
 * (`upsertAuthorParticipant`), identically to a real GitHub sign-in.
 *
 * - **Identified** (`ctx.user` is set): the body's `author` is ignored
 *   outright and the server-derived identity is used instead — same shape
 *   the client builds in `review-shell.tsx`'s `resolveAuthor`, now
 *   authoritative rather than trusted from the wire.
 * - **Anonymous**: behaves exactly as before this fix, with one added
 *   guard — a `user:`-prefixed uid is refused (400). An unidentified caller
 *   was never entitled to claim a verified identity; every other
 *   self-declared shape (`viewer:*`, or anything else `validateAuthor`
 *   already accepted) still stores as sent. This is what keeps the change
 *   additive: it removes a capability nobody should have had, and touches
 *   nothing else an anonymous reviewer could already do.
 *
 * Identity comes from the ALREADY-RESOLVED `ReadContext` (threaded in by
 * `requireProjectWrite`), not from a second independent `getCurrentUser`
 * call. That distinction is load-bearing now that machine tokens exist: a
 * request carrying a PAT for user X and a session cookie for user Y is
 * AUTHORIZED as X, so attributing the comment to Y would record an author
 * the authorization layer never approved; and a PAT with no cookie at all
 * would fall through to the spoofable self-declared `viewer:` branch,
 * making every PAT-driven write unattributable. `resolveReadContext`
 * already answers "who is this request" once, correctly, for all three
 * credential shapes — use its answer.
 */
function resolveWriteAuthor(
  ctx: ReadContext,
  rawAuthor: Record<string, unknown>,
): { author: CommentAuthor } | { error: string } {
  const user = ctx.user
  if (user) {
    return {
      author: {
        uid: `user:${user.id}`,
        displayName: user.displayName,
        email: user.email,
        photoURL: user.avatarUrl,
      },
    }
  }
  if (typeof rawAuthor.uid === "string" && rawAuthor.uid.trim().toLowerCase().startsWith("user:")) {
    return { error: "author.uid cannot claim a verified identity while signed out" }
  }
  return { author: sanitizeAuthor(rawAuthor) }
}

/**
 * The wire shape of a comment author. `email` is OMITTED (never blanked) for
 * a caller who isn't a member/owner/admin of the project — same rule as
 * `MemberView.email` and `ParticipantView.email`.
 *
 * Why (security audit S3): `resolveWriteAuthor` stamps a SIGNED-IN user's
 * server-derived, GitHub-verified address onto every comment they write, and
 * both storage impls additionally accumulate a `participantEmails` array
 * across a thread's author and every replier. The comments read path is
 * gated only on project READABILITY, which on a `public-link` project — or
 * any zero-member legacy one — means anyone with the URL. So the redaction
 * applied to `GET /participants` is undone the moment `GET /comments`
 * answers, unless the same rule is applied here.
 *
 * Applied uniformly to reads AND writes. The create/reply/patch responses
 * echo a whole comment back, so a reply to someone else's thread would
 * otherwise return that thread author's email and the accumulated
 * `participantEmails` — the read redaction with an extra step.
 */
type CommentAuthorView = Omit<CommentAuthor, "email"> & { email?: string }

type CommentReplyView = Omit<CommentReply, "author"> & { author: CommentAuthorView }

export type CommentView = Omit<Comment, "author" | "replies" | "participantEmails"> & {
  author: CommentAuthorView
  replies: CommentReplyView[]
  /** Insiders only — the accumulated address list for the whole thread. */
  participantEmails?: string[]
}

function toAuthorView(author: CommentAuthor, includeEmails: boolean): CommentAuthorView {
  return {
    uid: author.uid,
    displayName: author.displayName,
    photoURL: author.photoURL,
    ...(includeEmails ? { email: author.email } : {}),
  }
}

/**
 * Projects a stored comment onto the wire. Built field by field rather than
 * spread-and-delete: a `delete view.author.email` style redaction is one
 * missed nested object away from silently leaking again, and both `replies`
 * and the thread-level `participantEmails` are exactly such nested objects.
 */
function toCommentView(comment: Comment, includeEmails: boolean): CommentView {
  return {
    id: comment.id,
    number: comment.number,
    position: comment.position,
    body: comment.body,
    author: toAuthorView(comment.author, includeEmails),
    createdAt: comment.createdAt,
    resolved: comment.resolved,
    replies: comment.replies.map((reply) => ({
      id: reply.id,
      body: reply.body,
      author: toAuthorView(reply.author, includeEmails),
      createdAt: reply.createdAt,
      mentions: reply.mentions,
    })),
    mentions: comment.mentions,
    ...(includeEmails ? { participantEmails: comment.participantEmails } : {}),
    ...(comment.projectId !== undefined ? { projectId: comment.projectId } : {}),
  }
}

/**
 * Resolves client-submitted `mentions` against the project's real
 * participant directory, keeping only ids that belong to an actual
 * participant of THIS project — de-duplicated, order preserved.
 *
 * This is the enforcement boundary for "the `mentions` array is opaque
 * participant ids, never emails." The client-side picker
 * (`viewer/app/review/[slug]/review-shell.tsx`) only ever inserts real
 * participant ids, but both textareas are freely editable — a hand-typed or
 * pasted `@[Bob](bob@example.com)` would otherwise submit `mentions:
 * ["bob@example.com"]` verbatim. `validateMentions` above is only a shape
 * gate (array of short strings); this is the semantic gate that makes
 * "the `mentions` array never contains a non-participant id" structurally
 * true, server-side, where a client-side check can't be trusted. An
 * unresolvable entry (email-shaped, unknown id, garbage) is silently
 * dropped rather than rejecting the whole write — the comment/reply still
 * posts.
 *
 * Scope: this guarantee covers ONLY the `mentions` array (and, upstream,
 * the mention-picker output that populates it). The free-text `body` is
 * stored verbatim and is NOT scrubbed — a reviewer can hand-type a literal
 * email address into the prose and it will round-trip as-is. That's
 * inherently unpreventable (it's just text) and no more exposed than any
 * other plain-text content in the comment, so it's out of scope by design,
 * not an oversight.
 */
async function resolveMentionIds(storage: StorageAdapter, projectId: string, mentions: unknown): Promise<string[]> {
  if (!Array.isArray(mentions) || mentions.length === 0) return []
  const participants = await storage.listParticipants(projectId)
  const validIds = new Set(participants.map((p) => p.id))
  const resolved: string[] = []
  for (const m of mentions) {
    if (typeof m === "string" && validIds.has(m) && !resolved.includes(m)) resolved.push(m)
  }
  return resolved
}

/**
 * Enqueues a mention notification for `mentionIds`, excluding the author's
 * own participant id (never email yourself for mentioning yourself). The
 * author was just auto-upserted (`upsertAuthorParticipant`), so a lookup by
 * lowercased email against the project's participant directory finds them —
 * if they have no email there's nothing to exclude, and self-mentions are
 * still possible (author mentions themselves with no other recipients),
 * which correctly enqueues nothing.
 *
 * Wrapped so an enqueue failure can never fail the comment/reply write it's
 * attached to — same posture as `upsertAuthorParticipant`.
 *
 * Not called from the PATCH edit route (v1): editing a comment to add a new
 * mention does not trigger a notification. Acceptable v1 scope per the
 * phase-2b-2 task brief — see comments-routes.ts PATCH handler.
 */
async function enqueueMentionNotifications(
  storage: StorageAdapter,
  notificationBudget: { hit(key: string, cost?: number): { allowed: boolean } },
  projectId: string,
  commentId: string,
  replyId: string | null,
  mentionIds: string[],
  authorEmail: string,
): Promise<void> {
  if (mentionIds.length === 0) return
  try {
    const participants = await storage.listParticipants(projectId)
    const authorParticipantId = authorEmail
      ? participants.find((p) => p.email === authorEmail.toLowerCase())?.id
      : undefined
    const recipientIds = mentionIds.filter((id) => id !== authorParticipantId)
    if (recipientIds.length === 0) return
    // The hourly ceiling (security audit B5). Charged BEFORE enqueueing and
    // all-or-nothing for this batch: a partial send would still put the
    // operator's From: on attacker-authored mail, just less of it. Dropping
    // the notification never fails the comment write — the comment is still
    // stored and still visible in the review UI, which is the part the user
    // actually asked for.
    if (!notificationBudget.hit(projectId, recipientIds.length).allowed) {
      console.warn(
        `[viewer] mention-notification budget exhausted for project ${projectId} — dropping ${recipientIds.length} recipient(s) this hour`,
      )
      return
    }
    await storage.enqueueNotification({ projectId, commentId, replyId, recipientIds })
  } catch (err) {
    console.error(`[viewer] failed to enqueue mention notification for project ${projectId}:`, err)
  }
}

/**
 * May this caller mutate the CONTENT of an existing comment (edit its body /
 * mentions, or delete it)?
 *
 * The rule is narrow on purpose. `authorize.ts` documents anonymous post /
 * edit / delete as deliberate — anonymous review links are the product — and
 * an anonymous caller could always forge a `displayName` at CREATE time
 * anyway. What was genuinely new (security audit S20) is that PATCH and
 * DELETE checked only that the comment belonged to this project, never that
 * the caller had anything to do with its AUTHOR, so an anonymous request
 * could attach arbitrary words to an already-VERIFIED GitHub identity —
 * `updateComment` preserves the author row verbatim — or delete that
 * person's comment outright.
 *
 * So: a comment whose author is verified (`user:`-prefixed, a uid only
 * `resolveWriteAuthor`'s identified branch can mint) may only be edited or
 * deleted by that same user, or by a project member/owner/admin. Everything
 * else — the `viewer:`-prefixed self-declared authors that anonymous review
 * produces — is unchanged, because there is no server-side identity to check
 * it against and pretending otherwise would just break anonymous review.
 *
 * Refuses as 404 rather than 403 to match this file's existing
 * no-existence-oracle posture.
 */
async function mayMutateCommentContent(
  storage: StorageAdapter,
  ctx: ReadContext,
  projectId: string,
  author: CommentAuthor,
): Promise<boolean> {
  const isVerifiedAuthor = author.uid.trim().toLowerCase().startsWith("user:")
  if (!isVerifiedAuthor) return true
  if (ctx.user && author.uid === `user:${ctx.user.id}`) return true
  return isProjectInsider(storage, ctx, projectId)
}

// No explicit `Request`/`Response` annotations on the handlers below — same
// note as projects-routes.ts / deployments-routes.ts: typing the params that
// way widens `req.params` to Express 5's generic `ParamsDictionary`, which
// fails strict typecheck. Leaving the callbacks untyped lets TS infer the
// precise per-route params type instead.
//
// No `requireAdmin` on any route in this file — commenting is self-declared
// identity, not an authenticated action, so it isn't admin-gated. Every
// route (including the SSE stream and the write paths) IS gated on project
// visibility via `canReadProject` (Phase 3b-1 Task 3, see
// ../auth/authorize.ts): a non-member can't read or write comments on a
// `members` project that already has members. Payloads are still strictly
// validated and size-capped below.
//
// Read routes use `requireProjectRead`; the four MUTATING routes (create,
// edit, delete, reply) use `requireProjectWrite`, which adds the machine-
// token write-scope check on top of the identical readability gate — a
// `read`-scoped PAT reads comments and is refused 403 on all four writes.
// Anonymous (no credential at all) writes are unchanged and still allowed:
// that's the anonymous-review product, not an oversight. See
// `lacksWriteScope` for why refusing a read-PAT is not stricter than
// refusing nobody.
export function createCommentsRoutes(deps: AppDeps & { changeBus: CommentChangeBus }): Router {
  const router = Router()
  // Per-router state, so each `createApp` (and therefore each test) gets its
  // own budget rather than sharing a module-level one.
  // Per-router, like the notification budget below: each createApp (and so
  // each test) gets its own, rather than sharing module-level state.
  const streamSlots = createConcurrencyLimiter({ max: MAX_CONCURRENT_STREAMS_PER_CLIENT })
  const notificationBudget = createFixedWindowCounter({
    windowMs: 60 * 60_000,
    max: MAX_MENTION_RECIPIENTS_PER_PROJECT_PER_HOUR,
  })

  router.get("/projects/:id/comments", async (req, res) => {
    const project = await requireProjectRead(deps, req, res, String(req.params.id))
    if (!project) return
    // Re-resolved for the FIELD decision only — see `field-visibility.ts`.
    const ctx = await resolveReadContext(deps, req)
    if ("error" in ctx) {
      res.status(401).json({ error: ctx.error })
      return
    }
    const includeEmails = await isProjectInsider(deps.storage, ctx, project.id)
    const comments = await deps.storage.listComments(project.id)
    res.json({ comments: comments.map((c) => toCommentView(c, includeEmails)) })
  })

  router.post("/projects/:id/comments", async (req, res) => {
    const access = await requireProjectWrite(deps, req, res, String(req.params.id))
    if (!access) return
    const { project, ctx } = access
    const { position, body, author, mentions } = req.body ?? {}
    const error =
      validatePosition(position) ?? validateBodyText(body) ?? validateAuthor(author, Boolean(ctx.user)) ?? validateMentions(mentions)
    if (error) {
      res.status(400).json({ error })
      return
    }
    const resolvedAuthor = resolveWriteAuthor(ctx, (author ?? {}) as Record<string, unknown>)
    if ("error" in resolvedAuthor) {
      res.status(400).json({ error: resolvedAuthor.error })
      return
    }
    const resolvedMentions = await resolveMentionIds(deps.storage, project.id, mentions)
    const comment = await deps.storage.createComment(project.id, {
      position: sanitizePosition(position as Record<string, unknown>),
      body,
      author: resolvedAuthor.author,
      mentions: resolvedMentions,
    })
    deps.changeBus.emit(project.id)
    await upsertAuthorParticipant(deps.storage, project.id, comment.author, {
      verified: ctx.user !== null,
    })
    await enqueueMentionNotifications(
      deps.storage,
      notificationBudget,
      project.id,
      comment.id,
      null,
      resolvedMentions,
      comment.author.email,
    )
    res.status(201).json(toCommentView(comment, await isProjectInsider(deps.storage, ctx, project.id)))
  })

  // Registered BEFORE the `:commentId` routes below so "stream" is not
  // captured as a comment id.
  router.get("/projects/:id/comments/stream", async (req, res) => {
    // A client can disconnect at ANY point — before, during, or after the
    // `getProject` await below — and the response's `close` event fires
    // exactly once whenever that happens. Registering the listener (and the
    // `closed` flag it flips) before the first `await` means a disconnect
    // during that await is never missed: without this, `close` could fire
    // with no listener attached yet, and the handler would go on to
    // subscribe to the change bus and start the heartbeat interval for a
    // connection that will never clean them up — a leaked EventEmitter
    // listener + a repeating timer per such request (realistic under fast
    // navigation / React effect double-invoke tearing down an EventSource
    // immediately). `cleanup()` is idempotent so it's safe to reach it via
    // more than one path (close-before-subscribe vs close-after-subscribe).
    let closed = false
    let unsubscribe: (() => void) | null = null
    let heartbeat: ReturnType<typeof setInterval> | null = null
    let release: (() => void) | null = null
    const cleanup = (): void => {
      if (heartbeat) {
        clearInterval(heartbeat)
        heartbeat = null
      }
      if (unsubscribe) {
        unsubscribe()
        unsubscribe = null
      }
      if (release) {
        release()
        release = null
      }
    }
    req.on("close", () => {
      closed = true
      cleanup()
    })
    // Defense-in-depth: a write to an already-torn-down socket (e.g. a
    // heartbeat racing the teardown) must not surface as an unhandled
    // "error" event and crash the process.
    res.on("error", () => {})

    // Visibility check happens at CONNECTION time only — not re-checked for
    // the lifetime of an open stream, so revoking a reviewer's membership
    // takes effect on their next reconnect, not mid-stream. Composed from
    // the lower-level pieces (not `requireProjectRead`) so `closed` can be
    // re-checked after EACH await, preserving the leak-prevention property
    // above at every async boundary, not just the first one.
    //
    // Resolved BEFORE the project lookup, and the invalid-bearer 401 answered
    // BEFORE the existence branch: with the order reversed, `Authorization:
    // Bearer garbage` got a 404 for an unknown project id and a 401 for a
    // real one — a working existence oracle over exactly the `members`
    // projects Phase 3b-1 made indistinguishable from nonexistent. A 401 is
    // a statement about the CREDENTIAL, so it must never be sequenced after
    // a statement about the RESOURCE. `requireProjectRead` already gets this
    // right; this matches it.
    const ctx = await resolveReadContext(deps, req)
    if (closed) return
    if ("error" in ctx) {
      res.status(401).json({ error: ctx.error })
      return
    }
    const project = await deps.storage.getProject(String(req.params.id))
    if (closed) return
    if (!project) {
      res.status(404).json({ error: "Project not found" })
      return
    }
    const allowed = await canReadProject(
      ctx,
      project,
      makeProjectMembership(deps.storage),
      await loadProjectReadPolicy(deps.storage),
    )
    if (closed) return
    if (!allowed) {
      res.status(404).json({ error: "Project not found" })
      return
    }
    // Bound how many of these one client may hold open. This is a CONCURRENCY
    // cap, not the fixed-window limiting that `rate-limit.ts` deliberately
    // keeps away from streams: a window counter either counts a long-lived
    // stream once or refuses the reconnect storm after a proxy hiccup, and
    // neither answers the actual resource question. Each open stream costs a
    // file descriptor, a change-bus listener and a 25-second timer, and on a
    // public-link project this route needs no credential at all.
    //
    // Acquired here rather than at the top of the handler so a refused read
    // (404) does not consume a slot, and released through the same `cleanup`
    // the subscription and heartbeat use, so every teardown path frees it.
    const releaseSlot = streamSlots.acquire(clientKeyFor(req))
    if (!releaseSlot) {
      res.setHeader("Retry-After", "5")
      res.status(429).json({ error: "Too many open connections from this client" })
      return
    }
    release = releaseSlot
    if (closed) {
      // The client hung up during the awaits above. `cleanup` already ran, so
      // nothing else will release this slot.
      release()
      return
    }

    res.status(200)
    res.setHeader("Content-Type", "text/event-stream")
    res.setHeader("Cache-Control", "no-store")
    res.setHeader("Connection", "keep-alive")
    res.flushHeaders()
    res.write(`data: {"type":"connected"}\n\n`)
    unsubscribe = deps.changeBus.subscribe(project.id, () => {
      res.write(`data: {"type":"changed"}\n\n`)
    })
    heartbeat = setInterval(() => res.write(`: ping\n\n`), 25_000)
  })

  router.patch("/projects/:id/comments/:commentId", async (req, res) => {
    const access = await requireProjectWrite(deps, req, res, String(req.params.id))
    if (!access) return
    const { project, ctx } = access
    const commentId = String(req.params.commentId)
    const existing = await deps.storage.getComment(commentId)
    if (!existing || existing.projectId !== project.id) {
      res.status(404).json({ error: "Comment not found" })
      return
    }
    const { body, resolved, mentions } = req.body ?? {}
    const error =
      (body !== undefined ? validateBodyText(body) : null) ??
      (resolved !== undefined && typeof resolved !== "boolean" ? "resolved is invalid" : null) ??
      validateMentions(mentions)
    if (error) {
      res.status(400).json({ error })
      return
    }
    // Authorship is checked only for a patch that changes what the comment
    // SAYS. A `resolved`-only toggle stays open to every caller who can
    // write on the project: triaging someone else's comment is ordinary
    // review work, it attributes no words to anyone, and it is trivially
    // reversible — whereas a body/mentions rewrite is what puts an
    // attacker's text under a verified GitHub identity. See
    // `mayMutateCommentContent`.
    const changesContent = body !== undefined || mentions !== undefined
    if (changesContent && !(await mayMutateCommentContent(deps.storage, ctx, project.id, existing.author))) {
      res.status(404).json({ error: "Comment not found" })
      return
    }
    try {
      const comment = await deps.storage.updateComment(commentId, {
        ...(body !== undefined ? { body } : {}),
        ...(resolved !== undefined ? { resolved } : {}),
        ...(mentions !== undefined ? { mentions: await resolveMentionIds(deps.storage, project.id, mentions) } : {}),
      })
      deps.changeBus.emit(project.id)
      res.json(toCommentView(comment, await isProjectInsider(deps.storage, ctx, project.id)))
    } catch (updateError) {
      if (updateError instanceof NotFoundError) {
        res.status(404).json({ error: updateError.message })
        return
      }
      throw updateError
    }
  })

  router.post("/projects/:id/comments/:commentId/replies", async (req, res) => {
    const access = await requireProjectWrite(deps, req, res, String(req.params.id))
    if (!access) return
    const { project, ctx } = access
    const commentId = String(req.params.commentId)
    const existing = await deps.storage.getComment(commentId)
    if (!existing || existing.projectId !== project.id) {
      res.status(404).json({ error: "Comment not found" })
      return
    }
    const { body, author, mentions } = req.body ?? {}
    const error = validateBodyText(body) ?? validateAuthor(author, Boolean(ctx.user)) ?? validateMentions(mentions)
    if (error) {
      res.status(400).json({ error })
      return
    }
    if (existing.replies.length >= MAX_REPLIES_PER_COMMENT) {
      res.status(400).json({ error: `comment has reached the ${MAX_REPLIES_PER_COMMENT}-reply limit` })
      return
    }
    const resolvedReplyAuthor = resolveWriteAuthor(ctx, (author ?? {}) as Record<string, unknown>)
    if ("error" in resolvedReplyAuthor) {
      res.status(400).json({ error: resolvedReplyAuthor.error })
      return
    }
    try {
      const replyAuthor = resolvedReplyAuthor.author
      const resolvedMentions = await resolveMentionIds(deps.storage, project.id, mentions)
      const comment = await deps.storage.addCommentReply(commentId, {
        body,
        author: replyAuthor,
        mentions: resolvedMentions,
      })
      deps.changeBus.emit(project.id)
      await upsertAuthorParticipant(deps.storage, project.id, replyAuthor, {
        verified: ctx.user !== null,
      })
      const newReply = comment.replies[comment.replies.length - 1]
      await enqueueMentionNotifications(
        deps.storage,
        notificationBudget,
        project.id,
        comment.id,
        newReply.id,
        resolvedMentions,
        replyAuthor.email,
      )
      res.json(toCommentView(comment, await isProjectInsider(deps.storage, ctx, project.id)))
    } catch (replyError) {
      if (replyError instanceof NotFoundError) {
        res.status(404).json({ error: replyError.message })
        return
      }
      throw replyError
    }
  })

  router.delete("/projects/:id/comments/:commentId", async (req, res) => {
    const access = await requireProjectWrite(deps, req, res, String(req.params.id))
    if (!access) return
    const { project, ctx } = access
    const commentId = String(req.params.commentId)
    const existing = await deps.storage.getComment(commentId)
    if (!existing || existing.projectId !== project.id) {
      res.status(404).json({ error: "Comment not found" })
      return
    }
    // Same authorship rule as the content half of PATCH, and refused the
    // same way — a caller who may not rewrite a verified author's comment
    // must not be able to reach the same end by deleting it.
    if (!(await mayMutateCommentContent(deps.storage, ctx, project.id, existing.author))) {
      res.status(404).json({ error: "Comment not found" })
      return
    }
    try {
      await deps.storage.deleteComment(commentId)
      deps.changeBus.emit(project.id)
      res.status(204).send()
    } catch (deleteError) {
      if (deleteError instanceof NotFoundError) {
        res.status(404).json({ error: deleteError.message })
        return
      }
      throw deleteError
    }
  })

  return router
}
