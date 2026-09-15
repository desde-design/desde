import { describe, expect, it } from "vitest"
import { inviteEmail, signInEmail } from "./auth-email"
import { WORDMARK_PNG_PATH } from "../auth/auth-constants"
import type { InstanceRole } from "../storage/types"

/** Counts how many times `needle` occurs in `haystack` (non-overlapping). */
function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

describe("inviteEmail", () => {
  it("uses the exact binding subject line", () => {
    const { subject } = inviteEmail({ inviteUrl: "https://viewer.example.com/invite?token=abc123", role: "viewer" })
    expect(subject).toBe("You're invited to a Desde viewer")
  })

  it("entity-escapes a <script> tag smuggled in the URL", () => {
    const { html } = inviteEmail({
      inviteUrl: "https://viewer.example.com/invite?token=<script>alert(1)</script>",
      role: "editor",
    })
    expect(html).not.toContain("<script>alert(1)</script>")
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;")
  })

  it("contains the invite URL exactly once", () => {
    const inviteUrl = "https://viewer.example.com/invite?token=SECRETXYZ789"
    const { html } = inviteEmail({ inviteUrl, role: "admin" })
    const escapedUrl = "https://viewer.example.com/invite?token=SECRETXYZ789"
    expect(countOccurrences(html, escapedUrl)).toBe(1)
  })

  it("does not leak the raw token substring anywhere outside the URL", () => {
    const { html } = inviteEmail({
      inviteUrl: "https://viewer.example.com/invite?token=SECRETXYZ789",
      role: "viewer",
    })
    // The token substring must appear exactly once total (inside the one
    // rendered URL) — never duplicated into visible text alongside it.
    expect(countOccurrences(html, "SECRETXYZ789")).toBe(1)
  })

  it("explains the link signs them in and expires in 7 days", () => {
    const { html } = inviteEmail({ inviteUrl: "https://viewer.example.com/invite?token=abc123", role: "viewer" })
    expect(html.toLowerCase()).toContain("signs you in")
    expect(html).toContain("expires in 7 days")
  })

  it.each<[InstanceRole, string]>([
    ["viewer", "a viewer"],
    ["editor", "an editor"],
    ["admin", "an admin"],
  ])("renders the %s role as the plain word %j", (role, phrase) => {
    const { html } = inviteEmail({ inviteUrl: "https://viewer.example.com/invite?token=abc123", role })
    expect(html).toContain(phrase)
  })

  it("does not put the invite URL (a user-supplied-shaped value) in the subject", () => {
    const { subject } = inviteEmail({
      inviteUrl: "https://viewer.example.com/invite?token=<script>alert(1)</script>",
      role: "viewer",
    })
    expect(subject).toBe("You're invited to a Desde viewer")
    expect(subject).not.toContain("<script>")
    expect(subject).not.toContain("token=")
  })
})

describe("signInEmail", () => {
  it("uses the exact binding subject line", () => {
    const { subject } = signInEmail({ signInUrl: "https://viewer.example.com/signin?token=abc123" })
    expect(subject).toBe("Your sign-in link")
  })

  it("entity-escapes a <script> tag smuggled in the URL", () => {
    const { html } = signInEmail({ signInUrl: "https://viewer.example.com/signin?token=<script>alert(1)</script>" })
    expect(html).not.toContain("<script>alert(1)</script>")
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;")
  })

  it("contains the sign-in URL exactly once", () => {
    const signInUrl = "https://viewer.example.com/signin?token=SECRETXYZ789"
    const { html } = signInEmail({ signInUrl })
    expect(countOccurrences(html, signInUrl)).toBe(1)
  })

  it("does not leak the raw token substring anywhere outside the URL", () => {
    const { html } = signInEmail({ signInUrl: "https://viewer.example.com/signin?token=SECRETXYZ789" })
    expect(countOccurrences(html, "SECRETXYZ789")).toBe(1)
  })

  it("mentions the 15-minute expiry and the ignore-it fallback verbatim", () => {
    const { html } = signInEmail({ signInUrl: "https://viewer.example.com/signin?token=abc123" })
    expect(html).toContain("expires in 15 minutes")
    expect(html.toLowerCase()).toContain("if you didn't request this, ignore it")
  })

  it("does not put the sign-in URL in the subject", () => {
    const { subject } = signInEmail({ signInUrl: "https://viewer.example.com/signin?token=<script>alert(1)</script>" })
    expect(subject).toBe("Your sign-in link")
    expect(subject).not.toContain("<script>")
    expect(subject).not.toContain("token=")
  })
})

/**
 * Styling, as asked for on 2026-09-15: aqua button, the real mark in the
 * footer, one block of body copy rather than a sentence on each side of the
 * button.
 *
 * Both templates get the same table, so each case runs against both rather
 * than being written twice and drifting.
 */
describe.each([
  ["inviteEmail", () => inviteEmail({ inviteUrl: "https://viewer.example.com/api/v1/auth/invite/dsi_x", role: "viewer" }).html],
  ["signInEmail", () => signInEmail({ signInUrl: "https://viewer.example.com/api/v1/auth/signin/dss_x" }).html],
])("%s styling", (_name, render) => {
  it("uses the brand aqua for the button, not the old pink", () => {
    const html = render()
    expect(html).toContain("background:#00918a")
    expect(html.toLowerCase()).not.toContain("e84f9c")
  })

  it("shows the wordmark PNG in the footer, at the same origin as the link", () => {
    expect(render()).toContain(`src="https://viewer.example.com${WORDMARK_PNG_PATH}"`)
  })

  it("sizes the mark with attributes as well as CSS, for Outlook", () => {
    // Outlook's Word renderer ignores the style block on an image. Without
    // the attributes it draws the file at its full 122x32.
    const html = render()
    expect(html).toContain('width="61" height="16"')
  })

  it("says everything in ONE paragraph, above the button", () => {
    const html = render()
    const body = html.slice(html.indexOf("<td style=\"padding:24px;\""), html.indexOf("border-top"))
    expect(body.split("<p").length - 1).toBe(2) // the copy, then the button's wrapper
    expect(body.indexOf("</p>")).toBeLessThan(body.indexOf("<a href="))
  })
})

describe("footer mark fallback", () => {
  it("degrades to the plain word when the link has no parsable origin", () => {
    // The templates never see this in practice — both callers build an
    // absolute URL — but a footer is not worth throwing over.
    const { html } = signInEmail({ signInUrl: "not-a-url" })
    expect(html).not.toContain("<img")
    expect(html).toContain(">Desde<")
  })
})
