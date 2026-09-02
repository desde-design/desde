"use client"

/**
 * One place that turns a failed request into something worth showing a
 * person.
 *
 * It exists because the screens were showing the wire. A failed project load
 * rendered `Failed to fetch: /api/v1/projects` under "Couldn't load
 * projects"; other surfaces rendered `HTTP 500`. Both name a thing the reader
 * did not ask about and cannot act on (Mo, 2026-08-19). An endpoint path is
 * not an explanation — it is the shape of our code leaking through a hole in
 * the copy.
 *
 * The rule this encodes: **a message written BY a human FOR a human may be
 * shown; a transport failure may not.** The server's 4xx bodies are the first
 * kind — "A project with that slug already exists" is better than anything
 * this module could invent, so it is passed through untouched. A status code
 * or a fetch exception is the second kind, and gets replaced by a sentence
 * that says what the reader can do next.
 *
 * The technical detail is not thrown away. It stays on the `Error` (so a
 * `console.error` in devtools still names the endpoint and the status) and
 * only `failureMessage` decides what reaches the screen.
 */

/** A request that came back wrong, carrying enough to decide what to say. */
export class ApiError extends Error {
  constructor(
    /** The HTTP status, or `0` when the request never got a response at all. */
    readonly status: number,
    /**
     * The `{ error }` string the server sent, when it sent one. Null for a
     * transport failure or a body that carried no message — and null is what
     * makes `failureMessage` fall back to its own words instead of inventing
     * a quote the server never said.
     */
    readonly serverMessage: string | null,
    /** The URL, kept for the console. NEVER rendered. */
    readonly url: string,
  ) {
    super(serverMessage ?? `HTTP ${status} — ${url}`)
    this.name = "ApiError"
  }
}

/**
 * GET/POST JSON, throwing `ApiError` on anything that isn't a 2xx.
 *
 * Replaces the `res.ok ? res.json() : Promise.reject(new Error(\`HTTP ${status}\`))`
 * ladder that was copied into every fetching component — which is how the
 * status codes got onto the screen in the first place: each copy built its
 * own message, and a message built at the fetch site has no idea whether it
 * will be rendered.
 */
export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(url, init)
  } catch (cause) {
    // No response at all — offline, DNS, the server not running.
    console.error(`[viewer] request failed: ${url}`, cause)
    throw new ApiError(0, null, url)
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: unknown } | null
    const serverMessage = typeof body?.error === "string" ? body.error : null
    throw new ApiError(res.status, serverMessage, url)
  }
  return (await res.json()) as T
}

/**
 * What to put on the screen for a caught failure.
 *
 * Each branch is written to end in something the reader can DO. "The server
 * had a problem" alone leaves them staring at it; "try again in a moment"
 * tells them the next move is waiting rather than fixing.
 */
export function failureMessage(err: unknown): string {
  if (err instanceof ApiError) {
    // The server wrote prose for a person. It knows more than we do here.
    if (err.serverMessage) return err.serverMessage
    if (err.status === 0) return "Couldn't reach the server. Check your connection and try again."
    if (err.status === 401) return "You're signed out. Sign in and try again."
    if (err.status === 403) return "You don't have access to this."
    if (err.status === 404) return "This isn't here any more."
    if (err.status >= 500) return "The server had a problem. Try again in a moment."
  }
  return "Something went wrong. Try again."
}
