/**
 * The cookies one server prototype's child has set, kept HERE and replayed to
 * the child on every proxied request, so the browser never has to store them
 * (codex round 60).
 *
 * In loopback mode the shell (`localhost:3100`) and a prototype
 * (`127.0.0.1:<port>`, or `<id>.localhost:<port>`) are different SITES to a
 * browser, and the prototype is a frame inside the shell. A cookie the child
 * sets in that frame is a third-party cookie: `SameSite=Lax` (the default) is
 * never sent back on the frame's own requests, and third-party cookie
 * blocking refuses the rest. A session-backed prototype, the very thing a
 * server prototype exists to review, could not keep a session. Sharing the
 * shell's host across ports would hand the shell's own cookies to the
 * prototype, so the jar lives on this side instead: one per deployment, in
 * memory, for the machine's one reviewer (loopback mode is a same-machine
 * mode by construction).
 *
 * Honours the attributes that decide whether a cookie still applies: `Path`
 * (with RFC 6265's default path, the directory of the request that set it,
 * when the child names none), `Max-Age` and `Expires`. A cookie is keyed by
 * name AND path, as a browser keys it, so `session` for `/` and `session`
 * for `/admin` coexist, and a request gets the matching ones longest path
 * first (codex round 61). Everything else (`Secure`, `HttpOnly`,
 * `SameSite`, `Domain`) speaks to a browser and has no meaning for a jar the
 * browser never sees.
 */
interface StoredCookie {
  value: string
  path: string
  /** Epoch milliseconds, or `null` for a session cookie (lives as long as the jar). */
  expiresAt: number | null
}

export class ChildCookieJar {
  /** Keyed by path and name together, the way a browser's jar is. */
  private readonly cookies = new Map<string, StoredCookie & { name: string }>()

  /**
   * Records every `Set-Cookie` of a child response to `requestPath` (the
   * path the response answered, which decides a cookie's default path); a
   * deletion (`Max-Age=0`, or an `Expires` in the past) removes the cookie
   * of that name AND path, not its variants on other paths.
   */
  absorb(setCookie: string | string[] | undefined, requestPath: string, now: number = Date.now()): void {
    const entries = setCookie === undefined ? [] : Array.isArray(setCookie) ? setCookie : [setCookie]
    const defaultPath = defaultPathOf(requestPath)
    for (const entry of entries) {
      const parsed = parseSetCookie(entry, now, defaultPath)
      if (parsed === null) continue
      const key = `${parsed.path}\n${parsed.name}`
      if (parsed.expiresAt !== null && parsed.expiresAt <= now) {
        this.cookies.delete(key)
        continue
      }
      this.cookies.set(key, { name: parsed.name, value: parsed.value, path: parsed.path, expiresAt: parsed.expiresAt })
    }
  }

  /** The `Cookie` header for a request to `path`, longest cookie path first, or `undefined` when nothing applies. */
  cookieHeaderFor(path: string, now: number = Date.now()): string | undefined {
    const requestPath = path.split("?")[0] ?? "/"
    const matching: (StoredCookie & { name: string })[] = []
    for (const [key, cookie] of this.cookies) {
      if (cookie.expiresAt !== null && cookie.expiresAt <= now) {
        this.cookies.delete(key)
        continue
      }
      if (pathMatches(cookie.path, requestPath)) matching.push(cookie)
    }
    // Longer paths first (RFC 6265 5.4), insertion order among equals: a
    // parser that keeps the first of a repeated name gets the more specific one.
    matching.sort((a, b) => b.path.length - a.path.length)
    return matching.length > 0 ? matching.map((c) => `${c.name}=${c.value}`).join("; ") : undefined
  }

  /** How many cookies the jar holds. Tests and diagnostics. */
  get size(): number {
    return this.cookies.size
  }
}

/**
 * RFC 6265 5.1.4: the request path up to, but not including, its last `/`,
 * or `/` when that leaves nothing.
 */
function defaultPathOf(requestPath: string): string {
  const path = requestPath.split("?")[0] ?? "/"
  if (!path.startsWith("/")) return "/"
  const lastSlash = path.lastIndexOf("/")
  return lastSlash <= 0 ? "/" : path.slice(0, lastSlash)
}

function parseSetCookie(
  entry: string,
  now: number,
  defaultPath: string,
): { name: string; value: string; path: string; expiresAt: number | null } | null {
  const [pair, ...attributes] = entry.split(";")
  if (pair === undefined) return null
  const eq = pair.indexOf("=")
  if (eq <= 0) return null
  const name = pair.slice(0, eq).trim()
  const value = pair.slice(eq + 1).trim()
  if (name === "") return null
  let path = defaultPath
  let expiresAt: number | null = null
  let maxAgeSeen = false
  for (const attribute of attributes) {
    const [rawKey, ...rest] = attribute.split("=")
    const key = (rawKey ?? "").trim().toLowerCase()
    const raw = rest.join("=").trim()
    if (key === "path" && raw.startsWith("/")) path = raw
    else if (key === "max-age") {
      // `Max-Age` wins over `Expires` when both are present (RFC 6265).
      const seconds = Number(raw)
      if (Number.isFinite(seconds)) {
        expiresAt = now + seconds * 1000
        maxAgeSeen = true
      }
    } else if (key === "expires" && !maxAgeSeen) {
      const at = Date.parse(raw)
      if (!Number.isNaN(at)) expiresAt = at
    }
  }
  return { name, value, path, expiresAt }
}

/** RFC 6265 path matching: equal, or a prefix that ends at a `/`. */
function pathMatches(cookiePath: string, requestPath: string): boolean {
  if (cookiePath === requestPath) return true
  if (!requestPath.startsWith(cookiePath)) return false
  return cookiePath.endsWith("/") || requestPath[cookiePath.length] === "/"
}
