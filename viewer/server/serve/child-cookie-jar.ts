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
 * Honours the attributes that decide whether a cookie still applies: `Path`,
 * `Max-Age` and `Expires`. Everything else (`Secure`, `HttpOnly`,
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
  private readonly cookies = new Map<string, StoredCookie>()

  /** Records every `Set-Cookie` of a child response; a deletion (`Max-Age=0`, or an `Expires` in the past) removes the cookie. */
  absorb(setCookie: string | string[] | undefined, now: number = Date.now()): void {
    const entries = setCookie === undefined ? [] : Array.isArray(setCookie) ? setCookie : [setCookie]
    for (const entry of entries) {
      const parsed = parseSetCookie(entry, now)
      if (parsed === null) continue
      if (parsed.expiresAt !== null && parsed.expiresAt <= now) {
        this.cookies.delete(parsed.name)
        continue
      }
      this.cookies.set(parsed.name, { value: parsed.value, path: parsed.path, expiresAt: parsed.expiresAt })
    }
  }

  /** The `Cookie` header for a request to `path`, or `undefined` when nothing applies. */
  cookieHeaderFor(path: string, now: number = Date.now()): string | undefined {
    const requestPath = path.split("?")[0] ?? "/"
    const pairs: string[] = []
    for (const [name, cookie] of this.cookies) {
      if (cookie.expiresAt !== null && cookie.expiresAt <= now) {
        this.cookies.delete(name)
        continue
      }
      if (pathMatches(cookie.path, requestPath)) pairs.push(`${name}=${cookie.value}`)
    }
    return pairs.length > 0 ? pairs.join("; ") : undefined
  }

  /** How many cookies the jar holds. Tests and diagnostics. */
  get size(): number {
    return this.cookies.size
  }
}

function parseSetCookie(
  entry: string,
  now: number,
): { name: string; value: string; path: string; expiresAt: number | null } | null {
  const [pair, ...attributes] = entry.split(";")
  if (pair === undefined) return null
  const eq = pair.indexOf("=")
  if (eq <= 0) return null
  const name = pair.slice(0, eq).trim()
  const value = pair.slice(eq + 1).trim()
  if (name === "") return null
  let path = "/"
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
