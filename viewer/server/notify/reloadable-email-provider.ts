import { createSmtpEmailProvider, type SmtpConfig } from "./smtp-email-provider"
import type { EmailProvider } from "./email-provider"

/**
 * An `EmailProvider` whose SMTP settings can change while the process runs.
 *
 * It exists because mention mail became editable from the settings page
 * (2026-08-26). Before that, `index.ts` built one provider at boot from
 * `config.email` and never reassigned it — a comment in `auth-routes.ts` said
 * so outright, that "SMTP has no equivalent live reconfiguration story: it is
 * set once, at boot". Saving a form that only takes effect after a restart is
 * the shape of bug where the user believes the save failed and does it again.
 *
 * ## Always present, sometimes unconfigured
 *
 * `deps.email` used to be `EmailProvider | null`, and callers branched on the
 * null to mean "no SMTP". That cannot survive runtime configuration: the
 * value is captured once when the app is built, so a null at boot would stay
 * null for the life of the process no matter what an admin saved.
 *
 * So the provider is always there and answers `isConfigured()` instead. The
 * old `if (!deps.email) return` sites became `if (!deps.email.isConfigured())`
 * — the same question, asked of something that can change its mind.
 *
 * ## One transport, rebuilt only when the settings change
 *
 * `index.ts`'s original comment is still binding: two `createSmtpEmailProvider`
 * calls mean two nodemailer transports, which is two connection pools against
 * one SMTP server. The delegate here is created lazily and reused, and
 * `reconfigure` drops it so the next send builds one from the new settings.
 * Reconfiguring with settings that are deep-equal to the current ones is a
 * no-op, so re-saving an unchanged form does not cycle the pool.
 */
export interface ReloadableEmailProvider extends EmailProvider {
  /** False when no SMTP is set. `send` refuses rather than attempting. */
  isConfigured(): boolean
  /** Swap the settings. `null` turns sending off. */
  reconfigure(config: SmtpConfig | null): void
}

function sameConfig(a: SmtpConfig | null, b: SmtpConfig | null): boolean {
  if (a === null || b === null) return a === b
  return (
    a.host === b.host &&
    a.port === b.port &&
    a.user === b.user &&
    a.pass === b.pass &&
    a.from === b.from
  )
}

export function createReloadableEmailProvider(
  initial: SmtpConfig | null,
): ReloadableEmailProvider {
  let config: SmtpConfig | null = initial
  let delegate: EmailProvider | null = null

  return {
    isConfigured: () => config !== null,

    reconfigure(next) {
      if (sameConfig(config, next)) return
      config = next
      // Dropped, not rebuilt: the next send makes one. Nothing here should
      // open a connection as a side effect of an admin pressing Save.
      delegate = null
    },

    async send(to, subject, html, opts) {
      if (config === null) return false
      delegate ??= createSmtpEmailProvider(config)
      return delegate.send(to, subject, html, opts)
    },
  }
}
