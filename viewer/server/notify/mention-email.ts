/**
 * @mention notification rendering + outbox processing.
 *
 * PORT of oss-comments' `packages/core/src/notify.ts` — verbatim except the
 * product name in the email footer / unsubscribe-confirmation copy
 * (`oss-comments` → `Desde`). Kept PURE (zero deps beyond Web Crypto) on
 * purpose: it is unit-testable in Node and reused verbatim by the outbox
 * drain (`outbox-drain.ts`), which supplies the I/O via `ProcessIntentDeps`.
 */

/**
 * Must stay identical to `MENTION_PATTERN` in
 * `src/components/annotations/mention-encoding.ts`, which is what WRITES these
 * tokens. A private copy on purpose: this module is deliberately dependency
 * free so the outbox drain can reuse it verbatim.
 *
 * The name group excludes `[` as well as `]`. Without that, a literal `@[`
 * earlier in a body starts a match that runs through the next real mention and
 * swallows it, so the email would render one mangled name in place of the text
 * and the person who was actually mentioned.
 */
const MENTION_PATTERN = /@\[([^[\]]+)\]\(([^)]+)\)/g

/** `@[Name](id)` → `@Name` for human-readable email text. Mirrors core. */
function stripMentionSyntax(body: string): string {
  return body.replace(MENTION_PATTERN, "@$1")
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

/** Longest attacker-influenced fragment allowed into a header line. */
const MAX_SUBJECT_FRAGMENT_CHARS = 120

/**
 * Strips CR, LF and other C0/C1 control characters, collapses whitespace and
 * truncates — for any value interpolated into a mail HEADER.
 *
 * Nodemailer's mime-node already folds a newline rather than emitting a raw
 * one, so this is not what stands between the product and a smuggled `Bcc:`
 * (the audit checked, and CRLF does NOT smuggle a header here). It is
 * defence in depth against a future sender that is less careful, plus the
 * plain hygiene of not letting a self-declared name push a subject line to
 * an arbitrary length.
 */
function headerSafe(text: string): string {
  // C0 (which includes CR and LF) + DEL + C1, written as \u escapes
  // rather than literal control characters so the source stays greppable.
  const cleaned = text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim()
  return cleaned.length > MAX_SUBJECT_FRAGMENT_CHARS
    ? `${cleaned.slice(0, MAX_SUBJECT_FRAGMENT_CHARS - 1)}…`
    : cleaned
}

export interface MentionComment {
  id: string
  number: number
  body: string
  authorName: string
  projectId: string
  /**
   * Human-readable project name for the subject/body — NOT `projectId`, which
   * in production is a UUID (`getProject(id).name`, falling back to `.slug`,
   * falling back to `projectId` itself if the project record is somehow
   * gone). Callers populate this; `mentionEmail` never derives it.
   */
  projectName: string
  /**
   * The project's URL-safe slug — used (not `projectId`) to build the "View
   * comment" CTA's deep link to the review surface at `/review/<slug>`.
   * Callers populate this the same way as `projectName` (falls back to the
   * raw id if the project record is somehow gone).
   */
  projectSlug: string
}

export interface MentionRecipient {
  email: string
  name?: string
  /** Stable participant id — used to build the signed unsubscribe link. */
  participantId?: string
}

/** Build the "you were mentioned" email for one recipient. */
export function mentionEmail(
  comment: MentionComment,
  recipientName?: string,
  baseUrl?: string,
  unsubscribeUrl?: string,
): { subject: string; html: string } {
  const author = escapeHtml(headerSafe(comment.authorName))
  const project = escapeHtml(comment.projectName)
  const body = escapeHtml(stripMentionSyntax(comment.body))
  const greeting = recipientName ? `Hi ${escapeHtml(recipientName)},` : "Hi,"
  // The AUTHOR NAME is deliberately NOT in the subject (security audit B5).
  // `authorName` is whatever the comment's `author.displayName` said, and on
  // a public-link project that is a self-declared, unverified string an
  // anonymous caller chose — so a subject built from it reads as
  // `"Workday Security Alert mentioned you on Acme"`, sent from the
  // operator's own SMTP identity and passing SPF/DKIM. The subject line is
  // the single most trusted piece of an email, so nothing unverified goes in
  // it. The name still appears in the BODY, escaped and visibly framed as
  // comment content, where it is informative rather than authoritative.
  //
  // `projectName` stays: setting it requires the admin bearer or a
  // write-scoped PAT owning the project, i.e. the operator's own side.
  const subject = `You were mentioned on ${headerSafe(comment.projectName)}`

  // `baseUrl` is the bare public origin (`config.publicUrl` — no path, no
  // query); the review surface lives at `/review/<slug>`, so the CTA has to
  // route there explicitly rather than just appending `?commentId=` to the
  // origin — otherwise every recipient lands on the project-list home page
  // instead of their comment (Fix 2, phase-2b-2 review).
  const link = baseUrl
    ? `${baseUrl}/review/${encodeURIComponent(comment.projectSlug)}?commentId=${encodeURIComponent(comment.id)}`
    : ""
  const cta = link
    ? `<tr><td style="padding:0 24px 24px;" align="center">
        <a href="${escapeHtml(link)}" style="display:inline-block;padding:10px 24px;background:#E84F9C;color:#fff;text-decoration:none;border-radius:6px;font-size:14px;font-weight:600;">View comment</a>
      </td></tr>`
    : ""

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:24px 0;"><tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;overflow:hidden;">
  <tr><td style="padding:24px 24px 8px;">
    <p style="margin:0;font-size:13px;color:#666;">${greeting} <strong>${author}</strong> mentioned you on <strong>${project}</strong> (comment #${comment.number}).</p>
  </td></tr>
  <tr><td style="padding:8px 24px 16px;">
    <div style="padding:12px 16px;background:#f9f9f9;border-radius:6px;border-left:3px solid #E84F9C;">
      <p style="margin:0;font-size:14px;color:#333;line-height:1.5;">${body}</p>
    </div>
  </td></tr>
  ${cta}
  <tr><td style="padding:16px 24px;border-top:1px solid #eee;text-align:center;">
    ${
      unsubscribeUrl
        ? `<p style="margin:0 0 4px;font-size:11px;"><a href="${escapeHtml(unsubscribeUrl)}" style="color:#999;text-decoration:underline;">Unsubscribe</a></p>`
        : ""
    }
    <p style="margin:0;color:#bbb;font-size:11px;">Desde</p>
  </td></tr>
</table></td></tr></table></body></html>`

  return { subject, html }
}

export interface SendOptions {
  /** RFC 8058 one-click unsubscribe URL → `List-Unsubscribe` header. */
  listUnsubscribe?: string
}

export interface ProcessIntentDeps {
  /** The outbox row being processed. */
  intent: { id: string; commentId: string; recipientIds: string[] }
  getComment: (commentId: string) => Promise<MentionComment | null>
  /** Resolve recipient participant ids → emails (server-side, service role). */
  getRecipients: (ids: string[]) => Promise<MentionRecipient[]>
  send: (to: string, subject: string, html: string, opts?: SendOptions) => Promise<boolean>
  setStatus: (intentId: string, status: "sent" | "error") => Promise<void>
  baseUrl?: string
  /** Returns true if this recipient opted out of this project (or globally). */
  isUnsubscribed?: (
    recipient: { participantId?: string; email: string },
    projectId: string,
  ) => Promise<boolean>
  /** Enables signed unsubscribe links + the List-Unsubscribe header. */
  unsubscribe?: { secret: string; endpoint: string }
}

export interface ProcessResult {
  sent: number
  failed: string[]
  /** Recipients with no deliverable email (e.g. anonymous authors). */
  skipped: number
  /** Recipients skipped because they previously unsubscribed. */
  unsubscribed: number
}

/**
 * Send one mention email per resolvable recipient, then mark the intent
 * `sent` (all delivered) or `error` (any failure / missing comment). Recipients
 * without an email are skipped; recipients who unsubscribed are excluded. When
 * `unsubscribe` is configured, each email carries a signed one-click unsubscribe
 * link (footer + `List-Unsubscribe` header). Idempotency is the caller's concern.
 */
export async function processIntent(deps: ProcessIntentDeps): Promise<ProcessResult> {
  const comment = await deps.getComment(deps.intent.commentId)
  if (!comment) {
    await deps.setStatus(deps.intent.id, "error")
    return { sent: 0, failed: ["comment-missing"], skipped: 0, unsubscribed: 0 }
  }

  const resolved = await deps.getRecipients(deps.intent.recipientIds)
  const deliverable = resolved.filter((r) => r.email)
  const skipped = resolved.length - deliverable.length

  let sent = 0
  let unsubscribed = 0
  const failed: string[] = []
  for (const r of deliverable) {
    if (deps.isUnsubscribed && (await deps.isUnsubscribed(r, comment.projectId))) {
      unsubscribed++
      continue
    }

    let unsubscribeUrl: string | undefined
    if (deps.unsubscribe && r.participantId) {
      const token = await signUnsubscribeToken(deps.unsubscribe.secret, {
        participantId: r.participantId,
        projectId: comment.projectId,
      })
      unsubscribeUrl = appendQuery(deps.unsubscribe.endpoint, `token=${token}`)
    }

    const { subject, html } = mentionEmail(comment, r.name, deps.baseUrl, unsubscribeUrl)
    const ok = await deps.send(
      r.email,
      subject,
      html,
      unsubscribeUrl ? { listUnsubscribe: unsubscribeUrl } : undefined,
    )
    if (ok) sent++
    else failed.push(r.email)
  }

  await deps.setStatus(deps.intent.id, failed.length > 0 ? "error" : "sent")
  return { sent, failed, skipped, unsubscribed }
}

function appendQuery(url: string, query: string): string {
  return `${url}${url.includes("?") ? "&" : "?"}${query}`
}

// ── One-click unsubscribe ────────────────────────────────────────────────
//
// A signed, stateless token: `base64url(payload) . base64url(HMAC-SHA256(payload))`.
// The sender mints it (it holds the secret); the unsubscribe endpoint verifies it
// with the same secret, so the link can't be forged to opt out arbitrary people.
// Uses Web Crypto (Node/Deno/browser) so this module stays dependency-free.

export interface UnsubscribePayload {
  participantId: string
  projectId: string
}

const enc = new TextEncoder()
const dec = new TextDecoder()

function b64urlFromBytes(bytes: Uint8Array): string {
  let bin = ""
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function bytesFromB64url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function hmacB64url(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data))
  return b64urlFromBytes(new Uint8Array(sig))
}

/** Constant-time string compare (avoids signature-timing leaks). */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** Mint a signed unsubscribe token for `{ participantId, projectId }`. */
export async function signUnsubscribeToken(
  secret: string,
  payload: UnsubscribePayload,
): Promise<string> {
  const body = b64urlFromBytes(
    enc.encode(JSON.stringify({ p: payload.participantId, j: payload.projectId })),
  )
  const sig = await hmacB64url(secret, body)
  return `${body}.${sig}`
}

/** Verify a token; returns the payload, or null if missing/tampered. */
export async function verifyUnsubscribeToken(
  secret: string,
  token: string,
): Promise<UnsubscribePayload | null> {
  const dot = token.indexOf(".")
  if (dot <= 0) return null
  const body = token.slice(0, dot)
  const sig = token.slice(dot + 1)
  const expected = await hmacB64url(secret, body)
  if (!timingSafeEqual(sig, expected)) return null
  try {
    const o = JSON.parse(dec.decode(bytesFromB64url(body))) as { p?: unknown; j?: unknown }
    if (typeof o.p === "string" && typeof o.j === "string") {
      return { participantId: o.p, projectId: o.j }
    }
  } catch {
    // fall through
  }
  return null
}

/**
 * Confirmation page shown after an unsubscribe click. Always project-scoped
 * copy: participants are per-project rows (a distinct `randomUUID()` per
 * `(project_id, email)` pair — see `sqlite-storage.ts`'s
 * `participants_by_project_email` index), so the same human has a different
 * `participantId` in every project. A `scope=global` opt-out
 * (`{participantId, projectId: null}`, see `StorageAdapter.recordOptout`)
 * therefore only ever suppresses the ONE project whose participant row
 * minted that id — it cannot reach a different project's row for the same
 * person. Promising "all Desde emails" here would be false, so this
 * page never says it; a genuinely cross-project opt-out needs one identity
 * per person across projects, which arrives with Phase 3 auth (see
 * README.md § Mention notifications). Do not reintroduce "all Desde
 * emails" / global-scope wording without that identity layer landing first.
 *
 * `projectName` is the human-readable name — NOT the raw project id (a UUID
 * in production). Callers resolve it the same way the mention-email
 * subject/body does (`resolveProjectName` in `outbox-drain.ts`).
 */
export function unsubscribeConfirmationHtml(opts: { projectName: string }): string {
  const project = escapeHtml(opts.projectName)
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f5f5f5;">
<div style="max-width:480px;margin:64px auto;background:#fff;border-radius:8px;padding:32px;text-align:center;">
  <h2 style="margin:0 0 8px;font-size:18px;color:#222;">Unsubscribed</h2>
  <p style="margin:0;font-size:14px;color:#444;">You won't get mention emails for <strong>${project}</strong> anymore.</p>
</div></body></html>`
}

/**
 * Build a `scope=global` unsubscribe URL (token + `scope=global` query).
 * NOT linked to from `unsubscribeConfirmationHtml` (removed there in the
 * phase-2b-2 review's Fix 3 — see that function's doc comment for why an
 * "unsubscribe from everything" affordance can't be offered honestly yet).
 * Kept as a building block for the `/unsubscribe?scope=global` route path
 * and any future caller that mints these links directly.
 */
export function globalUnsubscribeUrl(endpoint: string, token: string): string {
  return appendQuery(appendQuery(endpoint, `token=${token}`), "scope=global")
}
