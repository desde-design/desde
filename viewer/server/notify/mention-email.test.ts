import { describe, expect, it, vi } from "vitest"
import {
  globalUnsubscribeUrl,
  mentionEmail,
  processIntent,
  signUnsubscribeToken,
  unsubscribeConfirmationHtml,
  verifyUnsubscribeToken,
  type MentionComment,
  type MentionRecipient,
  type SendOptions,
} from "./mention-email"

// `projectId` is UUID-shaped (as it is in production) and `projectName` is a
// distinct human name — this is what makes the subject/body assertions below
// diagnostic for the "subject shows the project UUID" bug: a regression that
// reintroduces `comment.projectId` in the render would emit the UUID instead
// of "Demo Project" and every assertion here would fail. `projectSlug` is
// deliberately distinct from both, so a regression that renders the wrong
// one of the three into the CTA link is caught too.
const comment: MentionComment = {
  id: "c-1",
  number: 3,
  body: "great work @[Bob](p-bob), ship it",
  authorName: "Ada Lovelace",
  projectId: "30151e43-3bd4-4fcb-90cb-a04bf43218da",
  projectName: "Demo Project",
  projectSlug: "demo-project",
}

describe("mentionEmail", () => {
  it("renders the body with mention syntax stripped and no id leak", () => {
    // A BARE origin, same shape as what production supplies
    // (`config.publicUrl` — see outbox-drain.ts). The pre-fix test used a
    // project-scoped `baseUrl` ("https://app.example.com/p/demo") production
    // never actually supplies, which masked the CTA link pointing at the
    // bare origin instead of `/review/<slug>` (Fix 2, phase-2b-2 review) —
    // same masking pattern as the subject bug fixed in 87fbaecb.
    const { subject, html } = mentionEmail(comment, "Bob", "https://app.example.com")
    // The author's name is deliberately NOT in the subject any more
    // (security audit B5) — see `mentionEmail`. It is still in the body.
    expect(subject).toBe("You were mentioned on Demo Project")
    expect(subject).not.toContain("Ada Lovelace")
    expect(subject).not.toContain(comment.projectId)
    expect(html).toContain("Ada Lovelace")
    expect(html).toContain("great work @Bob, ship it")
    expect(html).not.toContain("p-bob")
    expect(html).toContain("Hi Bob,")
    expect(html).toContain("comment #3")
    // The CTA must deep-link to the review surface for this project, not
    // just the bare origin — a recipient clicking through has to land on
    // their comment, not the project-list home page.
    expect(html).toContain("https://app.example.com/review/demo-project?commentId=c-1")
  })

  it("renders the project NAME in the subject and body, never the raw project id (UUID in production)", () => {
    const { subject, html } = mentionEmail(comment)
    expect(subject).toBe("You were mentioned on Demo Project")
    expect(subject).not.toContain(comment.projectId)
    expect(html).toContain("Demo Project")
    expect(html).not.toContain(comment.projectId)
  })

  /**
   * Security audit B5. The subject used to be
   * `` `${authorName} mentioned you on ${projectName}` ``, and on a
   * public-link project `authorName` is a self-declared string an ANONYMOUS
   * caller chose — so the operator's own SPF/DKIM-passing mail carried
   * subjects like "Workday Security Alert mentioned you on Acme". The
   * subject is the most trusted line in an email; nothing unverified goes
   * in it.
   */
  it("never puts the self-declared author name in the subject", () => {
    const spoof: MentionComment = { ...comment, authorName: "Workday Security Alert" }
    const { subject, html } = mentionEmail(spoof)
    expect(subject).toBe("You were mentioned on Demo Project")
    expect(subject).not.toContain("Workday Security Alert")
    // Still visible in the BODY, escaped and framed as comment content.
    expect(html).toContain("Workday Security Alert")
  })

  it("strips control characters and caps the length of header fragments", () => {
    const nasty: MentionComment = {
      ...comment,
      authorName: "Evil\r\nBcc: victim@x.com",
      projectName: `Proj\r\nX ${"y".repeat(300)}`,
    }
    const { subject, html } = mentionEmail(nasty)
    expect(subject).not.toContain("\r")
    expect(subject).not.toContain("\n")
    expect(subject.length).toBeLessThanOrEqual("You were mentioned on ".length + 120)
    // The author name reaches the HTML body through the same scrubber.
    expect(html).not.toContain("Evil\r\n")
    expect(html).toContain("Evil Bcc: victim@x.com")
  })

  it("escapes HTML in author name and body (no injection)", () => {
    const evil: MentionComment = {
      ...comment,
      authorName: "<script>x</script>",
      body: "<img src=x onerror=1> @[Bob](p-bob)",
    }
    const { html } = mentionEmail(evil)
    expect(html).not.toContain("<script>x</script>")
    expect(html).not.toContain("<img src=x")
    expect(html).toContain("&lt;script&gt;")
  })

  it("omits the CTA when no baseUrl is given", () => {
    const { html } = mentionEmail(comment)
    expect(html).not.toContain("View comment")
    expect(html).toContain("Hi,")
  })

  it("uses the Desde footer, not the oss-comments original", () => {
    const { html } = mentionEmail(comment)
    expect(html).toContain("Desde")
    expect(html).not.toContain("oss-comments")
  })

  it("renders an Unsubscribe link in the footer when unsubscribeUrl is given", () => {
    const { html } = mentionEmail(comment, undefined, undefined, "https://viewer.example.com/api/v1/unsubscribe?token=abc")
    expect(html).toContain("Unsubscribe")
    expect(html).toContain("https://viewer.example.com/api/v1/unsubscribe?token=abc")
  })
})

describe("processIntent", () => {
  function deps(over: Partial<Parameters<typeof processIntent>[0]> = {}) {
    const setStatus = vi.fn(async () => {})
    const send = vi.fn(async (_to: string, _subject: string, _html: string, _opts?: SendOptions) => true)
    return {
      base: {
        intent: { id: "n-1", commentId: "c-1", recipientIds: ["p-bob", "p-cara"] },
        getComment: async () => comment,
        getRecipients: async (): Promise<MentionRecipient[]> => [
          { email: "bob@example.com", name: "Bob" },
          { email: "cara@example.com", name: "Cara" },
        ],
        send,
        setStatus,
        ...over,
      },
      send,
      setStatus,
    }
  }

  it("sends one email per recipient and marks the intent sent", async () => {
    const { base, send, setStatus } = deps()
    const r = await processIntent(base)
    expect(send).toHaveBeenCalledTimes(2)
    expect(r.sent).toBe(2)
    expect(setStatus).toHaveBeenCalledWith("n-1", "sent")
  })

  it("skips recipients with no email, not counting them as failures", async () => {
    const { base, send } = deps({
      getRecipients: async () => [
        { email: "bob@example.com", name: "Bob" },
        { email: "" }, // anonymous author — non-deliverable
      ],
    })
    const r = await processIntent(base)
    expect(send).toHaveBeenCalledTimes(1)
    expect(r.sent).toBe(1)
    expect(r.skipped).toBe(1)
  })

  it("marks the intent error when any send fails", async () => {
    const send = vi.fn(async (to: string) => to !== "cara@example.com")
    const setStatus = vi.fn(async () => {})
    const r = await processIntent({
      intent: { id: "n-1", commentId: "c-1", recipientIds: ["p-bob", "p-cara"] },
      getComment: async () => comment,
      getRecipients: async () => [
        { email: "bob@example.com" },
        { email: "cara@example.com" },
      ],
      send,
      setStatus,
    })
    expect(r.sent).toBe(1)
    expect(r.failed).toEqual(["cara@example.com"])
    expect(setStatus).toHaveBeenCalledWith("n-1", "error")
  })

  it("marks error and sends nothing when the comment is gone", async () => {
    const { base, send, setStatus } = deps({ getComment: async () => null })
    const r = await processIntent(base)
    expect(send).not.toHaveBeenCalled()
    expect(setStatus).toHaveBeenCalledWith("n-1", "error")
    expect(r.failed).toEqual(["comment-missing"])
  })

  it("excludes a recipient who previously unsubscribed — no send, counted separately from failures", async () => {
    const isUnsubscribed = vi.fn(async (r: { email: string }) => r.email === "cara@example.com")
    const { base, send, setStatus } = deps({ isUnsubscribed })
    const r = await processIntent(base)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith("bob@example.com", expect.any(String), expect.any(String), undefined)
    expect(r.sent).toBe(1)
    expect(r.unsubscribed).toBe(1)
    expect(r.failed).toEqual([])
    expect(setStatus).toHaveBeenCalledWith("n-1", "sent") // opted-out isn't a failure
  })

  it("attaches a signed unsubscribe link + List-Unsubscribe header when unsubscribe config + participantId are present", async () => {
    const { base, send } = deps({
      getRecipients: async () => [{ email: "bob@example.com", name: "Bob", participantId: "p-bob" }],
      unsubscribe: { secret: "s3cr3t", endpoint: "https://viewer.example.com/api/v1/unsubscribe" },
    })
    await processIntent(base)
    expect(send).toHaveBeenCalledTimes(1)
    const [to, , html, opts] = send.mock.calls[0]
    expect(to).toBe("bob@example.com")
    expect(html).toContain("https://viewer.example.com/api/v1/unsubscribe?token=")
    expect(opts?.listUnsubscribe).toMatch(/^https:\/\/viewer\.example\.com\/api\/v1\/unsubscribe\?token=/)
  })

  it("omits the unsubscribe link when the recipient has no participantId", async () => {
    const { base, send } = deps({
      getRecipients: async () => [{ email: "bob@example.com", name: "Bob" }],
      unsubscribe: { secret: "s3cr3t", endpoint: "https://viewer.example.com/api/v1/unsubscribe" },
    })
    await processIntent(base)
    const [, , html, opts] = send.mock.calls[0]
    expect(html).not.toContain("Unsubscribe")
    expect(opts).toBeUndefined()
  })
})

describe("signUnsubscribeToken / verifyUnsubscribeToken", () => {
  it("round-trips a signed token back to its payload", async () => {
    const token = await signUnsubscribeToken("s3cr3t", { participantId: "p-1", projectId: "proj-1" })
    const payload = await verifyUnsubscribeToken("s3cr3t", token)
    expect(payload).toEqual({ participantId: "p-1", projectId: "proj-1" })
  })

  it("returns null for a token signed with a different secret", async () => {
    const token = await signUnsubscribeToken("s3cr3t", { participantId: "p-1", projectId: "proj-1" })
    expect(await verifyUnsubscribeToken("wrong-secret", token)).toBeNull()
  })

  it("returns null for a tampered payload (signature no longer matches)", async () => {
    const token = await signUnsubscribeToken("s3cr3t", { participantId: "p-1", projectId: "proj-1" })
    const [body, sig] = token.split(".")
    const tampered = `${body}x.${sig}`
    expect(await verifyUnsubscribeToken("s3cr3t", tampered)).toBeNull()
  })

  it("returns null for a malformed token (no separator)", async () => {
    expect(await verifyUnsubscribeToken("s3cr3t", "not-a-real-token")).toBeNull()
  })

  it("returns null for garbage that happens to verify but isn't valid JSON shape", async () => {
    // A body that decodes to JSON missing the expected string fields, signed correctly.
    const enc = new TextEncoder()
    const b64url = (bytes: Uint8Array) => {
      let bin = ""
      for (const b of bytes) bin += String.fromCharCode(b)
      return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
    }
    const key = await crypto.subtle.importKey("raw", enc.encode("s3cr3t"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
    const body = b64url(enc.encode(JSON.stringify({ p: 123, j: 456 })))
    const sig = b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(body))))
    expect(await verifyUnsubscribeToken("s3cr3t", `${body}.${sig}`)).toBeNull()
  })
})

describe("unsubscribeConfirmationHtml", () => {
  it("renders the project-scoped message using the project NAME, never a raw id", () => {
    // A UUID-shaped id with a distinct human name — diagnostic for the
    // "confirmation page shows the project UUID" bug (Fix 5, phase-2b-2
    // review): a regression that renders an id instead of `projectName`
    // would fail the UUID assertion below.
    const html = unsubscribeConfirmationHtml({ projectName: "Demo Project" })
    expect(html).toContain("Unsubscribed")
    expect(html).toContain("Demo Project")
    expect(html).not.toContain("30151e43-3bd4-4fcb-90cb-a04bf43218da")
    expect(html).not.toContain("oss-comments")
  })

  // Fix 3 (phase-2b-2 review): the "global" opt-out row
  // (`{participantId, projectId: null}`) can't actually reach a different
  // project's participant row for the same human — participants are
  // per-project, so promising "all Desde emails" was false advertising.
  // This copy must never resurface that claim, regardless of what scope the
  // caller recorded.
  it("never claims a global / cross-project scope, and drops the old escalate link entirely", () => {
    const html = unsubscribeConfirmationHtml({ projectName: "Demo Project" })
    expect(html).not.toContain("all")
    expect(html).not.toContain("Desde emails")
    // Renaming the product must not retire this guard: the claim is just as
    // false under the new name.
    expect(html).not.toContain("Desde emails")
    expect(html).not.toContain("Still getting too many")
    expect(html).not.toContain("Unsubscribe from all")
  })

  it("escapes the project name (no injection via a malicious project name)", () => {
    const html = unsubscribeConfirmationHtml({ projectName: "<script>x</script>" })
    expect(html).not.toContain("<script>x</script>")
    expect(html).toContain("&lt;script&gt;")
  })
})

describe("globalUnsubscribeUrl", () => {
  it("appends token + scope=global to the endpoint", () => {
    expect(globalUnsubscribeUrl("https://viewer.example.com/api/v1/unsubscribe", "tok123")).toBe(
      "https://viewer.example.com/api/v1/unsubscribe?token=tok123&scope=global",
    )
  })

  it("uses & when the endpoint already has a query string", () => {
    expect(globalUnsubscribeUrl("https://viewer.example.com/api/v1/unsubscribe?x=1", "tok123")).toBe(
      "https://viewer.example.com/api/v1/unsubscribe?x=1&token=tok123&scope=global",
    )
  })
})
