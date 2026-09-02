/**
 * Host-based prototype serving: `{slug}.{VIEWER_SERVE_DOMAIN}` → the
 * prototype at `/`, instead of `{publicUrl}/p/{slug}/`.
 *
 * ## Why this mode exists
 *
 * Path serving puts the prototype on the SAME ORIGIN as the shell and its
 * API. Every isolation property since Phase 3b-1 has been bought with a
 * per-response CSP — a path-scoped `connect-src`, plus `frame-src`,
 * `object-src` and `form-action` set to `'none'` — because same-origin JS
 * would otherwise read `/api/v1/**` with the reviewer's own cookie. That
 * defence works, but it is a policy in a header, and the documented
 * `VIEWER_PROTOTYPE_CSP=off` escape hatch removes it wholesale (with a PAT
 * endpoint now behind it, a hosted prototype could mint a credential that
 * survives logout).
 *
 * A separate origin removes the premise instead of defending against it:
 * the shell's session cookie is host-only (no `Domain` attribute), so it is
 * never sent to `{slug}.{serveDomain}` at all, and the browser's own
 * same-origin policy — not a header we emit — is what stops the prototype
 * reading the API.
 *
 * ## Why it is not the default
 *
 * It needs wildcard DNS and a wildcard TLS certificate. PaaS free domains
 * generally cannot do nested wildcards, which is what made path serving the
 * one true default back in Phase 1.5. This is opt-in for a deployment with
 * its own domain.
 *
 * ## Known limit: `frame-ancestors` on a subdomain document assumes `publicUrl`
 *
 * A request that arrives on a `{slug}.{serveDomain}` host cannot learn which
 * spelling of the shell the reviewer actually used — there is no shell Host to
 * read on a prototype host. So a subdomain document's `frame-ancestors` names
 * `publicUrl`, unconditionally (the main app CAN flip its own host per request;
 * a prototype host is not one of its hosts). The cost is narrow and stated
 * rather than solved here: a reviewer whose shell is on a loopback TWIN of
 * `publicUrl` (say `127.0.0.1` when `publicUrl` says `localhost`) while a serve
 * domain is configured gets a refused embed, because the prototype's
 * `frame-ancestors` names the `publicUrl` spelling and not the twin. That
 * combination — a serve domain AND a reviewer on the non-canonical loopback
 * spelling — is a dev-only edge; the fix belongs to a later spec, not here.
 */

/** A slug label as it may appear in a hostname. Matches the slug rule. */
const SLUG_LABEL = /^[a-z0-9][a-z0-9-]{1,62}$/

export interface SubdomainMatch {
  slug: string
}

/**
 * Extracts a prototype slug from a Host header, or null when the request is
 * not for a prototype subdomain.
 *
 * Deliberately strict:
 *
 * - The port is stripped before comparison (`acme.proto.test:3100`), since a
 *   dev deployment is reached on a port and the domain config never carries
 *   one. Stripping it here is a SLUG-match concern only: the Host allowlist
 *   still compares the port separately (`host-allowlist.ts`'s
 *   `isServeDomainHost`), which is why `prototypeOriginFor` carries
 *   `publicUrl`'s explicit port so the origin it emits actually passes that
 *   allowlist.
 * - Only ONE label may precede the serve domain. Allowing `a.b.{domain}`
 *   would mean a wildcard certificate for `*.{domain}` does not actually
 *   cover the host being served, and more importantly it would let
 *   `evil.acme.{domain}` read `acme.{domain}`'s cookies if any were ever set
 *   domain-wide.
 * - The bare serve domain itself is NOT a prototype host — it has no slug,
 *   and treating it as one would make a typo resolve to a random project.
 * - The label must satisfy the same slug rule storage enforces, so a
 *   malformed host can never reach a storage lookup.
 */
export function slugFromHost(host: string | undefined, serveDomain: string | null): SubdomainMatch | null {
  if (!serveDomain || !host) return null
  const bare = host.split(":")[0]?.toLowerCase() ?? ""
  const domain = serveDomain.split(":")[0]?.toLowerCase() ?? ""
  if (!bare || !domain) return null
  if (!bare.endsWith(`.${domain}`)) return null

  const label = bare.slice(0, bare.length - domain.length - 1)
  if (!label || label.includes(".")) return null
  if (!SLUG_LABEL.test(label)) return null
  return { slug: label }
}

/**
 * The CSP for a prototype served from an ORIGIN OF ITS OWN.
 *
 * Two modes reach it, and they must not fork the string: a
 * `{slug}.{serveDomain}` host, and a per-deployment loopback listener
 * (`loopback-listener-app.ts`, whose `shellOrigin` is fixed per listener
 * rather than per deployment). The function name says "isolated origin"
 * rather than "subdomain" for that reason; it still lives here because this
 * is where the policy was first written down and where its argument is
 * recorded.
 *
 * `connect-src 'self'` rather than the path-scoped form: on its own origin,
 * `'self'` IS the prototype and nothing else, so a prototype can freely call
 * its own mocked endpoints while the API — a different origin — is out of
 * reach by the browser's own rules. This is strictly stronger than the path
 * mode's policy and simpler to reason about.
 *
 * `frame-ancestors` is the one directive that must NAME the shell: when a
 * serve domain is configured, `app/prototype-origin.ts` points the review
 * page's iframe at this origin, so the embed IS cross-origin and `'self'`
 * would block the product's main surface. (Until the 2026-08-09 security
 * audit that was a forward-looking claim rather than a true one — the shell
 * hardcoded `/p/{slug}/` and never created a cross-origin review iframe, so
 * the directive was correct for a topology the product did not yet
 * produce. Finding S8; the shell now does.)
 *
 * `frame-src`/`object-src`/`form-action` stay `'none'` for the same reason
 * as in path mode — they govern nested contexts and navigations that
 * `connect-src` does not — even though the cross-origin boundary already
 * makes them far less load-bearing here.
 *
 * `worker-src 'none'` is denied for the same reason as path mode's
 * `resolvePrototypeCsp` (see its doc comment): a real origin makes service
 * workers registrable, and their scope should be denied by policy, not left
 * to fall through `child-src`/`script-src` and be bounded only by accident.
 * Subdomain mode is in fact the FIRST place this matters — the sandboxed
 * review iframe gives the prototype an opaque origin, where a worker cannot
 * register at all, but a subdomain origin is real from the start.
 */
export function resolveIsolatedOriginCsp(prototypeCsp: string | null, shellOrigin: string): string | null {
  if (prototypeCsp === "off") return null
  if (prototypeCsp !== null) return prototypeCsp
  return (
    `default-src 'self' data: blob:; ` +
    `script-src 'self' 'unsafe-inline' data: blob:; ` +
    `style-src 'self' 'unsafe-inline' https:; ` +
    `font-src 'self' data: https:; ` +
    `img-src 'self' data: blob: https:; ` +
    `connect-src 'self'; ` +
    `frame-src 'none'; ` +
    `object-src 'none'; ` +
    `worker-src 'none'; ` +
    `form-action 'none'; ` +
    `frame-ancestors ${shellOrigin}`
  )
}

/**
 * The origin a prototype is served from in subdomain mode.
 *
 * Consumed by `app/prototype-origin.ts`, which is the single place the
 * shell decides where to point a browser at a prototype — the review
 * iframe and the dashboard's "Open" link both route through it. Keeping
 * that decision in one module is what stops this function drifting back to
 * zero callers, which is the state security-audit finding S8 found it in:
 * the server-side isolation was complete and no shell surface ever asked
 * for it, so setting `VIEWER_SERVE_DOMAIN` changed nothing a reviewer
 * actually loaded.
 *
 * The origin carries `publicUrl`'s EXPLICIT port (task 4b / task 11). An
 * earlier version was port-less, which broke the `/etc/hosts` dev setup: a
 * loopback `publicUrl` on `:3100` plus a serve domain produced
 * `http://acme.proto.test` — unreachable, and refused by the Host allowlist,
 * which compares the port (`host-allowlist.ts`'s `isServeDomainHost`). The URL
 * API drops a scheme-default port, so a deployed instance on 443/80 stays
 * port-less (`https://acme.desde.test`) while a dev deployment becomes
 * `http://acme.proto.test:3100`.
 */
export function prototypeOriginFor(slug: string, serveDomain: string, publicUrl: string): string {
  const url = new URL(publicUrl)
  const scheme = url.protocol === "https:" ? "https" : "http"
  const port = url.port === "" ? "" : `:${url.port}`
  return `${scheme}://${slug}.${serveDomain}${port}`
}


/** Marks a request that arrived on a prototype subdomain. */
export interface SubdomainRequest {
  prototypeSubdomain?: string
}

/**
 * Rewrites `{slug}.{serveDomain}/foo` to the internal `/p/{slug}/foo` form
 * so ONE handler serves both modes.
 *
 * Rewriting rather than duplicating the handler is the whole point: the
 * serve path carries the visibility gate, the byte-identical 404s, the
 * bridge route and the CSP/nosniff headers, and a second copy would drift
 * from all of it. The handler branches on the marker only where the two
 * modes genuinely differ — base path, CSP, and the bridge URL.
 */
export function createSubdomainRewrite(serveDomain: string | null) {
  return function subdomainRewrite(
    req: { headers: Record<string, unknown>; url: string },
    _res: unknown,
    next: () => void,
  ): void {
    if (!serveDomain) return next()
    const host = typeof req.headers.host === "string" ? req.headers.host : undefined
    const match = slugFromHost(host, serveDomain)
    if (!match) return next()
    ;(req as unknown as SubdomainRequest).prototypeSubdomain = match.slug
    // `req.url` carries the query string; keep it intact.
    req.url = `/p/${match.slug}${req.url.startsWith("/") ? req.url : `/${req.url}`}`
    next()
  }
}
