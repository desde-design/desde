import nodemailer, { type Transporter } from "nodemailer"
import type { EmailProvider } from "./email-provider"

export interface SmtpConfig {
  host: string
  port: number
  user: string
  pass: string
  from: string
}

/**
 * Builds an `EmailProvider` around an already-constructed nodemailer
 * transport. Exported so tests can pass a `jsonTransport: true` transport —
 * which serializes the composed message instead of opening a socket — and
 * exercise the real send()/header-mapping logic below without touching the
 * network. `createSmtpEmailProvider` is just this wired to a real SMTP
 * transport.
 */
export function createEmailProviderForTransport(transport: Transporter, from: string): EmailProvider {
  return {
    async send(to, subject, html, opts) {
      try {
        await transport.sendMail({
          from,
          to,
          subject,
          html,
          headers: opts?.listUnsubscribe
            ? {
                "List-Unsubscribe": `<${opts.listUnsubscribe}>`,
                "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
              }
            : undefined,
        })
        return true
      } catch (err) {
        console.error(`[viewer] SMTP send to ${to} failed:`, err)
        return false
      }
    },
  }
}

export function createSmtpEmailProvider(config: SmtpConfig): EmailProvider {
  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.port === 465,
    auth: { user: config.user, pass: config.pass },
  })
  return createEmailProviderForTransport(transport, config.from)
}
