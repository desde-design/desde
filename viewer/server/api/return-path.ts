/**
 * Where a sign-in may send someone afterwards.
 *
 * `GET /auth/github` accepts `?next=…` so a flow that starts inside the app
 * can resume where it began — the repo wizard's "Connect GitHub access"
 * needs the reader back in the dialog they left, not on the dashboard the
 * callback has always redirected to (Mo, 2026-08-29).
 *
 * ## This is an open-redirect gate, and it is the whole reason for the file
 *
 * A `next` parameter on an auth route is the classic footgun: an attacker
 * sends `…/auth/github?next=https://evil.example`, the victim signs in
 * believing they are on this deployment, and the callback hands them to a
 * page that can imitate it while holding a freshly-minted session. So this
 * accepts ONLY a same-origin, absolute PATH, and everything else falls back
 * to `/`. Nothing is thrown and nothing is reported: a bad `next` is treated
 * as no `next`, because a redirect that refuses loudly still tells the
 * attacker which shapes get through.
 *
 * The rules, and the reason each one is not covered by the one above it:
 *
 * - **Must start with a single `/`.** Rejects `https://evil`, `//evil`
 *   (protocol-relative, which browsers resolve as a host), and any bare
 *   word that would resolve relative to the current path.
 * - **Must not contain a backslash.** `/\evil.example` is normalised to
 *   `//evil.example` by some browsers, so a `/`-prefix check alone is not
 *   enough.
 * - **Must not contain a control character or whitespace.** A `\n` in a
 *   redirect target is header injection; a leading space can survive the
 *   prefix check and then be trimmed by a client.
 * - **Parses as a URL against a throwaway base, and the origin must not
 *   move.** The backstop for anything the character rules missed —
 *   percent-encoded hosts and future browser quirks — because it asks the
 *   URL parser the same question the browser will.
 * - **The RESULT is re-checked, not just the input.** This one is not
 *   belt-and-braces: `/..//evil.example` passes every input rule (starts
 *   with a single `/`, no backslash, no control characters) and its origin
 *   does not move when parsed — but the parser NORMALISES it to
 *   `//evil.example`, which is protocol-relative, so returning it would have
 *   handed the browser another origin. Caught by the property test below,
 *   not by reading the rules.
 *
 * The length cap is not a security rule; it stops a multi-kilobyte query
 * string riding in a cookie.
 */

/** Longer than any real in-app path, short enough not to bloat a cookie. */
const MAX_RETURN_PATH_LENGTH = 512

/** Where a missing or rejected `next` lands. The dashboard, as before. */
export const DEFAULT_RETURN_PATH = "/"

/**
 * `value` if it is a safe same-origin path, else {@link DEFAULT_RETURN_PATH}.
 *
 * Total by design: every caller gets a usable path back, so no call site has
 * to remember to handle a refusal.
 */
export function safeReturnPath(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_RETURN_PATH
  if (value.length === 0 || value.length > MAX_RETURN_PATH_LENGTH) return DEFAULT_RETURN_PATH
  if (!value.startsWith("/")) return DEFAULT_RETURN_PATH
  // Protocol-relative: `//host` and `/\host` both resolve to another origin.
  if (value.startsWith("//") || value.startsWith("/\\")) return DEFAULT_RETURN_PATH
  if (value.includes("\\")) return DEFAULT_RETURN_PATH
  // Control characters and whitespace anywhere — header injection, and
  // leading/trailing space that a client may trim after this check.
  if (/[\x00-\x20\x7f]/.test(value)) return DEFAULT_RETURN_PATH

  // The backstop: ask the URL parser what the browser will conclude. The base
  // is arbitrary and never appears in the result — only whether the origin
  // survived matters.
  try {
    const base = "https://viewer.invalid"
    const resolved = new URL(value, base)
    if (resolved.origin !== base) return DEFAULT_RETURN_PATH
    const path = `${resolved.pathname}${resolved.search}${resolved.hash}`
    // Re-check the NORMALISED path. `/..//evil.example` satisfies every rule
    // above and then normalises to `//evil.example` — protocol-relative, and
    // a different origin the moment a browser resolves it.
    if (!path.startsWith("/") || path.startsWith("//") || path.startsWith("/\\")) {
      return DEFAULT_RETURN_PATH
    }
    return path
  } catch {
    return DEFAULT_RETURN_PATH
  }
}
