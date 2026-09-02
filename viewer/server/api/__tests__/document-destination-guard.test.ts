import express from "express"
import request from "supertest"
import { describe, expect, it } from "vitest"
import { createDocumentDestinationGuard } from "../api-router"

/**
 * Mirrors the real mount shape (`create-app.ts` mounts the API router at
 * `/api/v1`), so `req.path` inside the guard is router-relative exactly as
 * it is in production — the exempt-route list is written against those
 * router-relative paths and would silently never match if this test mounted
 * at the root instead.
 */
/**
 * ONE app for the whole file, memoized.
 *
 * `supertest-reuse.ts` keys its listening server off the app OBJECT, so a
 * `setup()` that returned a fresh `express()` every call — and several tests
 * here call it inside a `for` loop — opened a new ephemeral-port server per
 * iteration. That churn is the documented cause of this suite's residual
 * transport-level flakiness (`socket hang up`, `Parse Error`, a plain GET
 * answering 400); see the "Why" section of `supertest-reuse.ts`.
 *
 * Memoizing is safe precisely here because this app holds NO per-test state:
 * it is the guard plus a constant handler, and every test varies only the
 * request. Do not copy this pattern into a file whose app closes over
 * per-test storage.
 */
let sharedApp: ReturnType<typeof express> | undefined
function setup() {
  return (sharedApp ??= (() => {
    // desde-allow-own-server: this IS the one-app-per-file pattern, not a
    // per-test app — the `??=` memoizes it for the whole file. It is a bare
    // `express()` rather than a swappable app because it holds no per-test
    // state, so there is nothing to swap.
    const app = express()
    app.use("/api/v1", createDocumentDestinationGuard(), (_req, res) => res.json({ ok: true }))
    return app
  })())
}

describe("createDocumentDestinationGuard", () => {
  // Security audit finding B2: a hostile prototype, served same-origin
  // under path mode, calls `window.open('/api/v1/projects')` and reads the
  // popup's document. No CSP directive governs an auxiliary browsing
  // context, so the refusal has to happen at the API.
  it("refuses a Sec-Fetch-Dest: document request to /api/v1/projects", async () => {
    const res = await request(setup())
      .get("/api/v1/projects")
      .set("Sec-Fetch-Dest", "document")
    expect(res.status).toBe(403)
    expect(res.body).toEqual({ error: "This endpoint may not be loaded as a document" })
  })

  // Without this the blocked 403 is still a same-origin document the opener
  // holds a handle to, and `w.document.write(...)` turns it into a general
  // credentialed API agent. The sandbox gives it an opaque origin instead.
  it("sandboxes the refusal so the opener cannot script the popup it just got blocked from", async () => {
    const res = await request(setup())
      .get("/api/v1/projects")
      .set("Sec-Fetch-Dest", "document")
    expect(res.headers["content-security-policy"]).toContain("sandbox")
    expect(res.headers["x-content-type-options"]).toBe("nosniff")
  })

  // Task review finding (Important): `res.setHeader` REPLACES, it does not
  // append. `create-app.ts`'s shell-wide `frame-ancestors 'none'` middleware
  // runs before this guard, but this guard's own `setHeader` call above
  // overwrites it — so a prototype self-navigating an `<iframe>` into a
  // non-exempt `/api/v1/**` route reached this exact 403 with the shell's
  // framing protection silently dropped. `DOCUMENT_DESTINATIONS` includes
  // "iframe", so that path is reachable, not hypothetical. This guard must
  // carry `frame-ancestors 'none'` itself rather than depend on a header
  // set upstream surviving its own `setHeader` call.
  it("keeps frame-ancestors 'none' on an iframe-framed refusal, alongside sandbox", async () => {
    const res = await request(setup())
      .get("/api/v1/projects")
      .set("Sec-Fetch-Dest", "iframe")
    expect(res.status).toBe(403)
    const csp = res.headers["content-security-policy"]
    expect(csp).toContain("sandbox")
    expect(csp).toContain("frame-ancestors 'none'")
  })

  it("refuses the token-minting route as a document too — the credential lane B2 ends at", async () => {
    const res = await request(setup())
      .post("/api/v1/tokens")
      .set("Sec-Fetch-Dest", "document")
    expect(res.status).toBe(403)
  })

  it("refuses nested-document destinations as well (iframe/object/embed)", async () => {
    for (const dest of ["iframe", "frame", "object", "embed"]) {
      const res = await request(setup()).get("/api/v1/projects").set("Sec-Fetch-Dest", dest)
      expect(res.status, `Sec-Fetch-Dest: ${dest}`).toBe(403)
    }
  })

  it("passes through the destinations a real API client sends", async () => {
    for (const dest of ["empty", "script"]) {
      const res = await request(setup()).get("/api/v1/projects").set("Sec-Fetch-Dest", dest)
      expect(res.status, `Sec-Fetch-Dest: ${dest}`).toBe(200)
    }
  })

  // Fail-open on absence is deliberate: curl, CI, the Editor CLI and
  // pre-16.4 Safari send no Sec-Fetch-* headers at all, and refusing them
  // would lock out every non-browser caller. Origin isolation, not this
  // guard, is the containment for a hostile prototype.
  it("passes through a request with no Sec-Fetch-Dest header", async () => {
    const res = await request(setup()).get("/api/v1/projects")
    expect(res.status).toBe(200)
  })

  // These four ARE reached as browser navigations by design — sign-in, its
  // OAuth return leg, the local-operator URL the process prints at boot, and
  // the link in a mention email's footer. Refusing them would break sign-in
  // and unsubscribe outright.
  it("exempts the routes that are genuinely top-level navigations", async () => {
    for (const path of ["/auth/github", "/auth/github/callback", "/auth/local", "/unsubscribe"]) {
      const res = await request(setup())
        .get(`/api/v1${path}`)
        .set("Sec-Fetch-Dest", "document")
      expect(res.status, path).toBe(200)
    }
  })

  it("exempts an emailed unsubscribe link with a query string and a trailing slash", async () => {
    const res = await request(setup())
      .get("/api/v1/unsubscribe/?token=abc&scope=global")
      .set("Sec-Fetch-Dest", "document")
    expect(res.status).toBe(200)
  })

  // The exempt list is exact paths, not prefixes — otherwise adding a route
  // under `/auth/github/` later would inherit the exemption unnoticed.
  it("does not extend an exemption to a path merely nested under an exempt one", async () => {
    const res = await request(setup())
      .get("/api/v1/auth/github/callback/extra")
      .set("Sec-Fetch-Dest", "document")
    expect(res.status).toBe(403)
  })

  // `/auth/invite/<token>` is the one exemption that IS a prefix — the
  // token is a URL path segment (invite links look like
  // `/auth/invite/dsi_<id>_<secret>`), so there is no fixed string for the
  // Set above. A real invite email link is clicked, which is a top-level
  // navigation exactly like `/auth/github` is.
  it("exempts an invite-acceptance link, whatever token it carries", async () => {
    const res = await request(setup())
      .get("/api/v1/auth/invite/dsi_0123456789abcdef_somesecret")
      .set("Sec-Fetch-Dest", "document")
    expect(res.status).toBe(200)
  })

  // The prefix match is bounded at the next `/` — it widens the ONE token
  // segment, not "everything under /auth/invite/".
  it("does not extend the invite-link exemption to a path nested one level deeper", async () => {
    const res = await request(setup())
      .get("/api/v1/auth/invite/dsi_0123456789abcdef_somesecret/extra")
      .set("Sec-Fetch-Dest", "document")
    expect(res.status).toBe(403)
  })

  /**
   * Important fix (code review): unlike every OTHER exempted route, mere
   * POSSESSION of an invite URL is sufficient to mint a session on a bare
   * GET — there is no second factor (GitHub's state/code, an out-of-band
   * boot secret) standing between the request and a signed-in session. A
   * same-origin hostile prototype could `<iframe src="/api/v1/auth/invite/
   * <token>">` to silently swap a visitor's session with no click and
   * nothing visible, which is exactly the auxiliary-context credential read
   * this whole guard exists to close. So the invite-link exemption is
   * narrowed to `Sec-Fetch-Dest: document` specifically — a real click is
   * ALWAYS a top-level navigation, never an embed — and every other
   * DOCUMENT_DESTINATIONS value must still be refused here.
   */
  it.each(["iframe", "frame", "object", "embed"])(
    "refuses an invite-acceptance link framed as %s — only a top-level document navigation is exempt",
    async (dest) => {
      const res = await request(setup())
        .get("/api/v1/auth/invite/dsi_0123456789abcdef_somesecret")
        .set("Sec-Fetch-Dest", dest)
      expect(res.status).toBe(403)
    },
  )

  /*
   * viewer-membership Task 14 — `/auth/signin/<token>` is the second
   * path-segment-token route, and it is the IDENTICAL hazard: possession of
   * the token alone mints a session on a bare GET. The three properties below
   * are the same three the invite link has, asserted separately so a future
   * edit that special-cases one of the two prefixes fails here.
   */
  it("exempts a sign-in link, whatever token it carries", async () => {
    const res = await request(setup())
      .get("/api/v1/auth/signin/dss_0123456789abcdef_somesecret")
      .set("Sec-Fetch-Dest", "document")
    expect(res.status).toBe(200)
  })

  it("does not extend the sign-in-link exemption to a path nested one level deeper", async () => {
    const res = await request(setup())
      .get("/api/v1/auth/signin/dss_0123456789abcdef_somesecret/extra")
      .set("Sec-Fetch-Dest", "document")
    expect(res.status).toBe(403)
  })

  it.each(["iframe", "frame", "object", "embed"])(
    "refuses a sign-in link framed as %s — only a top-level document navigation is exempt",
    async (dest) => {
      const res = await request(setup())
        .get("/api/v1/auth/signin/dss_0123456789abcdef_somesecret")
        .set("Sec-Fetch-Dest", dest)
      expect(res.status).toBe(403)
    },
  )

  /*
   * Fix wave 6 — the GET/POST split. The GET renders a confirmation page and
   * its form POSTs back to the same path to redeem, and a form submission is
   * itself a top-level navigation carrying `Sec-Fetch-Dest: document`. So the
   * exemption has to cover the POST as well, and refuse it under every nested
   * destination exactly as it refuses the GET — a framed page can submit a
   * form as easily as it can set a `src`.
   */
  it.each(["/auth/invite/dsi_0123456789abcdef_somesecret", "/auth/signin/dss_0123456789abcdef_somesecret"])(
    "exempts the redeeming POST to %s as a top-level navigation",
    async (path) => {
      const res = await request(setup()).post(`/api/v1${path}`).set("Sec-Fetch-Dest", "document")
      expect(res.status).toBe(200)
    },
  )

  it.each(["iframe", "frame", "object", "embed"])(
    "refuses the redeeming POST framed as %s",
    async (dest) => {
      for (const path of [
        "/auth/invite/dsi_0123456789abcdef_somesecret",
        "/auth/signin/dss_0123456789abcdef_somesecret",
      ]) {
        const res = await request(setup()).post(`/api/v1${path}`).set("Sec-Fetch-Dest", dest)
        expect(res.status, `${dest} ${path}`).toBe(403)
      }
    },
  )

  // The magic-link REQUEST route is not exempt at all: nothing navigates to
  // it, page JS `fetch`es it, and a document POST to it is never legitimate.
  it("does not exempt the magic-link request route", async () => {
    const res = await request(setup())
      .post("/api/v1/auth/magic-link")
      .set("Sec-Fetch-Dest", "document")
    expect(res.status).toBe(403)
  })
})
