import { describe, expect, it } from "vitest"
import {
  linkNotValidPageHtml,
  navigationRequiredPageHtml,
  signInConfirmPageHtml,
} from "./auth-confirm-page"

/**
 * The pure half of the GET/POST split (fix wave 6). The route tests in
 * `__tests__/instance-routes.test.ts` and `__tests__/magic-link-routes.test.ts`
 * cover the behaviour through a real request; this file covers the two
 * properties of the markup itself that a request-level assertion would only
 * reach obliquely.
 */
describe("signInConfirmPageHtml", () => {
  const PATH = "/api/v1/auth/invite/dsi_0123456789abcdef_secret"

  it("posts back to the path it is given", () => {
    expect(signInConfirmPageHtml(PATH)).toContain(`<form method="post" action="${PATH}">`)
  })

  /**
   * No `<script>`, and no `onsubmit`/`onload` to auto-submit from. An
   * auto-submitting page would put the redemption back on the navigation and
   * undo the whole point of the split, and a JS-driven button would break in
   * the stripped-down browser views some mail clients open links in.
   */
  it("carries no script and nothing that could submit itself", () => {
    const html = signInConfirmPageHtml(PATH)
    expect(html).not.toContain("<script")
    expect(html).not.toMatch(/\son[a-z]+=/i)
  })

  it("tells robots to stay away — the URL in it is a credential", () => {
    expect(signInConfirmPageHtml(PATH)).toContain(`<meta name="robots" content="noindex">`)
  })

  /**
   * The action is HTML-escaped even though `parseOneTimeToken` has already
   * matched the whole token against a strict charset upstream. Belt and
   * braces: the escaping is what makes this function safe to call with any
   * string, so a future caller cannot turn it into an injection point by
   * loosening the check on the other side of the file boundary.
   */
  it("escapes the action so a hostile path cannot break out of the attribute", () => {
    const html = signInConfirmPageHtml(`/x"><script>alert(1)</script>`)
    expect(html).not.toContain("<script>alert(1)</script>")
    expect(html).toContain("&quot;&gt;&lt;script&gt;")
  })
})

describe("linkNotValidPageHtml", () => {
  it("offers no form — there is nothing a malformed token could redeem", () => {
    const html = linkNotValidPageHtml()
    expect(html).not.toContain("<form")
    expect(html).toContain("This link isn't valid")
  })
})

/**
 * Fix wave 7, item 4. What a redemption POST refused by
 * `requireDocumentNavigation` (auth-routes.ts) renders for a browser that
 * never sent Fetch Metadata headers at all — pre-16.4 Safari chief among
 * them — instead of a bare JSON 403 nobody there ever sees.
 */
describe("navigationRequiredPageHtml", () => {
  it("offers no form — there is nothing left to redeem from an error page", () => {
    const html = navigationRequiredPageHtml()
    expect(html).not.toContain("<form")
  })

  it("says plainly why sign-in didn't finish, with no token echoed back", () => {
    const html = navigationRequiredPageHtml()
    // "Headers" was our word, not the reader's, and the old sentence said
    // "finish signing in" twice — once in the title above it.
    expect(html).toContain(
      "This browser didn't send the information needed to sign you in safely. Open the link in an up-to-date browser and try again.",
    )
  })
})
