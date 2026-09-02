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
 */

import { SIGN_IN_LINK_TTL_MINUTES } from "../auth/auth-constants"
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

function emailShell(bodyHtml: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:24px 0;"><tr><td align="center">
<table width="480" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;overflow:hidden;">
  <tr><td style="padding:24px;">
    ${bodyHtml}
  </td></tr>
  <tr><td style="padding:16px 24px;border-top:1px solid #eee;text-align:center;">
    <p style="margin:0;color:#bbb;font-size:11px;">Desde</p>
  </td></tr>
</table></td></tr></table></body></html>`
}

function ctaButton(url: string, label: string): string {
  return `<p style="margin:16px 0;text-align:center;"><a href="${url}" style="display:inline-block;padding:10px 24px;background:#E84F9C;color:#fff;text-decoration:none;border-radius:6px;font-size:14px;font-weight:600;">${label}</a></p>`
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

  const html = emailShell(`
    <p style="margin:0 0 12px;font-size:14px;color:#333;line-height:1.5;">You've been invited to a Desde viewer as ${rolePhrase}.</p>
    ${ctaButton(url, "Accept invite")}
    <p style="margin:12px 0 0;font-size:13px;color:#666;line-height:1.5;">The link signs you in. It expires in 7 days.</p>
  `)

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

  const html = emailShell(`
    <p style="margin:0 0 12px;font-size:14px;color:#333;line-height:1.5;">Here's your sign-in link for Desde.</p>
    ${ctaButton(url, "Sign in")}
    <p style="margin:12px 0 0;font-size:13px;color:#666;line-height:1.5;">This link expires in ${duration}. If you didn't request this, ignore it.</p>
  `)

  return { subject, html }
}
