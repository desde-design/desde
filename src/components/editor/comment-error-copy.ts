/**
 * Turn a comment-store failure into something a designer can act on.
 *
 * The store throws a diagnostic: `Comment API GET 502: {"error":"Could not
 * reach the viewer at http://localhost:3100"}`. That is the right thing for it
 * to throw — a bug report wants the verb, the status and the body — but the
 * panel was showing it verbatim, so the headline was a status code and a JSON
 * blob, and it said "failed to load" and "could not reach the viewer" in one
 * breath (Mo, 2026-09-14).
 *
 * Same split `live-prototype-pane.tsx` already makes for the bridge: the title
 * says what the reader can see and what to do, and the raw text moves to a
 * quiet second line where a bug report can still quote it. Nothing is thrown
 * away; it just stops being the first thing read.
 *
 * Pure and colocated so the mapping is testable without rendering a panel.
 */

export interface CommentErrorCopy {
  /** One sentence: what happened, and what to do about it. */
  title: string
  /** The original message, for a bug report. Always present. */
  detail: string
}

/** `Comment API GET 502: {…}` → 502. Null when the message is not that shape. */
function statusOf(raw: string): number | null {
  const match = raw.match(/Comment API [A-Z]+ (\d{3})\b/)
  return match?.[1] ? Number(match[1]) : null
}

/**
 * The server's own `error` string, when the body was JSON carrying one.
 *
 * Used to recover the viewer's address for the unreachable case, which is the
 * one detail the reader actually needs and cannot get anywhere else.
 */
function serverError(raw: string): string | null {
  const brace = raw.indexOf("{")
  if (brace === -1) return null
  try {
    const parsed = JSON.parse(raw.slice(brace)) as { error?: unknown }
    return typeof parsed.error === "string" ? parsed.error : null
  } catch {
    return null
  }
}

/** `http://localhost:3100` → `localhost:3100`. Falls back to the input. */
function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

export function describeCommentError(raw: string): CommentErrorCopy {
  const detail = raw
  const status = statusOf(raw)
  const fromServer = serverError(raw)

  // The address the proxy could not reach, pulled out of its own message so
  // the title can name it. Which viewer is down is the one thing a reader
  // needs here, and "502" does not say it.
  const unreachable = fromServer?.match(/Could not reach the viewer at (\S+)/)?.[1]
  if (unreachable) {
    return {
      title: `Could not reach your viewer at ${hostOf(unreachable)}. Check that it is running.`,
      detail,
    }
  }

  switch (status) {
    case 401:
      return {
        title:
          "Your viewer would not accept this editor's access token. Add a new one in Viewer project.",
        detail,
      }
    case 403:
      return {
        title: "Your viewer refused this request. Your account may not have access to this project.",
        detail,
      }
    case 404:
      return {
        title: "This project is not on your viewer any more. Choose another in Viewer project.",
        detail,
      }
    case 502:
      // A 502 whose body did not name an address — still the proxy failing to
      // reach the viewer, just without the detail to quote.
      return { title: "Could not reach your viewer. Check that it is running.", detail }
    case 503:
      return { title: "No viewer is set up for this repo. Set one up in Viewer project.", detail }
    default:
      return { title: "Could not load comments from your viewer.", detail }
  }
}
