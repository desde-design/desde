/**
 * Email delivery seam. Notification code depends on this interface only —
 * never on `nodemailer` or any transport directly — so delivery can be
 * swapped (SMTP today; SES/Postmark/etc. later) without touching callers.
 *
 * When `config.email` is null (no SMTP configured — see `server/config.ts`),
 * callers hold notifications rather than constructing a provider; there is
 * no "no-op" EmailProvider impl here on purpose, to keep "unconfigured" and
 * "configured but failing" distinguishable at the call site.
 */

export interface SendEmailOptions {
  /** Absolute unsubscribe URL. When set, applied as a `List-Unsubscribe` header. */
  listUnsubscribe?: string
}

export interface EmailProvider {
  /** Resolves `true` on accepted send, `false` on failure. Never throws. */
  send(to: string, subject: string, html: string, opts?: SendEmailOptions): Promise<boolean>
}

export { createSmtpEmailProvider } from "./smtp-email-provider"
export type { SmtpConfig } from "./smtp-email-provider"
