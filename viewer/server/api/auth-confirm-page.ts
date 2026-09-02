/**
 * The interstitial a one-time sign-in link opens — invite (`dsi_`) and
 * sign-in link (`dss_`) alike.
 *
 * ## Why a link no longer redeems itself on the GET
 *
 * `GET /auth/invite/<token>` used to claim the token and mint a session on
 * the spot. That makes the link a credential any GET can spend, and a GET is
 * exactly what a link gets from things that were never the recipient: Slack
 * and iMessage unfurl pasted URLs, Outlook/Gmail security scanners fetch
 * every link in a message before delivery, and corporate mail gateways
 * rewrite-and-prefetch as a matter of policy. Each of those burns a
 * single-use token, and the person then clicks a link that is already dead —
 * with no way to tell that from an expired or revoked one, because every
 * failure deliberately collapses to the same `/denied` redirect.
 *
 * So the GET is now inert: it renders this page and touches no storage. The
 * REDEMPTION is the `POST` the page's one button performs, which no scanner
 * or unfurler issues.
 *
 * ## What the page may and may not say
 *
 * The GET verifies the token's FORMAT only (`parseOneTimeToken`), never its
 * existence. A page that differed for a live token and a random well-formed
 * one would be exactly the oracle the redemption route's uniform `/denied`
 * redirect exists to close — an anonymous caller could sort real links from
 * dead ones without spending either. So the body is a constant apart from the
 * form's `action`, which has to carry the token because that is where the
 * POST goes.
 *
 * A token that is not even well-formed gets the not-valid page below. That is
 * not a leak: the format check is a pure function of the string the caller
 * already holds, so it tells them nothing they did not know before they sent
 * it.
 *
 * ## No script, no auto-submit
 *
 * The button is a plain `<form method="post">` submit. An auto-submitting page
 * would put the redemption back on the navigation and undo the whole point; a
 * JS-driven button would break for anyone whose mail client opens links in a
 * stripped-down browser view. All three pages are inert HTML.
 *
 * ## Why the design system is copied here rather than imported
 *
 * These pages are served by Express, not Next, so there is no Tailwind build
 * behind them and no theme token to reach for. Everything below is therefore
 * a hand-written copy of what the real sign-in page renders — same layout
 * (illustration, wordmark, card), same colours, same type ramp, same button.
 * `viewer/app/signin/page.tsx` is the original; keep the two in step by eye.
 *
 * Two assets cannot be copied, only served, so they come from their own
 * routes (`auth-page-assets.ts`): the portal illustration and the Chillax
 * face the wordmark is set in. Either one failing to load degrades to a page
 * that still reads correctly.
 */

import { CATS_SVG_URL, PORTAL_SVG_URL, WORDMARK_FONT_URL } from "./auth-page-assets"

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

/**
 * The theme's light palette, as literals.
 *
 * Every value is the resolved sRGB of the token of the same name under
 * `[data-theme="teal"]` in `src/styles/globals.css` — the theme the shipped
 * app hard-codes. Each is declared twice at the point of use: hex first for
 * anything predating `oklch()`, then the oklch the token actually carries.
 * Dark mode is deliberately absent (it is not designed yet), so these pages
 * are light in both schemes, exactly like the app.
 */
const PALETTE = {
  background: ["#fbfaf7", "oklch(0.986 0.004 92)"],
  foreground: ["#0c0a09", "oklch(0.147 0.004 49.25)"],
  card: ["#fefefb", "oklch(0.996 0.003 92)"],
  mutedForeground: ["#79716b", "oklch(0.553 0.013 58.071)"],
  primary: ["#00918a", "oklch(0.575 0.135 190)"],
  primaryForeground: ["#f7fdfd", "oklch(0.99 0.006 190)"],
} as const

/** `color: <hex>; color: <oklch>;` — the fallback pair, as a declaration. */
function tone(property: string, token: keyof typeof PALETTE): string {
  const [hex, oklch] = PALETTE[token]
  return `${property}:${hex};${property}:${oklch};`
}

/**
 * The page stylesheet. Sizes come from the product's named type ramp, which
 * is anchored on 13px: `text-sm` is 12, `text-base` 13, `text-lg` 15,
 * `text-2xl` 19. The body weight of 300 and the card's `ring-1
 * ring-foreground/10` are both copied from the app rather than invented.
 */
const STYLES = `
@font-face{font-family:"Chillax";src:url("${WORDMARK_FONT_URL}") format("woff2");font-weight:200 700;font-style:normal;font-display:swap;}
*{box-sizing:border-box;}
body{margin:0;${tone("background", "background")}${tone("color", "foreground")}font-family:"DM Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-weight:300;-webkit-font-smoothing:antialiased;}
main{min-height:100vh;min-height:100dvh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:24px;padding:32px 32px 96px;text-align:center;}
.illustration{width:160px;height:160px;flex-shrink:0;}
.wordmark{font-family:"Chillax","DM Sans",sans-serif;font-size:19px;font-weight:500;letter-spacing:-0.025em;${tone("color", "primary")}}
.copy{display:flex;flex-direction:column;align-items:center;gap:8px;max-width:384px;}
h1{margin:0;font-size:15px;font-weight:400;line-height:1.4;}
p{margin:0;font-size:13px;line-height:1.5;${tone("color", "mutedForeground")}}
form{margin:8px 0 0;}
button{display:inline-flex;align-items:center;justify-content:center;height:28px;padding:0 12px;border:1px solid transparent;border-radius:6px;font:inherit;font-size:12px;font-weight:400;${tone("background", "primary")}${tone("color", "primaryForeground")}cursor:pointer;transition:opacity .15s;}
button:hover{opacity:.8;}
button:active{transform:translateY(1px);}
`

/**
 * The shell all three pages share: illustration, wordmark, then centred copy
 * with no card (Mo, 2026-09-01).
 *
 * These pages carry one statement each, so a card would be a box drawn round
 * the only thing on screen. The real sign-in page keeps its card because it
 * holds a form with several methods in it; these do not. That is the whole
 * difference, and it is why the two surfaces stopped matching here on purpose.
 *
 * `noindex` because these URLs carry a credential in their path and must
 * never reach a search index; the route sends `Cache-Control: no-store`
 * alongside for the same reason.
 *
 * DM Sans comes from Google Fonts by `<link>`, which is exactly how the app
 * itself loads it (`viewer/app/layout.tsx` explains why `next/font` was
 * turned down). An instance with no outbound network falls through to the
 * system sans, same as the app.
 */
function pageShell(title: string, illustrationUrl: string, bodyHtml: string): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,300..500&display=swap" rel="stylesheet">
<style>${STYLES}</style></head>
<body><main>
<img class="illustration" src="${illustrationUrl}" alt="">
<span class="wordmark">Desde</span>
<div class="copy">
${bodyHtml}
</div>
</main></body></html>`
}

/**
 * The confirmation page. `actionPath` is where the button posts — the SAME
 * path the browser is already on, so the token stays in the URL and nothing
 * else has to carry it.
 */
export function signInConfirmPageHtml(actionPath: string): string {
  const action = escapeHtml(actionPath)
  return pageShell(
    "Continue signing in",
    // The portal, not the cats: this is not an error. The reader is at the
    // door and about to go through it.
    PORTAL_SVG_URL,
    // The title no longer names the product: the wordmark is directly above
    // it, and copy is not where the reader learns what they are looking at.
    `  <h1>Continue signing in</h1>
  <p>This link signs you in when you press the button.</p>
  <form method="post" action="${action}">
    <button type="submit">Sign in</button>
  </form>`,
  )
}

/**
 * What a token that is not even well-formed gets. Says nothing about whether
 * any particular link exists — see this file's doc comment.
 */
export function linkNotValidPageHtml(): string {
  return pageShell(
    "Link not valid",
    CATS_SVG_URL,
    `  <h1>This link isn't valid</h1>
  <p>Ask whoever sent it for a new one.</p>`,
  )
}

/**
 * Fix wave 7, item 4. What the confirmation page's own form submit lands on
 * when `requireDocumentNavigation` (auth-routes.ts) refuses it — chiefly a
 * browser old enough to send no Fetch Metadata headers at all (Safari before
 * 16.4), where a bare JSON 403 would render as unreadable text with no
 * indication anything can be done about it.
 *
 * No form: unlike `linkNotValidPageHtml`, this is not a dead end because the
 * TOKEN was bad — it never got read. There is nothing to retry from this
 * page itself, only from a different browser, so the copy says that plainly
 * and echoes no token back.
 */
export function navigationRequiredPageHtml(): string {
  // "Headers" was our dialect, not the reader's, and "finish signing in" said
  // itself twice. The cause in their terms is the browser, and the action is
  // to open the same link somewhere else.
  return pageShell(
    "Can't finish signing in",
    CATS_SVG_URL,
    `  <h1>Can't finish signing in</h1>
  <p>This browser didn't send the information needed to sign you in safely. Open the link in an up-to-date browser and try again.</p>`,
  )
}
