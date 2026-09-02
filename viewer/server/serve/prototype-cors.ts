import type { Response } from "express"

/**
 * Sets `Access-Control-Allow-Origin: *` on a response that serves a
 * prototype file — HTML, the bridge bundle, a static asset, or the
 * root-asset-fallback redirect that points at one of those.
 *
 * ## PATH MODE ONLY. Never on an isolated origin.
 *
 * Why it exists: the review shell renders a PATH-MODE prototype inside a
 * sandboxed iframe (`sandbox="allow-scripts allow-forms"`, no
 * `allow-same-origin`), which gives the prototype document an OPAQUE origin.
 * A Vite build's entry script is `<script type="module" crossorigin
 * src="./assets/index-*.js">`, and a module fetch from an opaque origin is a
 * CORS request sent with `Origin: null`. With no `Access-Control-Allow-Origin`
 * header, the browser blocks the module and the prototype renders blank —
 * silently, because the classic-script bridge tag (no-cors) still loads, so
 * nothing else on the page errors visibly.
 *
 * That whole condition is the opaque origin. In an isolated mode — a
 * `{slug}.{serveDomain}` host, or a per-deployment loopback listener — the
 * document has its REAL origin, and that origin is the one its assets are
 * served from, so every subresource fetch is same-origin and CORS never runs.
 * `serve-router.ts` therefore calls this only when `!servesAtRoot`.
 *
 * ## Why "useless there" is not the reason it is withheld
 *
 * On a PINNED loopback listener it would be a hole, not merely dead weight.
 * The safety argument below is that an ACAO'd response was already being
 * served byte-for-byte to that reader. That holds wherever `canReadProject`
 * runs per request: a cookie-less cross-origin read of a private prototype
 * gets the byte-identical 404 whether or not this header is present. A pinned
 * request skips that gate entirely — reaching the socket is its whole
 * credential — so `*` there would let ANY page the reviewer visits `fetch`
 * a private prototype's bytes once it guesses the ephemeral port. Subdomain
 * mode does still have the gate, but it has no use for the header either, so
 * both isolated modes are withheld together rather than splitting the rule.
 *
 * ## Why `*` is safe in path mode
 *
 *  - Browsers never expose a CREDENTIALED (cookie-carrying) response under
 *    `Access-Control-Allow-Origin: *` — `*` and credentials are mutually
 *    exclusive by the fetch spec, so this cannot widen what a cookie
 *    authorizes.
 *  - The opaque-origin readers this unlocks are exactly the sandboxed review
 *    iframe's own subrequests: they carry no cookie, and they are already
 *    authorized by what they hold — a public-link/effectively-public slug,
 *    or a capability URL prefix (`prototype-capability.ts`). `*` reveals
 *    nothing those requests were not already being served byte-for-byte.
 *  - The 404 paths (including the byte-identical private-project 404) are
 *    deliberately left untouched — see the call sites. An ACAO header on a
 *    404 would still reveal nothing, but the change stays minimal: this
 *    helper is only called where an asset/HTML body (or a redirect to one)
 *    is actually served.
 */
export function allowPrototypeCors(res: Response): void {
  res.setHeader("Access-Control-Allow-Origin", "*")
}
