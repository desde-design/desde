/**
 * Phase 5 of tasks/editor-detached-sessions.md — error classifier
 * for chat-turn failures.
 *
 * Why: the chat handler's catch arm currently writes a generic
 * "Chat handler failed: <message>" string into `ChatSession.statusReason`.
 * The chat tab strip renders this verbatim as a tooltip; the toast
 * surface renders it as a description. Both are correct for generic
 * errors, but they're noisy for the most-common-cause case: Anthropic
 * API rate limits.
 *
 * Anthropic responses with HTTP 429 (rate limited) bubble up through
 * the SDK with an error message containing "429" and/or "rate_limit".
 * The model often also includes a "retry after N seconds" hint. This
 * module sniffs those out and surfaces them as structured metadata so:
 *   - The tab strip can render a "Rate limited" badge (distinct from
 *     "Failed") so the user knows it's recoverable.
 *   - The toast can say "Try again in Ns" instead of dumping the
 *     full SDK error.
 *   - Future "automatic retry after the rate-limit window" logic has
 *     a known field to look at.
 *
 * Design: pure pattern-matching over the error message. We avoid
 * coupling to SDK-internal classes (`@anthropic-ai/sdk/RateLimitError`
 * etc.) because (a) tests would have to import SDK plumbing to fake an
 * error, and (b) message inspection generalises to provider-neutral
 * future error sources. The trade-off: a vendor's message format
 * change could break detection — but the worst case is degrading to
 * generic "failed", which is what we have today.
 */

/**
 * Classification kind. `rate-limited` covers Anthropic 429s + similar
 * provider rate-limit responses. Everything else is `other` — that
 * includes timeouts, bridge errors, tool failures, abort, and unknown
 * SDK throws. The tab strip / toast surface treats `other` like the
 * pre-Phase-5 generic "Failed" state.
 */
export type TurnFailureKind = 'rate-limited' | 'other'

export interface ClassifiedTurnError {
  kind: TurnFailureKind
  /**
   * Best-effort retry-after in seconds, parsed from the error
   * message. Undefined when the provider didn't include one (or our
   * patterns didn't match). Always whole seconds, capped at
   * `MAX_RETRY_AFTER_SECONDS` so a vendor returning "retry after
   * 9999999 seconds" doesn't translate to a UI showing a literal
   * decade.
   */
  retryAfterSeconds?: number
  /**
   * Sanitised message for display. We don't redact — Anthropic
   * messages don't contain secrets — but we strip noisy prefixes
   * the chat routes add (`Chat handler failed: `) so the toast /
   * tooltip reads cleanly. Returns the original string when no
   * known prefix was present.
   */
  message: string
}

const RATE_LIMITED_PATTERNS = [
  /\b429\b/,
  // Codex round-1 #5: anchor the left side with \b so phrases like
  // "separate limit" / "corporate limit" don't match. The right side
  // uses a non-letter lookahead (not \b) because `_` is a word
  // character — `\blimit\b` would reject the common Anthropic
  // shape `rate_limit_exceeded`. The lookahead allows underscore /
  // dash / EOL while still rejecting trailing letters (so
  // "ratelimitation" doesn't match).
  /\brate[_\s-]?limit(?:ed|s)?(?=[^a-zA-Z]|$)/i,
  /\btoo\s+many\s+requests\b/i,
]

// Authentication-failure detection. Editor's SDK runtime authenticates
// through the bundled `claude` CLI's subscription credentials (or an
// `ANTHROPIC_API_KEY` when set). When those credentials are expired /
// missing / rejected, Anthropic returns HTTP 401 and the SDK surfaces a
// throw whose message contains the shapes below. The raw string
// ("Failed to authenticate. API Error: 401 …") is accurate but
// non-actionable for an end user — they don't know it means "re-login
// your local CLI". We detect it and swap in `AUTH_REAUTH_MESSAGE`.
//
// Patterns are deliberately the high-specificity Anthropic/CLI markers
// (not a bare `401`, which could appear in unrelated payloads) so a
// non-auth error never gets mis-mapped to the re-login hint.
const AUTH_ERROR_PATTERNS = [
  /invalid authentication credentials/i,
  /\bauthentication_error\b/i,
  /failed to authenticate/i,
]

/**
 * Actionable message shown in place of the raw 401 string. Tells the user
 * exactly how to recover.
 *
 * The settings gear is named FIRST because it is the only recovery path a
 * desktop user has: an app launched from Finder inherits launchd's
 * environment, not a shell's, so `export ANTHROPIC_API_KEY=…` in a dotfile
 * never reaches it. The `claude` CLI instruction is kept for the subscription
 * path and for terminal users. See
 * `docs/superpowers/specs/2026-08-13-editor-llm-credentials-design.md` §8.
 */
export const AUTH_REAUTH_MESSAGE =
  'Authentication failed (401). The credentials Editor is using look expired ' +
  'or invalid. Add or replace your Anthropic API key from the settings gear, ' +
  'or run `claude` then `/login` to re-authenticate the CLI. Then start a new ' +
  'chat turn.'

const RETRY_AFTER_PATTERNS = [
  /retry[\s-]?after[\s:]+(\d+)/i,
  /try\s+again\s+in\s+(\d+)/i,
  /wait\s+(\d+)\s*(?:s|sec|seconds?)/i,
]

// Cap retry-after at 1 hour (3600s). Anthropic's published rate-limit
// reset windows are minutes, not hours; anything bigger is almost
// certainly a misparsed number (e.g. a timestamp).
const MAX_RETRY_AFTER_SECONDS = 3600

const NOISE_PREFIXES = [
  /^Chat handler failed:\s*/,
  /^Failed to persist session:\s*/,
]

/**
 * Stringify an unknown error. Used so callers can pass either an
 * `Error` object or the captured `turn.error` string from the
 * orchestrator without branching.
 */
function toMessage(value: unknown): string {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object' && 'message' in value) {
    const m = (value as { message?: unknown }).message
    if (typeof m === 'string') return m
  }
  // Last-resort coercion. JSON.stringify could be massive; settle for
  // String() which renders "[object Object]" for plain objects — fine
  // for downstream truncation.
  return String(value)
}

/**
 * Phase 5 rate-limit codex round-1 #1 fix: Anthropic puts the
 * retry-after window in the HTTP response `retry-after` header, NOT
 * the error message body. The SDK's `APIError` / `RateLimitError`
 * exposes the headers via an instance property. By the time the
 * orchestrator's catch arm stringifies the error, the header is
 * lost.
 *
 * Surface this helper so orchestrators can pull it out BEFORE
 * stringification and embed it in the message in a shape the regex
 * patterns can already parse (`retry after Ns`). Returns `undefined`
 * when the err shape doesn't carry headers, or the header is absent
 * / unparseable.
 *
 * Defensive: doesn't assume the SDK class name (which could change
 * between versions). Looks for `err.headers` shaped like a Fetch
 * Headers (with a `.get()` method) OR a plain record.
 */
export function extractRetryAfterFromError(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined
  const e = err as { headers?: unknown }
  if (!e.headers) return undefined
  let raw: unknown = undefined
  if (typeof e.headers === 'object' && e.headers !== null) {
    const h = e.headers as { get?: (k: string) => string | null }
    if (typeof h.get === 'function') {
      raw = h.get('retry-after')
    } else {
      // Plain record shape — accept lowercase, mixed-case, and
      // capitalised header names (Node's `http` IncomingMessage
      // headers are lowercased; Fetch Headers normalise too).
      const r = e.headers as Record<string, unknown>
      raw = r['retry-after'] ?? r['Retry-After'] ?? r['retryAfter']
    }
  }
  if (raw === null || raw === undefined) return undefined
  const n = typeof raw === 'string' ? parseInt(raw, 10) : Number(raw)
  if (!Number.isFinite(n) || n <= 0) return undefined
  return Math.min(n, MAX_RETRY_AFTER_SECONDS)
}

/**
 * True when the error message carries one of the Anthropic / CLI
 * authentication-failure markers. Exported so the SDK orchestrator can
 * rewrite the LIVE streamed error event (not just the persisted status)
 * with the same detection logic. Pure; never throws.
 */
export function isAuthError(rawError: unknown): boolean {
  const raw = toMessage(rawError)
  return AUTH_ERROR_PATTERNS.some((p) => p.test(raw))
}

function stripNoise(message: string): string {
  let out = message
  for (const pattern of NOISE_PREFIXES) {
    out = out.replace(pattern, '')
  }
  return out
}

function parseRetryAfter(message: string): number | undefined {
  for (const pattern of RETRY_AFTER_PATTERNS) {
    const m = message.match(pattern)
    if (m) {
      const n = parseInt(m[1], 10)
      if (Number.isFinite(n) && n > 0) {
        return Math.min(n, MAX_RETRY_AFTER_SECONDS)
      }
    }
  }
  return undefined
}

/**
 * Classify a chat-turn error. Pure: no I/O, no provider calls,
 * deterministic from the input message.
 *
 * Defensive: never throws. An empty / nullish / weird-shape input
 * coerces to `{ kind: 'other', message: '' }` so the tab strip /
 * toast renders SOMETHING and the route can persist a record.
 */
export function classifyTurnError(rawError: unknown): ClassifiedTurnError {
  const raw = toMessage(rawError)
  const message = stripNoise(raw)
  const isRateLimited = RATE_LIMITED_PATTERNS.some((p) => p.test(raw))
  if (!isRateLimited) {
    // Auth failures stay `kind: 'other'` (they're not recoverable by
    // waiting, so the rate-limit badge/retry UI doesn't apply) but get
    // an actionable message instead of the raw 401 string.
    if (isAuthError(raw)) {
      return { kind: 'other', message: AUTH_REAUTH_MESSAGE }
    }
    return { kind: 'other', message }
  }
  const retryAfterSeconds = parseRetryAfter(raw)
  return retryAfterSeconds !== undefined
    ? { kind: 'rate-limited', retryAfterSeconds, message }
    : { kind: 'rate-limited', message }
}
