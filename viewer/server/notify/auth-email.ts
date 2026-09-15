/**
 * Auth email templates — invite and sign-in link emails.
 *
 * Mirrors `mention-email.ts`'s conventions: a pure module (no I/O, no
 * Node-only imports) so it stays unit-testable in isolation and reusable
 * verbatim by whatever wires it to a sender (Task 14). `escapeHtml` is
 * copied rather than imported from `mention-email.ts` — that module does not
 * export it, and duplicating four lines beats reaching across an unrelated
 * module's internals.
 *
 * The only dynamic inputs are the URL (both templates) and the role
 * (invite only). Both are rendered exactly once, and the URL is the only
 * thing HTML-escaped — the role comes from the `InstanceRole` union, not
 * from user input, so it is rendered as a fixed phrase rather than escaped
 * free text.
 *
 * ## The footer wordmark
 *
 * The footer used to be the word "Desde" as a grey text node. It is the real
 * mark now, and the mark is a PNG served from this viewer
 * (`WORDMARK_PNG_PATH`, served by `api/auth-page-assets.ts` — the path is
 * declared in `auth/auth-constants.ts` so this module does not have to import
 * the route layer) rather than inline SVG or a `data:` URI, because
 * Gmail strips `<svg>` and both Gmail and Outlook refuse `data:` image
 * sources. See `auth-page-assets.ts`.
 *
 * The origin is derived from the link ALREADY in the email rather than
 * passed in. That keeps both call sites unchanged, and — more usefully —
 * makes it impossible for the logo to point at a different deployment than
 * the button: there is one origin in the email because there is one input it
 * can come from. A URL that will not parse falls back to the old text node,
 * so the footer degrades rather than breaking.
 */

import { SIGN_IN_LINK_TTL_MINUTES, WORDMARK_PNG_PATH } from "../auth/auth-constants"
import type { InstanceRole } from "../storage/types"

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

/** Grammatically correct article + role, e.g. "a viewer" / "an editor". */
const ROLE_PHRASE: Record<InstanceRole, string> = {
  viewer: "a viewer",
  editor: "an editor",
  admin: "an admin",
}

/** The brand aqua — `--primary` under `[data-theme="teal"]`, as sRGB hex. */
const AQUA = "#00918a"

/**
 * One type treatment for the whole message body.
 *
 * The invite and sign-in emails each used to be two paragraphs at two sizes
 * in two greys, split by the button: the offer above it, the caveat below.
 * Mo's call (2026-09-15) is that there is only one thing to say, so it is one
 * block at one size above the button.
 */
const BODY_TEXT = "margin:0;font-size:14px;color:#333;line-height:1.5;"

/**
 * The wordmark `<img>`, or the old text node if `linkUrl` will not parse.
 *
 * Width and height are attributes as well as CSS: Outlook's Word renderer
 * ignores the style block on an image and would otherwise draw the PNG at its
 * full 122x32. `display:block` inside a centred cell rather than an inline
 * image, so no line-box descender gap appears under it.
 */
function footerMark(linkUrl: string): string {
  let origin: string
  try {
    origin = new URL(linkUrl).origin
  } catch {
    return `<p style="margin:0;color:#bbb;font-size:11px;">Desde</p>`
  }
  const src = escapeHtml(`${origin}${WORDMARK_PNG_PATH}`)
  return `<img src="${src}" width="61" height="16" alt="Desde" style="display:block;margin:0 auto;width:61px;height:16px;border:0;">`
}

function emailShell(bodyHtml: string, linkUrl: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:24px 0;"><tr><td align="center">
<table width="480" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;overflow:hidden;">
  <tr><td style="padding:24px;">
    ${bodyHtml}
  </td></tr>
  <tr><td style="padding:16px 24px;border-top:1px solid #eee;text-align:center;">
    ${footerMark(linkUrl)}
  </td></tr>
</table></td></tr></table></body></html>`
}

function ctaButton(url: string, label: string): string {
  return `<p style="margin:20px 0 0;text-align:center;"><a href="${url}" style="display:inline-block;padding:10px 24px;background:${AQUA};color:#fff;text-decoration:none;border-radius:6px;font-size:14px;font-weight:600;">${label}</a></p>`
}

/**
 * Build the "you're invited" email. `role` is rendered as a plain word
 * ("as a viewer" / "as an editor" / "as an admin") — the invite grants that
 * role on accept.
 */
export function inviteEmail(opts: { inviteUrl: string; role: InstanceRole }): { subject: string; html: string } {
  const subject = "You're invited to a Desde viewer"
  const url = escapeHtml(opts.inviteUrl)
  const rolePhrase = ROLE_PHRASE[opts.role]

  const html = emailShell(
    `
    <p style="${BODY_TEXT}">You've been invited to a Desde viewer as ${rolePhrase}. The link signs you in. It expires in 7 days.</p>
    ${ctaButton(url, "Accept invite")}
  `,
    opts.inviteUrl,
  )

  return { subject, html }
}

/**
 * Build the "sign in" email for the local-operator / passwordless link flow.
 *
 * `expiresInMinutes` defaults to `SIGN_IN_LINK_TTL_MINUTES`, the same constant
 * `POST /auth/magic-link` derives its token expiry from. The duration used to
 * be the literal words "15 minutes" here and a separate
 * `15 * 60 * 1000` in the route — two copies of one policy, in modules that
 * cannot import each other's layer. Nothing would fail if they drifted: the
 * link would simply die earlier or later than the sentence promises, and the
 * only symptom would be a person insisting their link expired early. One
 * constant, read by both.
 */
export function signInEmail(opts: { signInUrl: string; expiresInMinutes?: number }): {
  subject: string
  html: string
} {
  const subject = "Your sign-in link"
  const url = escapeHtml(opts.signInUrl)
  const minutes = opts.expiresInMinutes ?? SIGN_IN_LINK_TTL_MINUTES
  const duration = `${minutes} minute${minutes === 1 ? "" : "s"}`

  const html = emailShell(
    `
    <p style="${BODY_TEXT}">Here's your sign-in link for Desde. It expires in ${duration}. If you didn't request this, ignore it.</p>
    ${ctaButton(url, "Sign in")}
  `,
    opts.signInUrl,
  )

  return { subject, html }
}
