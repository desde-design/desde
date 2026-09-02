/**
 * The boot-time line that tells an operator whether mention/sign-in email is
 * configured.
 *
 * Kept as a pure function, separate from `server/index.ts`, so the exact text
 * is unit-tested without booting a real server — same reasoning as
 * `originModeBannerLines` in `serve/origin-mode-banner.ts`.
 *
 * **Why this exists instead of `email ? … : …` inline.** `AppDeps.email` is a
 * `ReloadableEmailProvider` (see `reloadable-email-provider.ts`), and that
 * object is ALWAYS present — SMTP being configurable from the settings page
 * at runtime means a null captured at boot would stay null for the life of
 * the process. So the object itself is never falsy; whether SMTP is actually
 * set is `email.isConfigured()`. A boot-log line that tests the object's
 * truthiness instead of calling `isConfigured()` always prints "configured",
 * even on a fresh instance with no SMTP anywhere — this function exists so
 * that mistake has one place to happen instead of one per call site.
 */

export function emailStatusLine(email: { isConfigured(): boolean }): string {
  return `email=${email.isConfigured() ? "configured" : "not configured (VIEWER_SMTP_HOST unset)"}`
}
